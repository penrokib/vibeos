import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AuditModule } from "../audit/audit.module";
import { KnowledgeSearchController } from "./knowledge-search.controller";
import { KnowledgeSearchService } from "./knowledge-search.service";

/**
 * Phase 8 — cross-specialist semantic search.
 *
 * Wires the knowledge-search service + controller. Stays self-contained:
 * the embedding provider (OpenAI direct or LiteLLM gateway at
 * app.dewx.com/litellm/v1) is resolved at runtime from ConfigService so
 * we can swap providers without re-wiring the module.
 *
 * Stub mode: if neither OPENAI_API_KEY nor LITELLM_KEY is present the
 * service emits warning logs and falls back to deterministic dummy
 * vectors so module load never blocks (tests + dev boxes stay green).
 */
@Module({
  imports: [ConfigModule, AuditModule],
  controllers: [KnowledgeSearchController],
  providers: [KnowledgeSearchService],
  exports: [KnowledgeSearchService],
})
export class KnowledgeSearchModule {}
