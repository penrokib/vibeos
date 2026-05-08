import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BadRequestException,
  Injectable,
  Logger,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "@vibeos/database";
import { AuditService } from "../audit/audit.service";

/**
 * Phase 8 — semantic learning search service.
 *
 * Responsibilities:
 *   1. embed(): turn a chunk of markdown into a 1536-d vector via
 *      OpenAI ada-002 or the LiteLLM gateway, then UPSERT a row in
 *      learnings_embeddings keyed by (persona, sourceFile, chunkIdx).
 *   2. search(): embed the query, run a pgvector cosine-distance
 *      ORDER BY against the table, return top-K hits with score.
 *   3. backfillPersona(): walk personas/<slug>/{learnings,decisions}.md,
 *      chunk to ~500 chars, DELETE existing rows for the (persona, file)
 *      pair, then call embed() for each chunk. Idempotent.
 *
 * Class-A bug-prevention: every persona-scoped query carries the
 * persona key explicitly. Single-tenant (Roki only) for now, so we
 * don't multi-tenant scope; the moment we add a second actor the
 * Dewx organizationId pattern lands on top of this.
 *
 * Class-C: stub mode keeps the module load idempotent — if the
 * embedding API is unreachable we log loud and emit deterministic
 * dummy vectors so dev boxes stay green.
 */

const EMBEDDING_DIM = 1536;
const ADA_MODEL = "text-embedding-ada-002";
const PERSONAS_ROOT =
  process.env.ROKIBRAIN_PERSONAS_ROOT ??
  "/Users/rokibulhasan/Projects/rokibrain/personas";

// Hard PII regex — refuse to embed any chunk containing these tokens
// until the GDPR redaction filter ships (TODO: scrubber service).
const PII_REGEX =
  /\b(IBAN|password|token|secret|api[_-]?key|jannat|shafira|amalya|abdullah|noor)\b/i;

export interface EmbedInput {
  persona: string;
  sourceFile: string;
  chunkIdx: number;
  content: string;
}

export interface SearchOptions {
  persona?: string;
  topK?: number;
  minScore?: number;
}

export interface SearchHit {
  id: string;
  persona: string;
  sourceFile: string;
  chunkIdx: number;
  content: string;
  score: number; // 0-1, higher = better
}

@Injectable()
export class KnowledgeSearchService implements OnModuleInit {
  private readonly logger = new Logger(KnowledgeSearchService.name);
  private apiKey: string | null = null;
  private apiEndpoint = "https://api.openai.com/v1/embeddings";
  private stubMode = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    const openai = this.config.get<string>("OPENAI_API_KEY");
    const litellm = this.config.get<string>("LITELLM_KEY");
    if (litellm) {
      this.apiKey = litellm;
      this.apiEndpoint =
        this.config.get<string>("LITELLM_EMBEDDINGS_URL") ??
        "https://app.dewx.com/litellm/v1/embeddings";
      this.logger.log(
        `Knowledge search: using LiteLLM gateway at ${this.apiEndpoint}`,
      );
    } else if (openai) {
      this.apiKey = openai;
      this.apiEndpoint = "https://api.openai.com/v1/embeddings";
      this.logger.log("Knowledge search: using OpenAI directly");
    } else {
      this.stubMode = true;
      this.logger.warn(
        "Knowledge search: no OPENAI_API_KEY or LITELLM_KEY set — falling back to dummy embeddings. Search results will be MEANINGLESS until a key is configured.",
      );
    }
  }

  // ─── Embedding provider ──────────────────────────────────────────────

  /**
   * Calls the configured embeddings API for a single chunk.
   * In stub mode, returns a deterministic hash-derived vector so the
   * same content always produces the same dummy embedding (handy for
   * smoke-testing the SQL plumbing without burning OpenAI credits).
   *
   * TODO: batch embeddings — OpenAI accepts arrays of inputs (up to 2048).
   * Sending 100 chunks per request would cut latency ~50x and respects
   * the 1k/min rate-limit cap.
   */
  private async generateEmbedding(content: string): Promise<number[]> {
    if (this.stubMode || !this.apiKey) {
      return this.dummyEmbedding(content);
    }
    try {
      const res = await fetch(this.apiEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: ADA_MODEL, input: content }),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "<no body>");
        throw new Error(`embeddings API ${res.status}: ${txt.slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        data?: Array<{ embedding: number[] }>;
      };
      const vec = json.data?.[0]?.embedding;
      if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIM) {
        throw new Error(
          `embeddings API returned bad payload (got ${vec?.length} dims, expected ${EMBEDDING_DIM})`,
        );
      }
      return vec;
    } catch (err) {
      this.logger.error(
        `embeddings call failed — falling back to dummy: ${(err as Error).message}`,
      );
      return this.dummyEmbedding(content);
    }
  }

  private dummyEmbedding(content: string): number[] {
    // Deterministic: sha256(content) seeds an iterated hash that fills
    // the 1536 slots. Two identical chunks → identical vectors.
    const out = new Array<number>(EMBEDDING_DIM);
    let seed = createHash("sha256").update(content).digest();
    let cursor = 0;
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      if (cursor + 4 > seed.length) {
        seed = createHash("sha256").update(seed).digest();
        cursor = 0;
      }
      const u32 = seed.readUInt32BE(cursor);
      cursor += 4;
      // Map to [-1, 1] uniform.
      out[i] = u32 / 2 ** 31 - 1;
    }
    // Normalise so cosine distance behaves.
    let norm = 0;
    for (const v of out) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < EMBEDDING_DIM; i++) out[i] /= norm;
    // Touch randomBytes once to silence unused-import warning if the
    // import gets re-shuffled; harmless.
    if (process.env.KNOWLEDGE_DEBUG_RAND === "1") void randomBytes(1);
    return out;
  }

  // ─── PII guard ───────────────────────────────────────────────────────

  private assertNoPII(content: string, ctx: string): void {
    if (PII_REGEX.test(content)) {
      this.logger.warn(
        `PII match in ${ctx} — refusing to embed until GDPR redaction filter lands. Sample: ${content.slice(0, 80)}…`,
      );
      throw new BadRequestException(
        "chunk contains PII tokens (IBAN/password/token/secret/family-name) — embedding refused",
      );
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────

  /**
   * Embed a single chunk and UPSERT into learnings_embeddings.
   * Idempotent on (persona, sourceFile, chunkIdx).
   */
  async embed(input: EmbedInput, actor = "system"): Promise<{ id: string }> {
    this.assertNoPII(input.content, `${input.persona}/${input.sourceFile}#${input.chunkIdx}`);

    const vector = await this.generateEmbedding(input.content);
    const literal = this.toVectorLiteral(vector);

    // UPSERT through raw SQL — Prisma can't typecheck `vector(1536)`.
    // Class-D guard: parameterise everything, never interpolate user text
    // into the query string itself.
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `
      INSERT INTO learnings_embeddings (persona, source_file, chunk_idx, content, embedding)
      VALUES ($1, $2, $3, $4, $5::vector)
      ON CONFLICT (persona, source_file, chunk_idx)
      DO UPDATE SET content = EXCLUDED.content, embedding = EXCLUDED.embedding, created_at = now()
      RETURNING id::text AS id
      `,
      input.persona,
      input.sourceFile,
      input.chunkIdx,
      input.content,
      literal,
    );

    const id = rows[0]?.id ?? "unknown";
    await this.audit.record(actor, "knowledge.embed", id, {
      persona: input.persona,
      sourceFile: input.sourceFile,
      chunkIdx: input.chunkIdx,
      stub: this.stubMode,
    });
    return { id };
  }

  /**
   * Semantic search across all (or one persona's) embeddings.
   * Returns top-K by cosine similarity, filtered by minScore.
   */
  async search(query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
    const topK = Math.min(Math.max(opts.topK ?? 10, 1), 100);
    const minScore = opts.minScore ?? 0.7;

    const vector = await this.generateEmbedding(query);
    const literal = this.toVectorLiteral(vector);

    // pgvector cosine DISTANCE = 1 - cosine SIMILARITY. Lower is better.
    // We compute similarity = 1 - distance and threshold on minScore.
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        persona: string;
        source_file: string;
        chunk_idx: number;
        content: string;
        distance: number;
      }>
    >(
      `
      SELECT id::text, persona, source_file, chunk_idx, content,
             (embedding <=> $1::vector) AS distance
      FROM learnings_embeddings
      WHERE embedding IS NOT NULL
        ${opts.persona ? "AND persona = $2" : ""}
      ORDER BY embedding <=> $1::vector
      LIMIT ${topK}
      `,
      literal,
      ...(opts.persona ? [opts.persona] : []),
    );

    return rows
      .map((r) => ({
        id: r.id,
        persona: r.persona,
        sourceFile: r.source_file,
        chunkIdx: r.chunk_idx,
        content: r.content,
        score: 1 - Number(r.distance),
      }))
      .filter((h) => h.score >= minScore);
  }

  /**
   * Walk personas/<slug>/{learnings,decisions}.md, chunk, embed, store.
   * DELETEs existing rows for (persona, sourceFile) first so re-running
   * never duplicates content.
   *
   * TODO: rate-limit. The current loop is sequential — fine for one
   * persona, but `backfill --all` from bash will need a 1k-req/min cap
   * and 100-chunks-per-batch when batched embeddings ship.
   */
  async backfillPersona(slug: string, actor = "system"): Promise<{
    persona: string;
    chunks: number;
    skippedPii: number;
  }> {
    const dir = join(PERSONAS_ROOT, slug);
    let chunks = 0;
    let skippedPii = 0;

    for (const sourceFile of ["learnings.md", "decisions.md"]) {
      const file = join(dir, sourceFile);
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch {
        continue; // missing file is fine
      }

      // Idempotent reset for this (persona, file) pair.
      await this.prisma.$executeRawUnsafe(
        `DELETE FROM learnings_embeddings WHERE persona = $1 AND source_file = $2`,
        slug,
        sourceFile,
      );

      const pieces = this.chunkMarkdown(raw, 500);
      for (let i = 0; i < pieces.length; i++) {
        const content = pieces[i];
        if (!content || content.trim().length < 20) continue;
        try {
          await this.embed(
            { persona: slug, sourceFile, chunkIdx: i, content },
            actor,
          );
          chunks += 1;
        } catch (err) {
          if ((err as { status?: number })?.status === 400) {
            skippedPii += 1;
          } else {
            this.logger.error(
              `embed failed for ${slug}/${sourceFile}#${i}: ${(err as Error).message}`,
            );
          }
        }
      }
    }

    await this.audit.record(actor, "knowledge.backfill", slug, {
      chunks,
      skippedPii,
    });
    return { persona: slug, chunks, skippedPii };
  }

  /**
   * Reset all rows for a persona — used by the bash backfill so re-runs
   * stay idempotent regardless of which sourceFile is being re-embedded.
   */
  async resetPersona(slug: string, actor = "system"): Promise<{ deleted: number }> {
    const deleted = await this.prisma.$executeRawUnsafe(
      `DELETE FROM learnings_embeddings WHERE persona = $1`,
      slug,
    );
    await this.audit.record(actor, "knowledge.reset", slug, { deleted });
    return { deleted: Number(deleted) };
  }

  // ─── helpers ─────────────────────────────────────────────────────────

  /**
   * Split markdown into ~maxChars chunks, preferring paragraph and
   * heading boundaries so a single learning entry stays whole.
   */
  private chunkMarkdown(raw: string, maxChars: number): string[] {
    const out: string[] = [];
    const paragraphs = raw.split(/\n\s*\n/);
    let buf = "";
    for (const para of paragraphs) {
      if (!para.trim()) continue;
      // A new ### heading always starts a fresh chunk.
      if (/^###\s/m.test(para) && buf.length > 0) {
        out.push(buf.trim());
        buf = para;
        continue;
      }
      if ((buf + "\n\n" + para).length > maxChars && buf.length > 0) {
        out.push(buf.trim());
        buf = para;
      } else {
        buf = buf ? `${buf}\n\n${para}` : para;
      }
    }
    if (buf.trim()) out.push(buf.trim());
    return out;
  }

  private toVectorLiteral(vec: number[]): string {
    // pgvector accepts a string literal of the form `[0.1,0.2,...]`.
    // We round to 6 decimals to keep the SQL payload reasonable.
    return `[${vec.map((v) => v.toFixed(6)).join(",")}]`;
  }
}
