import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Controller, Get, Header, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Public } from "@vibeos/auth";

/**
 * InstallerController — serves the rokibrain one-terminal-command installer.
 *
 * The single endpoint:
 *
 *   GET /install
 *   curl -fsSL https://app.rokibrain.com/install | bash
 *
 * Pipes the install.sh script straight to the user's shell. After an
 * out-of-band WhatsApp approval gate from Roki, the new machine joins the
 * agency mesh as a worker (M1, Win-WSL, future M2, etc.).
 *
 * Class-C bug-prevention:
 *   - The endpoint is `@Public()` because `curl | bash` cannot present a JWT.
 *     The drive-by-enroll defense is the WhatsApp gate at install-time
 *     (Stage 4 of install.sh), NOT auth on this endpoint.
 *   - We pin the response Content-Type to `text/x-shellscript; charset=utf-8`
 *     so a browser hitting /install gets a download, not a render.
 *   - We strip the leading shebang's `#!` BOM defense by reading the file
 *     bytes-as-utf8 once at boot (or per request — script is small) and
 *     emitting them verbatim. No template interpolation: a typo here would
 *     break the live install.
 *
 * Spec: /Users/rokibulhasan/Projects/rokibrain/handoffs/agency-v3-inventory/38-pc-onboarding-install-system.md
 *
 * TODO Phase 5b:
 *   - Verify the install.sh signature with cosign before serving.
 *   - Sign the response with the BFF's GPG key and surface the signature URL
 *     in the script's verify-block.
 *   - Add /install/event for stage-by-stage telemetry (so Roki can watch the
 *     install run live in /agency).
 *
 * TODO Phase 5c (BFF endpoints the script needs):
 *   - POST /enrollment/request    — create enrollment, fire WhatsApp ping.
 *   - GET  /enrollment/:id        — polled by install.sh until status=approved.
 *   - GET  /enroll/r/:token       — Roki's one-tap approval landing page.
 *   - GET  /enroll/d/:token       — Roki's deny landing page.
 *   - POST /fleet/register        — final registration after tailnet join.
 *   - POST /fleet/:id/heartbeat   — periodic health pings.
 */
@Controller()
export class InstallerController {
  /** Resolved at boot (constructor) so we don't re-stat per request. */
  private readonly installScriptPath: string;

  constructor(private readonly config: ConfigService) {
    // Default points at the rokibrain checkout co-located with the BFF on
    // the box (Scaleway, per server-topology memory). Override via env when
    // running locally.
    const fallback = resolve(
      process.cwd(),
      "../../../rokibrain/bin/install.sh",
    );
    this.installScriptPath =
      this.config.get<string>("ROKIBRAIN_INSTALL_SCRIPT") ??
      this.config.get<string>("INSTALL_SCRIPT_PATH") ??
      fallback;
  }

  /**
   * GET /install — return the install script as text/x-shellscript.
   *
   * `@Public()` because `curl | bash` has no auth context. The WhatsApp
   * approval gate inside the script (Stage 4) is the drive-by defense,
   * not endpoint auth.
   */
  @Get("install")
  @Public()
  @Header("Content-Type", "text/x-shellscript; charset=utf-8")
  @Header("Cache-Control", "public, max-age=60, must-revalidate")
  @Header("X-Content-Type-Options", "nosniff")
  serveInstallScript(): string {
    if (!existsSync(this.installScriptPath)) {
      // Class-C: fail closed. If the script isn't on disk we'd rather 404
      // than ship a half-rendered file to the user's shell.
      throw new NotFoundException(
        `install.sh not found at ${this.installScriptPath}. ` +
          `Set ROKIBRAIN_INSTALL_SCRIPT in BFF env.`,
      );
    }
    // Read fresh per request so a redeploy of install.sh propagates without
    // a BFF restart. The file is ~600 lines — cost is negligible.
    return readFileSync(this.installScriptPath, "utf8");
  }
}
