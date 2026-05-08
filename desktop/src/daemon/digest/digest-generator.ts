// =============================================================================
// rokibrain.app — DigestGenerator
// -----------------------------------------------------------------------------
// Synthesises a Today Digest by submitting a CC prompt through FleetManager.
//
// Hard walls:
//   - NEVER bypass FleetManager — no raw `claude` spawns here.
//   - NEVER include PII in CC prompts (v1 uses synthetic placeholders).
//   - If FleetManager returns CC_NOT_INSTALLED, return template digest (no throw).
//   - If CC output is malformed JSON, return template digest (no throw).
//   - SignalProvider is injected (DI) so cycle 17 can wire real sources without
//     touching this file.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { FleetManager } from '../cc-fleet/fleet-manager';
import type { Digest, DigestItem, DigestKind, RawSignal, SignalProvider } from './digest.types';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_SIGNAL_PROVIDER: SignalProvider = (): RawSignal => ({
  draftCount: 0,
  decisionCount: 0,
  idlePersonas: [],
  recentAlertTitles: [],
});

// ---------------------------------------------------------------------------
// DigestGenerator
// ---------------------------------------------------------------------------

export class DigestGenerator {
  private readonly fleet: FleetManager;
  private readonly getSignal: SignalProvider;

  constructor(fleet: FleetManager, signalProvider?: SignalProvider) {
    this.fleet = fleet;
    this.getSignal = signalProvider ?? DEFAULT_SIGNAL_PROVIDER;
  }

  // ---- public API ----------------------------------------------------------

  /**
   * Generate a Today Digest for the given mode.
   *
   * 1. Pulls raw signal via the injected SignalProvider.
   * 2. Builds a CC prompt (NO PII — v1 uses counts/labels only).
   * 3. Submits through FleetManager.
   * 4. Parses CC stdout as JSON; falls back to template digest on any failure.
   */
  async generate(mode: 'work' | 'personal'): Promise<Digest> {
    const signal = await this.getSignal();
    const id = randomUUID();
    const prompt = this.buildPrompt(mode, signal);

    let ccOutput: string;
    try {
      const result = await this.fleet.submit({ id, prompt, persona: 'digest' });
      ccOutput = result.output;
    } catch {
      return this.templateDigest(id, mode, signal);
    }

    // Graceful degrade: CC not installed.
    if (ccOutput.startsWith('CC_NOT_INSTALLED')) {
      return this.templateDigest(id, mode, signal);
    }

    // Try to parse CC output as JSON matching the Digest shape.
    try {
      const parsed = this.parseOutput(ccOutput, id, mode);
      return parsed;
    } catch {
      return this.templateDigest(id, mode, signal);
    }
  }

  // ---- private helpers -----------------------------------------------------

  /**
   * Build a CC prompt from the mode + raw signal.
   * v1: uses counts and labels only — NO personal names, emails, or content.
   * Cycle 17 will extend with redacted real data.
   */
  private buildPrompt(mode: 'work' | 'personal', signal: RawSignal): string {
    const signalJson = JSON.stringify({
      draftCount: signal.draftCount,
      decisionCount: signal.decisionCount,
      idlePersonas: signal.idlePersonas,
      recentAlertTitles: signal.recentAlertTitles,
    });

    return (
      `Summarize what happened in the user's ${mode} mesh in the last 6 hours. ` +
      `Output ONLY valid JSON matching this schema exactly (no markdown, no explanation): ` +
      `{ "needsYou": [...], "whatHappened": [...], "stuck": [...] }. ` +
      `Each array item must be: { "id": "<uuid>", "kind": "draft"|"decision"|"persona"|"alert", ` +
      `"title": "<5-10 words>", "subtitle": "<10-20 words>", "deepLink": "<vibeos://... or null>" }. ` +
      `Use these signals (no PII): ${signalJson}. ` +
      `Keep needsYou to items requiring explicit user action. ` +
      `Keep whatHappened to completed/background events. ` +
      `Keep stuck to stalled personas or queues.`
    );
  }

  /**
   * Parse CC's stdout into a typed Digest.
   * Throws if the output cannot be parsed or does not match the expected shape.
   */
  private parseOutput(raw: string, id: string, mode: 'work' | 'personal'): Digest {
    // Strip optional markdown code fences CC sometimes emits.
    const stripped = raw.replace(/^```[a-z]*\n?/m, '').replace(/```$/m, '').trim();
    const obj = JSON.parse(stripped) as Record<string, unknown>;

    const needsYou = this.parseItems(obj['needsYou']);
    const whatHappened = this.parseItems(obj['whatHappened']);
    const stuck = this.parseItems(obj['stuck']);

    return {
      id,
      generatedAt: Date.now(),
      mode,
      needsYou,
      whatHappened,
      stuck,
    };
  }

  private parseItems(raw: unknown): DigestItem[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      .map((item) => ({
        id: typeof item['id'] === 'string' ? item['id'] : randomUUID(),
        kind: this.parseKind(item['kind']),
        title: typeof item['title'] === 'string' ? item['title'] : 'Untitled',
        subtitle: typeof item['subtitle'] === 'string' ? item['subtitle'] : undefined,
        deepLink: typeof item['deepLink'] === 'string' ? item['deepLink'] : undefined,
        ts: typeof item['ts'] === 'number' ? item['ts'] : Date.now(),
      }));
  }

  private parseKind(raw: unknown): DigestKind {
    const valid: DigestKind[] = ['draft', 'decision', 'persona', 'alert'];
    return valid.includes(raw as DigestKind) ? (raw as DigestKind) : 'alert';
  }

  /**
   * Deterministic template digest — always valid, never throws.
   * Used when CC is unavailable or returns malformed output.
   */
  private templateDigest(id: string, mode: 'work' | 'personal', signal: RawSignal): Digest {
    const now = Date.now();

    const needsYou: DigestItem[] = [];
    const whatHappened: DigestItem[] = [];
    const stuck: DigestItem[] = [];

    if (signal.decisionCount > 0) {
      needsYou.push({
        id: randomUUID(),
        kind: 'decision',
        title: `${signal.decisionCount} decision${signal.decisionCount > 1 ? 's' : ''} awaiting review`,
        subtitle: 'Open the decisions tab to action them',
        ts: now,
      });
    }

    if (signal.draftCount > 0) {
      needsYou.push({
        id: randomUUID(),
        kind: 'draft',
        title: `${signal.draftCount} draft${signal.draftCount > 1 ? 's' : ''} queued for approval`,
        subtitle: 'Review outgoing messages before they send',
        deepLink: 'vibeos://drafts',
        ts: now,
      });
    }

    for (const alertTitle of signal.recentAlertTitles.slice(0, 3)) {
      whatHappened.push({
        id: randomUUID(),
        kind: 'alert',
        title: alertTitle,
        ts: now - 3_600_000,
      });
    }

    for (const persona of signal.idlePersonas) {
      stuck.push({
        id: randomUUID(),
        kind: 'persona',
        title: `${persona} is idle (>4h)`,
        subtitle: 'No recent activity detected for this persona',
        ts: now - 14_400_000,
      });
    }

    return { id, generatedAt: now, mode, needsYou, whatHappened, stuck };
  }
}
