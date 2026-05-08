import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Type } from "class-transformer";
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { CurrentUser, JwtAuthGuard } from "@vibeos/auth";
import { KnowledgeSearchService } from "./knowledge-search.service";

/**
 * Phase 8 — knowledge-search controller.
 *
 * - POST /knowledge/embed         → embed one chunk (admin/persona only)
 * - POST /knowledge/persona/reset → wipe all rows for a persona (used by
 *                                    bin/vector-db-init.sh --backfill so
 *                                    re-runs stay idempotent)
 * - POST /knowledge/backfill      → walk a persona's md files + embed
 * - GET  /knowledge/search        → semantic search across the fleet
 * - GET  /knowledge/health        → liveness ping the bash bootstrap
 *                                    uses to detect "is the BFF up?"
 *
 * Class-C: class-level @UseGuards(JwtAuthGuard) — every route is auth'd
 * by default. The /health route flips to @Public() if we ever need an
 * unauthenticated probe; for now we keep it locked.
 */

class EmbedDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  persona!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  sourceFile!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  chunkIdx!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(8_000)
  content!: string;
}

class ResetPersonaDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  persona!: string;
}

class BackfillDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  persona!: string;
}

class SearchQueryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2_000)
  q!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  persona?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  top_k?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  min_score?: number;
}

@Controller("knowledge")
@UseGuards(JwtAuthGuard)
export class KnowledgeSearchController {
  constructor(private readonly svc: KnowledgeSearchService) {}

  @Get("health")
  health() {
    return { ok: true, module: "knowledge-search" };
  }

  @Post("embed")
  embed(@CurrentUser("sub") userId: string, @Body() dto: EmbedDto) {
    return this.svc.embed(dto, userId);
  }

  @Post("persona/reset")
  reset(@CurrentUser("sub") userId: string, @Body() dto: ResetPersonaDto) {
    return this.svc.resetPersona(dto.persona, userId);
  }

  @Post("backfill")
  backfill(@CurrentUser("sub") userId: string, @Body() dto: BackfillDto) {
    return this.svc.backfillPersona(dto.persona, userId);
  }

  @Get("search")
  search(@Query() query: SearchQueryDto) {
    return this.svc.search(query.q, {
      persona: query.persona,
      topK: query.top_k,
      minScore: query.min_score,
    });
  }
}
