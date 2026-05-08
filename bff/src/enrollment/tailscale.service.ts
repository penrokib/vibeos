import { randomBytes } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * Tailscale auth-key minter.
 *
 * Production path:
 *   POST https://api.tailscale.com/api/v2/tailnet/{tailnet}/keys
 *   Authorization: HTTP Basic (client_id:client_secret)
 *   {
 *     "capabilities": {
 *       "devices": {
 *         "create": {
 *           "reusable": false,
 *           "ephemeral": false,
 *           "preauthorized": true,
 *           "tags": ["tag:worker", "tag:rokibrain-mesh"]
 *         }
 *       }
 *     },
 *     "expirySeconds": 3600
 *   }
 *
 * Stub fallback: if any of TAILSCALE_OAUTH_CLIENT_ID,
 * TAILSCALE_OAUTH_CLIENT_SECRET, or TAILSCALE_TAILNET is missing we
 * return `tskey-auth-stub-<random-hex>` and log a warning so the
 * install script can still complete its rendezvous loop in dev /
 * pre-prod (and the BFF doesn't crash at module init).
 *
 * Hard walls:
 *   - NEVER hard-code credentials. Source: ConfigService only.
 *   - NEVER log the auth-key after issuance. We log `id` and `expires`
 *     only; the secret leaves this method exactly once via the return
 *     value. Caller writes it to FleetEnrollment.tailscaleAuthkey,
 *     install script reads it once via GET /fleet/enrollment/:id, then
 *     the BFF nulls the column (one-time fetch, see fleet.service).
 */
@Injectable()
export class TailscaleService {
  private readonly logger = new Logger(TailscaleService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Mint a single-use, non-reusable, non-ephemeral, preauthorized auth-key
   * with `expirySeconds`. The key is delivered to the enrolling machine
   * once (via GET /fleet/enrollment/:id) and immediately consumed by
   * `tailscale up --auth-key=…` on the host.
   *
   * Returns:
   *   { key, id, stub } — `key` is the actual auth-key, `id` is the
   *   Tailscale-side key handle (or null in stub mode), `stub` is true
   *   when env was missing so callers can audit appropriately.
   *
   * Throws only if the API call returns an unexpected error in
   * production mode. Stub-mode never throws.
   */
  async mintAuthKey(input: {
    role: string;
    expirySeconds?: number;
    extraTags?: string[];
  }): Promise<{ key: string; id: string | null; stub: boolean }> {
    const clientId = this.config.get<string>("TAILSCALE_OAUTH_CLIENT_ID");
    const clientSecret = this.config.get<string>(
      "TAILSCALE_OAUTH_CLIENT_SECRET",
    );
    const tailnet = this.config.get<string>("TAILSCALE_TAILNET");

    if (!clientId || !clientSecret || !tailnet) {
      this.logger.warn(
        `Tailscale env missing (clientId=${!!clientId} secret=${!!clientSecret} ` +
          `tailnet=${!!tailnet}); returning stub auth-key. ` +
          `Set TAILSCALE_OAUTH_CLIENT_ID + TAILSCALE_OAUTH_CLIENT_SECRET + ` +
          `TAILSCALE_TAILNET to enable real minting.`,
      );
      return {
        key: `tskey-auth-stub-${randomBytes(32).toString("hex")}`,
        id: null,
        stub: true,
      };
    }

    const tags = ["tag:worker", "tag:rokibrain-mesh", ...(input.extraTags ?? [])];
    const body = {
      capabilities: {
        devices: {
          create: {
            reusable: false,
            ephemeral: false,
            preauthorized: true,
            tags,
          },
        },
      },
      expirySeconds: input.expirySeconds ?? 3600,
    };

    const url = `https://api.tailscale.com/api/v2/tailnet/${encodeURIComponent(
      tailnet,
    )}/keys`;
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString(
      "base64",
    );

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      this.logger.error(
        `Tailscale API fetch failed: ${(err as Error).message}`,
      );
      throw err;
    }

    if (!response.ok) {
      // Read the body for diagnostics but log only the status + truncated
      // error string — the response body shouldn't contain a key, but we
      // err on the side of paranoia so a stray log line never includes one.
      const text = await response.text().catch(() => "(unreadable body)");
      this.logger.error(
        `Tailscale API returned ${response.status}: ${text.slice(0, 200)}`,
      );
      throw new Error(`Tailscale auth-key mint failed: HTTP ${response.status}`);
    }

    const json = (await response.json()) as { id?: string; key?: string };
    if (typeof json.key !== "string" || json.key.length === 0) {
      throw new Error("Tailscale API returned no `key` field");
    }

    // Log id + the fact we minted, but NEVER the key itself. The id is
    // useful for retroactive revocation via the Tailscale dashboard.
    this.logger.log(
      `Minted Tailscale auth-key id=${json.id ?? "?"} for role=${input.role} ` +
        `tags=${tags.join(",")} expirySeconds=${body.expirySeconds}`,
    );

    return { key: json.key, id: json.id ?? null, stub: false };
  }
}
