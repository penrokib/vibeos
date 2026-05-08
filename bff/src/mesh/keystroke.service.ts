import { ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "@vibeos/database";
import { MeshGateway } from "./mesh.gateway";
import type { KeystrokeResponseDto } from "./dto/keystroke.dto";

/**
 * KeystrokeService — routes a validated keystroke payload from iOS to the
 * target device's tmux pane via the MeshGateway WS channel.
 *
 * Hardwalls:
 *   - Tenant isolation enforced: deviceId MUST belong to the calling tenant's
 *     ownerEmail. Cross-tenant sends return 403 before touching WS.
 *   - Empty keys are refused before dispatch (validated by KeystrokeDto).
 *   - The cc-modal hardwall (assertSafeTmuxKeystroke) runs server-side inside
 *     the desktop daemon TmuxChild.input(). The BFF does NOT duplicate it here
 *     (single enforcement point per architecture); the daemon refusal surfaces
 *     back through the WS event and is relayed as accepted:false.
 *   - This service NEVER calls the daemon directly; it only emits via WS.
 *     The daemon picks up `tmux-input` events and applies its own hardwalls.
 */
@Injectable()
export class KeystrokeService {
  private readonly logger = new Logger(KeystrokeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: MeshGateway,
  ) {}

  /**
   * Send `keys` to `paneId` on `deviceId`.
   *
   * Tenant isolation: the device's `ownerEmail` must match the JWT's email.
   * Returns `{ accepted: false, refusedReason: "DEVICE_NOT_FOUND" }` for
   * unknown/cross-tenant devices (does not reveal ownership via 404).
   */
  async sendKeystroke(
    ownerEmail: string,
    deviceId: string,
    paneId: string,
    keys: string,
  ): Promise<KeystrokeResponseDto> {
    // Tenant isolation check: look up device and verify ownership.
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { id: true, ownerEmail: true },
    });

    if (!device || device.ownerEmail.toLowerCase() !== ownerEmail.toLowerCase()) {
      // Intentionally vague — do not reveal cross-tenant ownership.
      throw new ForbiddenException("device_not_found_or_access_denied");
    }

    // Emit the keystroke event to the connected daemon WS socket.
    // The daemon's TmuxChild.input() will run assertSafeTmuxKeystroke server-side.
    // If the daemon is offline the gateway has no connected sockets — we treat
    // that as BFF_UNREACHABLE (accepted:false) rather than silently discarding.
    const connectedSockets = this.gateway.clientCount(ownerEmail);
    if (connectedSockets === 0) {
      this.logger.warn(
        `keystroke: no connected daemon sockets for owner=${ownerEmail} deviceId=${deviceId}`,
      );
      return {
        accepted: false,
        refusedReason: "BFF_UNREACHABLE",
      };
    }

    // Emit `tmux-input` event to the owner's daemon sockets.
    // The daemon picks it up, routes to TmuxChild.input(paneId, keys),
    // which calls assertSafeTmuxKeystroke — cc-modal hardwall enforced there.
    this.gateway.emitTmuxInput(ownerEmail, { deviceId, paneId, keys });

    this.logger.log(
      `keystroke: dispatched deviceId=${deviceId} paneId=${paneId} owner=${ownerEmail}`,
    );

    return { accepted: true };
  }
}
