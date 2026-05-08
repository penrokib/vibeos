import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Query,
  Req,
  UseGuards,
  HttpException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  CurrentUser,
  JwtAuthGuard,
  Public,
  Roles,
  RolesGuard,
} from "@vibeos/auth";
import type { JwtPayload } from "@vibeos/auth";
import type { Request } from "express";
import { MintAgentTokenDto, VerifyAgentTokenDto } from "./dto/meshcentral.dto";
import { MeshCentralTokenService } from "./meshcentral-token.service";

/**
 * MeshCentralController — serves the MeshCentral one-shot install scripts.
 *
 * Three surfaces:
 *
 *   GET  /install/meshcentral-server          (public, server bash script)
 *   GET  /install/meshcentral-agent           (public, agent bash with embedded token)
 *   POST /install/meshcentral-agent/token     (admin, mint a one-time token)
 *   POST /install/meshcentral-agent/token/verify  (public, called by install script)
 *   GET  /install/meshcentral-agent/token/status (public, polled by install script)
 *
 * Security model:
 *
 *   • The SERVER install URL is public on purpose — `curl|bash` cannot
 *     present a JWT, and the script self-aborts if it detects Hetzner /
 *     non-Scaleway hosts (the sacred-boundary check is in-script).
 *
 *   • The AGENT install URL requires a one-time token. Token mint is
 *     admin-only. The agent script verifies the token against the BFF
 *     before installing anything; expired/consumed/wrong-group tokens
 *     all 4xx with distinct codes so the audit trail is precise.
 *
 *   • Every mint and every verify hit the audit log via AuditService.
 *
 * Why @Controller() with mixed-scope routes:
 *   • Class-level @UseGuards(JwtAuthGuard, RolesGuard) gives admin-default,
 *     and we explicitly @Public() the four endpoints that must be reachable
 *     by `curl|bash` (no JWT possible). This matches Class-C bug-prevention
 *     elsewhere in the BFF (FleetController).
 *
 * Spec: handoffs/meshcentral-deploy-runbook-2026-05-06.md (sister agent)
 */
@Controller("install")
@UseGuards(JwtAuthGuard, RolesGuard)
export class MeshCentralController {
  /** Resolved at boot — paths are config-overrideable via env. */
  private readonly serverScriptPath: string;
  private readonly agentScriptPath: string;
  private readonly bffBaseUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly tokens: MeshCentralTokenService,
  ) {
    // Default points at the rokibrain checkout co-located with the BFF on
    // the Scaleway box. Override in env for local dev.
    const fallbackServer = resolve(
      process.cwd(),
      "../../../rokibrain/bin/install-meshcentral-server.sh",
    );
    const fallbackAgent = resolve(
      process.cwd(),
      "../../../rokibrain/bin/install-meshcentral-agent.sh",
    );
    this.serverScriptPath =
      this.config.get<string>("MESHCENTRAL_SERVER_SCRIPT") ?? fallbackServer;
    this.agentScriptPath =
      this.config.get<string>("MESHCENTRAL_AGENT_SCRIPT") ?? fallbackAgent;
    this.bffBaseUrl =
      this.config.get<string>("ROKIBRAIN_BFF_BASE_URL") ??
      "https://app.rokibrain.com";
  }

  // ─── Server install script ───────────────────────────────────────────

  /**
   * GET /install/meshcentral-server — serve the server install script raw.
   *
   * Public because `curl|bash` cannot present a JWT. The script self-protects
   * via the Hetzner-detection abort and the rolling backups it takes before
   * touching any reverse-proxy config.
   */
  @Get("meshcentral-server")
  @Public()
  @Header("Content-Type", "text/x-shellscript; charset=utf-8")
  @Header("Cache-Control", "no-store")
  @Header("X-Content-Type-Options", "nosniff")
  serveServerScript(): string {
    if (!existsSync(this.serverScriptPath)) {
      throw new NotFoundException(
        `install-meshcentral-server.sh not found at ${this.serverScriptPath}. ` +
          `Set MESHCENTRAL_SERVER_SCRIPT in BFF env.`,
      );
    }
    // Read fresh per request so a redeploy of the script propagates without
    // a BFF restart. The file is small.
    return readFileSync(this.serverScriptPath, "utf8");
  }

  // ─── Agent install script (with embedded token) ─────────────────────

  /**
   * GET /install/meshcentral-agent — serve the agent install script.
   *
   * The CALLER passes `?token=<one-time>&group=<name>` in the URL. We splice
   * those into the script body before serving so the user only types one
   * curl. Tokens are verified server-side later when the script POSTs to
   * /install/meshcentral-agent/token/verify.
   *
   * If no token in the query string, we still serve the script — but the
   * embedded fields stay as `__BFF_BASE__` / `__TOKEN__` / `__GROUP__`
   * placeholders. The script will error out with a clear message.
   */
  @Get("meshcentral-agent")
  @Public()
  @Header("Content-Type", "text/x-shellscript; charset=utf-8")
  @Header("Cache-Control", "no-store")
  @Header("X-Content-Type-Options", "nosniff")
  serveAgentScript(
    @Query("token") token?: string,
    @Query("group") group?: string,
  ): string {
    if (!existsSync(this.agentScriptPath)) {
      throw new NotFoundException(
        `install-meshcentral-agent.sh not found at ${this.agentScriptPath}. ` +
          `Set MESHCENTRAL_AGENT_SCRIPT in BFF env.`,
      );
    }
    let raw = readFileSync(this.agentScriptPath, "utf8");

    // Splice in the BFF base URL + token + group. Use shell-safe substitution:
    // tokens are hex (validated on mint) and groups match /^[a-zA-Z0-9_-]+$/
    // (DTO-validated when minted), so they cannot escape the single-quoted
    // assignment line we're writing.
    const safeBase = this.shellEscape(this.bffBaseUrl);
    const safeToken = token ? this.shellEscape(token) : "__TOKEN__";
    const safeGroup = group ? this.shellEscape(group) : "__GROUP__";

    // Replace EMBEDDED_* defaults declared near the top of the script.
    raw = raw.replace(
      /EMBEDDED_BFF_BASE="\$\{EMBEDDED_BFF_BASE:-__BFF_BASE__\}"/,
      `EMBEDDED_BFF_BASE="\${EMBEDDED_BFF_BASE:-${safeBase}}"`,
    );
    raw = raw.replace(
      /EMBEDDED_TOKEN="\$\{EMBEDDED_TOKEN:-__TOKEN__\}"/,
      `EMBEDDED_TOKEN="\${EMBEDDED_TOKEN:-${safeToken}}"`,
    );
    raw = raw.replace(
      /EMBEDDED_GROUP="\$\{EMBEDDED_GROUP:-__GROUP__\}"/,
      `EMBEDDED_GROUP="\${EMBEDDED_GROUP:-${safeGroup}}"`,
    );

    return raw;
  }

  // ─── Mint token (admin) ──────────────────────────────────────────────

  /**
   * POST /install/meshcentral-agent/token — admin only.
   *
   * Mints a one-time install token for the given device group. Returns the
   * full curl|bash URL Roki copy-pastes onto the target device.
   *
   * Token TTL is 10 minutes (enforced by MeshCentralTokenService). Single-use:
   * the first successful agent install burns the token.
   */
  @Post("meshcentral-agent/token")
  @Roles("admin")
  @HttpCode(HttpStatus.OK)
  async mintToken(
    @CurrentUser() user: JwtPayload,
    @Body() dto: MintAgentTokenDto,
  ) {
    const minted = await this.tokens.mint(
      user.email ?? user.sub,
      dto.group,
      this.bffBaseUrl,
    );
    return {
      group: minted.group,
      installUrl: minted.installUrl,
      // Surface the token explicitly for admins who want to construct
      // a curl invocation manually. Equivalent to what's in installUrl.
      token: minted.token,
      expiresAt: minted.expiresAt,
      // One-line copy-paste shell command Roki actually types.
      //
      // We use `bash <(curl ...)` (process substitution) instead of the
      // classic `curl ... | bash` because the agent script's consent banner
      // needs an interactive stdin to read the user's "y" response. With
      // a plain pipe, stdin is the curl process and the read() returns EOF
      // immediately → script aborts. Process substitution keeps stdin
      // attached to the user's terminal.
      curlCommand: `bash <(curl -fsSL "${minted.installUrl}")`,
      // For non-interactive runners (CI, --no-banner), pipes still work:
      curlCommandNoConsent: `curl -fsSL "${minted.installUrl}" | bash -s -- --no-banner`,
    };
  }

  // ─── Verify token (called by install script) ─────────────────────────

  /**
   * POST /install/meshcentral-agent/token/verify — public (script needs it).
   *
   * The agent install script POSTs here BEFORE downloading the MeshCentral
   * agent binary. Distinct HTTP codes per failure mode so the script can
   * give the user a precise error:
   *
   *   200  ok         token valid + group matches; consumed atomically
   *   404  not_found  token never existed (bad URL)
   *   410  expired    10-min TTL elapsed
   *   409  consumed   token already used (single-use)
   *   403  group_mismatch  token valid but for a different group
   */
  @Post("meshcentral-agent/token/verify")
  @Public()
  @HttpCode(HttpStatus.OK)
  async verifyToken(@Body() dto: VerifyAgentTokenDto, @Req() req: Request) {
    const result = await this.tokens.verifyAndConsume(dto.token, dto.group, {
      os: dto.os,
      arch: dto.arch,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    if (result.ok) {
      return { ok: true, group: dto.group };
    }
    // Map reasons -> HTTP codes
    switch (result.reason) {
      case "not_found":
        throw new HttpException("token not found", HttpStatus.NOT_FOUND);
      case "expired":
        throw new HttpException("token expired", HttpStatus.GONE);
      case "consumed":
        throw new HttpException("token already used", HttpStatus.CONFLICT);
      case "group_mismatch":
        throw new HttpException("token group mismatch", HttpStatus.FORBIDDEN);
      default:
        throw new HttpException("token invalid", HttpStatus.UNAUTHORIZED);
    }
  }

  // ─── Status poll (called by install script) ─────────────────────────

  /**
   * GET /install/meshcentral-agent/token/status?token=... — public.
   *
   * The install script polls this after kicking off the MeshCentral agent
   * binary, waiting for "registered" status (set when the agent shows up in
   * MeshCentral via the admin webhook — Phase 2 wires that webhook).
   * Until the webhook lands, "consumed" is the success signal.
   */
  @Get("meshcentral-agent/token/status")
  @Public()
  status(@Query("token") token?: string) {
    if (!token) {
      throw new HttpException("token query param required", HttpStatus.BAD_REQUEST);
    }
    return this.tokens.status(token);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  /**
   * Sanitize a string for embedding inside a bash double-quoted heredoc.
   * Inputs come from URL queries, so we already validated character classes
   * upstream (token = hex, group = [a-zA-Z0-9_-]+). This is belt-and-braces
   * for the BFF base URL specifically — strip backticks, dollar signs,
   * quotes, and backslashes that could escape the assignment.
   */
  private shellEscape(s: string): string {
    return s.replace(/[`$"\\]/g, "");
  }
}
