import { Injectable, Logger } from "@nestjs/common";
import type { Bug, BugComment } from "@prisma/client";

/**
 * AI bug-summary service.
 *
 * Calls `claude-haiku-4-5` via the Anthropic Messages API to produce a
 * 2-sentence triage summary of a bug + its comment thread. Used by the
 * `/bugs/[id]` web detail page to surface "where things stand" at a
 * glance without forcing the engineer to scroll through every comment.
 *
 * Constraints (all by design, all enforced here):
 *   - **No SDK.** Plain `fetch` against
 *     `https://api.anthropic.com/v1/messages`. Node 18+ has it native;
 *     keeps the bff's dep graph trim.
 *   - **Cost-gated.** Skip bugs that are trivially short — ≤ 3 comments
 *     **and** < 24h old. The summary's value is proportional to
 *     thread length; new + tiny bugs aren't worth the haiku call.
 *   - **In-memory cache** keyed on (bugId, status, comment count, last
 *     comment id). Adding a comment or flipping status invalidates;
 *     restarts wipe the cache (haiku is cheap; regenerate happily).
 *   - **Graceful no-op** when `ANTHROPIC_API_KEY` is missing: returns
 *     `null` so the web side renders nothing without a banner. Same on
 *     transport errors / non-2xx — we log and degrade.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 200;
const MIN_COMMENTS_FOR_SUMMARY = 3;
const MIN_AGE_MS_FOR_SUMMARY = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

const SYSTEM_PROMPT = `You write extremely terse bug-thread summaries for engineers triaging app.rokibrain.com.

Rules:
- Output exactly two sentences.
- First sentence: what the bug is and where things stand (open / claimed / in progress / fix attached / verified).
- Second sentence: the most useful next step or open question for whoever picks the bug up next.
- Plain prose. No preamble, no markdown headers, no bullets, no quoting the title back at me.
- If a fix is attached, say it. If it's verified, say it. If nobody's claimed yet, say it.
`;

export interface SummarizeBugInput {
  bug: Pick<Bug, "id" | "title" | "description" | "status" | "reportedAt">;
  comments: Pick<BugComment, "id" | "author" | "body" | "createdAt">[];
}

export interface BugSummary {
  summary: string;
  generatedAt: string;
  cached: boolean;
}

interface CacheEntry {
  cacheKey: string;
  summary: string;
  generatedAt: Date;
}

@Injectable()
export class BugSummaryService {
  private readonly log = new Logger(BugSummaryService.name);
  private readonly cache = new Map<string, CacheEntry>();

  /**
   * Returns a cached or freshly-minted summary, or `null` when the
   * summary should be skipped (cost gate, missing API key, transport
   * error). Callers render nothing when null.
   */
  async getSummary(input: SummarizeBugInput): Promise<BugSummary | null> {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      return null;
    }

    if (this.isTrivial(input)) {
      return null;
    }

    const cacheKey = this.makeCacheKey(input);
    const cached = this.cache.get(input.bug.id);
    if (cached && cached.cacheKey === cacheKey) {
      return {
        summary: cached.summary,
        generatedAt: cached.generatedAt.toISOString(),
        cached: true,
      };
    }

    let summary: string;
    try {
      summary = await this.callClaude(input, apiKey);
    } catch (err) {
      this.log.warn(
        `summary call failed for bug=${input.bug.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }

    const entry: CacheEntry = {
      cacheKey,
      summary,
      generatedAt: new Date(),
    };
    this.cache.set(input.bug.id, entry);
    return {
      summary,
      generatedAt: entry.generatedAt.toISOString(),
      cached: false,
    };
  }

  // ── helpers ─────────────────────────────────────────────────────────

  private isTrivial(input: SummarizeBugInput): boolean {
    const ageMs = Date.now() - input.bug.reportedAt.getTime();
    return (
      input.comments.length <= MIN_COMMENTS_FOR_SUMMARY &&
      ageMs < MIN_AGE_MS_FOR_SUMMARY
    );
  }

  private makeCacheKey(input: SummarizeBugInput): string {
    const lastId = input.comments.at(-1)?.id ?? "none";
    return `${input.bug.status}:${input.comments.length}:${lastId}`;
  }

  private buildUserContent(input: SummarizeBugInput): string {
    const lines: string[] = [];
    lines.push(`Bug: ${input.bug.title}`);
    lines.push(`Status: ${input.bug.status}`);
    lines.push(
      `Reported: ${input.bug.reportedAt.toISOString()} (${this.relAgo(input.bug.reportedAt)})`,
    );
    lines.push("");
    lines.push("Description:");
    lines.push(input.bug.description.slice(0, 4_000));
    if (input.comments.length > 0) {
      lines.push("");
      lines.push(
        `Thread (${input.comments.length} comments, oldest first):`,
      );
      for (const c of input.comments) {
        lines.push("---");
        lines.push(`[${c.createdAt.toISOString()}] ${c.author}`);
        lines.push(c.body.slice(0, 2_000));
      }
    }
    lines.push("");
    lines.push("Write your two-sentence summary now. Plain prose. No preamble.");
    return lines.join("\n");
  }

  private relAgo(when: Date): string {
    const ms = Date.now() - when.getTime();
    if (ms < 0) return "in the future";
    const min = Math.round(ms / 60_000);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 48) return `${hr}h ago`;
    const day = Math.round(hr / 24);
    return `${day}d ago`;
  }

  private async callClaude(
    input: SummarizeBugInput,
    apiKey: string,
  ): Promise<string> {
    const userContent = this.buildUserContent(input);
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      FETCH_TIMEOUT_MS,
    );

    let res: Response;
    try {
      res = await fetch(ANTHROPIC_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userContent }],
        }),
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `anthropic ${res.status}: ${body.slice(0, 240) || res.statusText}`,
      );
    }
    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (data.content ?? [])
      .filter(
        (b): b is { type: "text"; text: string } =>
          b.type === "text" && typeof b.text === "string",
      )
      .map((b) => b.text.trim())
      .join("\n")
      .trim();
    if (!text) throw new Error("anthropic returned empty text");
    return text;
  }

  /** Test hook — clear the cache between specs. */
  clearCache(): void {
    this.cache.clear();
  }
}
