import {
  ArrayMaxSize,
  IsArray,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { JwtAuthGuard, Roles, RolesGuard } from "@vibeos/auth";
import { LettaProxyService } from "./letta-proxy.service";

/**
 * `POST /letta/agents` body. Inline DTO — only this controller uses it,
 * so we don't peel a separate file.
 */
export class CreateLettaAgentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  persona!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(20_000)
  system_prompt!: string;

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  tools!: string[];
}

export class SendLettaMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50_000)
  message!: string;
}

/**
 * Letta proxy — every persona gets a Letta memory agent. This controller is
 * the BFF's adapter layer between the rokibrain dashboard / dispatch.sh and
 * the Letta server running on k3s.
 *
 * Class-C bug-prevention: class-level @UseGuards(JwtAuthGuard, RolesGuard) +
 * default @Roles("admin","persona"). Memory wipe is admin-only (right-to-forget).
 */
@Controller("letta")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("admin", "persona")
export class LettaProxyController {
  constructor(private readonly letta: LettaProxyService) {}

  /** POST /letta/agents — create a Letta agent for a persona. */
  @Post("agents")
  @HttpCode(201)
  createAgent(@Body() dto: CreateLettaAgentDto) {
    return this.letta.createAgent(dto);
  }

  /** POST /letta/agents/:agent_id/message — send to agent. */
  @Post("agents/:agent_id/message")
  @HttpCode(200)
  sendMessage(
    @Param("agent_id") agentId: string,
    @Body() dto: SendLettaMessageDto,
  ) {
    return this.letta.sendMessage(agentId, dto.message);
  }

  /** GET /letta/agents/:agent_id/memory — admin-only memory inspection. */
  @Get("agents/:agent_id/memory")
  @Roles("admin")
  getMemory(@Param("agent_id") agentId: string) {
    return this.letta.getMemory(agentId);
  }

  /**
   * DELETE /letta/agents/:agent_id — GDPR right-to-forget.
   * Roki/admin only — deliberately narrower than the class @Roles.
   */
  @Delete("agents/:agent_id")
  @Roles("admin")
  @HttpCode(200)
  wipeAgent(@Param("agent_id") agentId: string) {
    return this.letta.wipeAgent(agentId);
  }
}
