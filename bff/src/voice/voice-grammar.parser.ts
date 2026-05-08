import { existsSync, readdirSync } from "node:fs";

import type { VoiceNoiseMarker } from "./dto/voice-utterance.dto";

/**
 * Voice grammar parser — implements the spec at
 * `protocols/voice-grammar.md`. Replaces the naive first-word matcher in
 * `voice.service.ts` with a real `<verb> <object> [modifier...]` parser.
 *
 * Hard walls baked in:
 *   - Closed verb whitelist; unknown verbs return `intent=unknown` (never crash).
 *   - Destructive verbs always set `requires_confirmation=true` and force
 *     `readback_tier=full` regardless of other heuristics.
 *   - Ambiguous persona match (>1 candidate) escalates readback to `full`.
 *   - Parser is pure: no side effects, no async, no I/O on the hot path
 *     except a single directory listing for personas (cached on first call).
 */

// ─── verb whitelist ──────────────────────────────────────────────────────

/**
 * Closed verb whitelist. Anything outside this list is rejected with
 * `intent: 'unknown'` + `error` set. We chose a closed list (vs. NLP-based
 * open verb set) because:
 *   1. Recognition accuracy collapses fast under fatigue — predictable
 *      tokens give the user a fighting chance with off-the-shelf STT.
 *   2. A typo or hallucinated verb that auto-routed to dispatch could send
 *      a real LinkedIn DM. Closed list = blast-radius-bounded.
 *   3. Phase 2 (whisper fine-tune + multilingual) can extend this list
 *      without rewriting the parser.
 */
export const VERB_WHITELIST = [
  "dispatch",
  "read",
  "find",
  "list",
  "draft",
  "archive",
  "deploy",
  "pause",
  "resume",
  "status",
  "summarize",
  "delete",
  "send",
  "pay",
  "cancel",
  "ack",
  "repeat",
] as const;

export type VoiceVerb = (typeof VERB_WHITELIST)[number];

/**
 * Destructive verbs — irreversible or outbound. Per voice-grammar.md
 * "Heavy tier", these always require confirmation and force `readback=full`.
 * The parser never auto-fires these; the controller's downstream flow waits
 * for a subsequent `pop` (confirm) noise marker.
 */
export const DESTRUCTIVE_VERBS = new Set<VoiceVerb>([
  "delete",
  "send",
  "deploy",
  "pay",
  "cancel",
]);

/**
 * Low-stakes verbs — chime + silent (`ack` tier). Per voice-grammar.md
 * "Light tier". Status / repeat / ack don't need TTS read-back.
 */
const ACK_TIER_VERBS = new Set<VoiceVerb>(["status", "repeat", "ack"]);

// ─── intents ─────────────────────────────────────────────────────────────

export type VoiceIntent =
  | "dispatch"
  | "query"
  | "destructive"
  | "control"
  | "unknown";

/** Map a whitelisted verb to its high-level intent. */
function verbToIntent(verb: VoiceVerb): VoiceIntent {
  if (DESTRUCTIVE_VERBS.has(verb)) return "destructive";
  if (verb === "dispatch" || verb === "draft") return "dispatch";
  if (verb === "ack" || verb === "repeat") return "control";
  // read, find, list, archive, pause, resume, status, summarize → query-like
  return "query";
}

// ─── readback tiers ──────────────────────────────────────────────────────

export type ReadbackTier = "full" | "short" | "ack";

// ─── noise markers ───────────────────────────────────────────────────────

/**
 * Noise marker classification per voice-grammar.md "Mistake recovery".
 *   - pop  = confirm last action
 *   - hiss = cancel/abort
 *   - click = repeat last readback
 *   - shh  = pause / sleep mode
 *   - none = normal command
 */
export type NoiseAction = "confirm" | "cancel" | "repeat" | "sleep" | "none";

export function classifyNoise(marker?: VoiceNoiseMarker): NoiseAction {
  switch (marker) {
    case "pop":
      return "confirm";
    case "hiss":
      return "cancel";
    case "click":
      return "repeat";
    case "shh":
      return "sleep";
    default:
      return "none";
  }
}

// ─── tokenization ────────────────────────────────────────────────────────

/**
 * Tokenize an utterance: lowercase + collapse whitespace + strip
 * punctuation. We do NOT stem/lemmatize — verb match is exact.
 */
export function tokenize(utterance: string): string[] {
  return utterance
    .toLowerCase()
    // Strip every non-word/non-space char (apostrophes too — "don't" → "dont").
    .replace(/[^\w\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

// ─── persona registry ────────────────────────────────────────────────────

/**
 * Cache the persona slug list — `personas/` has ~1900 directories, so we
 * read it once and reuse. Ttl-less: a process restart picks up new personas.
 * If the dir is missing (CI / ephemeral env), we degrade to an empty list
 * and the parser stores raw object strings instead of slugs.
 */
let personaCache: { dir: string; slugs: string[] } | null = null;

function loadPersonaSlugs(personasDir: string): string[] {
  if (personaCache && personaCache.dir === personasDir) {
    return personaCache.slugs;
  }
  let slugs: string[] = [];
  try {
    if (existsSync(personasDir)) {
      slugs = readdirSync(personasDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
        .map((d) => d.name);
    }
  } catch {
    // Fail-quiet — the parser should still work without persona resolution.
    slugs = [];
  }
  personaCache = { dir: personasDir, slugs };
  return slugs;
}

/** Test hook — allow specs to reset the cache between cases. */
export function __resetPersonaCacheForTest(): void {
  personaCache = null;
}

/**
 * Common scope/role suffixes/segments we expect in slug paths. These don't
 * cost score when they appear in a slug but aren't in the utterance —
 * they're structural ("specialist", "lead") not topical ("linkedin").
 */
const STRUCTURAL_SEGMENTS = new Set([
  "specialist",
  "lead",
  "senior",
  "manager",
  "c",
  "level",
  "ops",
  "persona",
]);

/**
 * Score a persona slug against an object-token + remaining-modifier set.
 *
 * Heuristic:
 *   1. The object must appear in the slug (substring) — required gate.
 *   2. Slug starting with the object earns a 2-point bonus.
 *   3. Each modifier word ≥3 chars present in the slug adds 1 point.
 *   4. Each NON-structural slug segment that doesn't appear in the
 *      utterance subtracts 0.5 — penalises over-specific slugs (e.g.
 *      `dewx-unipile-linkedin-specialist` losing to
 *      `dewx-unipile-specialist` when "linkedin" isn't said).
 *
 * Returns 0 if the slug doesn't satisfy gate (1).
 */
function scoreSlug(slug: string, object: string, modifiers: string[]): number {
  if (!object) return 0;
  // Object must be a substring of the slug — strict gate to keep matches honest.
  if (!slug.includes(object)) return 0;
  let score = 1;
  // Bonus: slug literally starts with the object (e.g. "mira-..." for "mira").
  if (slug.startsWith(object)) score += 2;
  // Bonus per modifier hit.
  const utteranceWords = new Set([object, ...modifiers]);
  for (const m of modifiers) {
    if (m.length >= 3 && slug.includes(m)) score += 1;
  }
  // Penalty per slug segment that isn't structural and isn't in the utterance.
  // This pushes generic specialist slugs ahead of over-specific siblings.
  for (const seg of slug.split("-")) {
    if (seg === object) continue;
    if (STRUCTURAL_SEGMENTS.has(seg)) continue;
    if (utteranceWords.has(seg)) continue;
    if (modifiers.some((m) => m.length >= 3 && seg.includes(m))) continue;
    score -= 0.5;
  }
  return score;
}

/**
 * Match an object + modifiers against the persona registry.
 * Returns the best match plus how many candidates tied for top score, so
 * the caller can escalate readback when ambiguous (>1 candidate).
 *
 * Tie-break: when multiple slugs score equally, prefer the one with the
 * fewest path segments (shortest hyphen-split). The brain's naming pattern
 * is `<scope>-<topic>-specialist` — the canonical specialist for a topic
 * has the fewest segments. Example: scoring "unipile" against
 *   dewx-unipile-specialist             (3 segments)
 *   dewx-unipile-linkedin-specialist    (4 segments)
 * both score 1, but the 3-segment slug is the canonical match. We still
 * report ambiguous=true when no modifier disambiguates so Roki picks via
 * the numbered-choice flow.
 */
export function matchPersona(
  object: string,
  modifiers: string[],
  personasDir: string,
): { slug: string | null; ambiguous: boolean; candidateCount: number } {
  const slugs = loadPersonaSlugs(personasDir);
  if (slugs.length === 0 || !object) {
    return { slug: null, ambiguous: false, candidateCount: 0 };
  }
  let best: string | null = null;
  let bestScore = 0;
  let bestSegments = Infinity;
  let topTies = 0;
  for (const slug of slugs) {
    const score = scoreSlug(slug, object, modifiers);
    if (score <= 0) continue;
    const segments = slug.split("-").length;
    if (score > bestScore) {
      bestScore = score;
      best = slug;
      bestSegments = segments;
      topTies = 1;
    } else if (score === bestScore) {
      topTies += 1;
      // Prefer the shorter slug as the canonical pick for ambiguity reporting,
      // but still flag ambiguous=true so the caller can escalate readback.
      if (segments < bestSegments) {
        best = slug;
        bestSegments = segments;
      }
    }
  }
  return {
    slug: best,
    ambiguous: topTies > 1,
    candidateCount: best ? topTies : 0,
  };
}

// ─── core parser ─────────────────────────────────────────────────────────

export interface ParsedGrammar {
  verb: string | null;
  object: string | null;
  modifiers: string[];
  intent: VoiceIntent;
}

export interface ParseResult {
  parsed: ParsedGrammar;
  routed_to_persona: string | null;
  readback_tier: ReadbackTier;
  requires_confirmation: boolean;
  noise_action: NoiseAction;
  error?: string;
}

export interface ParseOptions {
  personasDir: string;
  noiseMarker?: VoiceNoiseMarker;
}

/**
 * Parse an already-trimmed, ≤14-word utterance.
 *
 * Word-count enforcement is the controller's job (per existing service);
 * this parser assumes the input has already passed the kernel cap.
 */
export function parseUtterance(
  utterance: string,
  opts: ParseOptions,
): ParseResult {
  const noise_action = classifyNoise(opts.noiseMarker);
  const tokens = tokenize(utterance);

  // Edge case: empty utterance after tokenization (only punctuation).
  if (tokens.length === 0) {
    return {
      parsed: { verb: null, object: null, modifiers: [], intent: "unknown" },
      routed_to_persona: null,
      readback_tier: "full",
      requires_confirmation: false,
      noise_action,
      error: "empty utterance after tokenization",
    };
  }

  const [verbRaw, ...rest] = tokens;
  const verb = (VERB_WHITELIST as readonly string[]).includes(verbRaw)
    ? (verbRaw as VoiceVerb)
    : null;

  // Unknown verb — never crash, never route. Fail-closed: full readback.
  if (verb === null) {
    return {
      parsed: {
        verb: verbRaw,
        object: rest[0] ?? null,
        modifiers: rest.slice(1),
        intent: "unknown",
      },
      routed_to_persona: null,
      readback_tier: "full",
      requires_confirmation: false,
      noise_action,
      error: "verb not in whitelist",
    };
  }

  const object = rest[0] ?? null;
  const modifiers = rest.slice(1);
  const intent = verbToIntent(verb);

  // Persona resolution — tries fuzzy match. Misses are stored as raw object.
  const match = object
    ? matchPersona(object, modifiers, opts.personasDir)
    : { slug: null, ambiguous: false, candidateCount: 0 };

  // Readback tier:
  //   1. Destructive  → full (always, per hard wall)
  //   2. Ambiguous match (>1 top-score candidate) → full (Roki picks)
  //   3. Low-stakes verbs (status/repeat/ack) → ack
  //   4. Otherwise → short
  let readback_tier: ReadbackTier;
  if (intent === "destructive") {
    readback_tier = "full";
  } else if (match.ambiguous) {
    readback_tier = "full";
  } else if (ACK_TIER_VERBS.has(verb)) {
    readback_tier = "ack";
  } else {
    readback_tier = "short";
  }

  // Confirmation requirement: any destructive intent always requires it.
  // Ambiguity does NOT auto-set confirmation (Roki resolves via numbered
  // choice flow at the controller layer, per voice-grammar.md "Numbered
  // choices over names").
  const requires_confirmation = intent === "destructive";

  return {
    parsed: { verb, object, modifiers, intent },
    routed_to_persona: match.slug,
    readback_tier,
    requires_confirmation,
    noise_action,
  };
}
