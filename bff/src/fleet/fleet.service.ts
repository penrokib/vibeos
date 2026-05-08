import { randomBytes } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "@vibeos/database";
import { AuditService } from "../audit/audit.service";
import { TailscaleService } from "../enrollment/tailscale.service";
import type { HeartbeatDto } from "./dto/heartbeat.dto";
import {
  buildHeartbeatHmacPayload,
  computeHeartbeatHmac,
  verifyHeartbeatHmac,
} from "./hmac.util";
import type {
  ApproveEnrollmentDto,
  EnrollMachineDto,
  ListMachinesDto,
  RejectEnrollmentDto,
} from "./dto/machine.dto";

const DEFAULT_TAKE = 100;
const MAX_TAKE = 500;

/** A machine is "alive" if its last heartbeat was within this window. */
const ALIVE_WINDOW_MS = 10 * 60 * 1000; // 10 min

/**
 * Heartbeats arrive on a 5-min cron, but a machine may misfire and double-post.
 * We rate-limit to 1 heartbeat per minute per machine to keep `fleet_heartbeats`
 * from ballooning. Rejected heartbeats return 429 Too Many Requests upstream
 * (we throw HttpException-equivalent — but at this layer we throw a plain
 * BadRequest so the controller can map it).
 */
const HEARTBEAT_MIN_INTERVAL_MS = 60 * 1000;

@Injectable()
export class FleetService {
  private readonly logger = new Logger(FleetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tailscale: TailscaleService,
  ) {}

  // ─── Heartbeat ───────────────────────────────────────────────────────

  /**
   * Record a heartbeat from `machineId`. Per Hard Wall #1 (rate-limit), reject
   * if the previous heartbeat landed less than HEARTBEAT_MIN_INTERVAL_MS ago.
   *
   * Returns the machine record with updated `lastHeartbeatAt` so the caller
   * can echo what the brain now believes.
   *
   * Throws:
   *   - 401 (UnauthorizedException): machineId not enrolled.
   *   - 429-equiv (BadRequestException with rate-limit code): too soon.
   *   - 400 (BadRequestException): payload mismatch (machineId in body !=
   *     machineId in token claim, when HMAC lands).
   */
  async recordHeartbeat(dto: HeartbeatDto, signature?: string) {
    const machine = await this.prisma.fleetMachine.findUnique({
      where: { machineId: dto.machineId },
    });
    if (!machine) {
      // Class-C: don't let an unenrolled machine pollute the heartbeat log.
      throw new UnauthorizedException(
        "machine not enrolled — call POST /fleet/enroll first",
      );
    }

    // ─── HMAC verification ────────────────────────────────────────────
    // FLEET_HMAC_REQUIRED gates strict mode. During the rollout window
    // (M3/M1/Win cron scripts being upgraded over the night), strict
    // mode is OFF and we log a warning per missing/invalid signature
    // so we can watch the upgrade complete in the audit log without
    // blackholing existing cron heartbeats. Flip the env var once
    // every machine emits the header.
    const hmacRequired = process.env.FLEET_HMAC_REQUIRED === "true";
    const hmacResult = this.verifyHeartbeatSignature(
      machine.heartbeatSecret,
      dto,
      signature,
    );
    if (!hmacResult.ok) {
      // Audit every failure so the dashboard can surface "machine X is
      // emitting bad signatures" — actor is the machine itself, not Roki.
      void this.audit.record(
        `machine:${dto.machineId}`,
        "fleet.heartbeat.hmacFailed",
        machine.id,
        { reason: hmacResult.reason },
      );

      if (hmacRequired) {
        throw new UnauthorizedException({
          code: "hmac_mismatch",
          message: "heartbeat HMAC verification failed",
          reason: hmacResult.reason,
        });
      }

      // Stub-fallback mode: log loudly so the migration period is visible
      // in the BFF log stream, but allow the heartbeat to proceed so the
      // existing cron scripts don't break overnight.
      this.logger.warn(
        `heartbeat HMAC ${hmacResult.reason} for machineId=${dto.machineId} ` +
          `(FLEET_HMAC_REQUIRED!=true; allowing). Upgrade the client.`,
      );
    }

    const now = new Date();
    if (machine.lastHeartbeatAt) {
      const elapsed = now.getTime() - machine.lastHeartbeatAt.getTime();
      if (elapsed < HEARTBEAT_MIN_INTERVAL_MS) {
        // Use a sentinel error code in the message so an upstream filter
        // can map it to 429. Keeping HTTP layer pure-ish per Dewx pattern.
        throw new BadRequestException({
          code: "rate_limited",
          message: `heartbeat too soon (last was ${elapsed}ms ago, min ${HEARTBEAT_MIN_INTERVAL_MS}ms)`,
          retryAfterMs: HEARTBEAT_MIN_INTERVAL_MS - elapsed,
        });
      }
    }

    // Cap accountQuota size defensively — class-validator caps individual
    // fields but JSON.stringify of a runaway nested object could still bloat.
    const accountQuotaJson = dto.accountQuota as unknown as Prisma.InputJsonValue;

    const [_heartbeat, updatedMachine] = await this.prisma.$transaction([
      this.prisma.fleetHeartbeat.create({
        data: {
          machineId: dto.machineId,
          personaCount: dto.personaCount,
          tmuxSessionCount: dto.tmuxSessionCount,
          ramGb: dto.ramGb,
          cpuLoad: dto.cpuLoad,
          accountQuota: accountQuotaJson,
          lastActivePersona: dto.lastActivePersona ?? null,
          receivedAt: now,
        },
      }),
      this.prisma.fleetMachine.update({
        where: { machineId: dto.machineId },
        data: {
          lastHeartbeatAt: now,
          // Soft-update the fields a machine may report (hostname can shift on
          // VM rebuild; tailscaleIp shifts on tailnet relog). Keep machineId +
          // role + account immutable (those are set at enrollment).
          hostname: dto.hostname,
          hostAlias: dto.hostAlias ?? machine.hostAlias,
          publicIp: dto.publicIp ?? machine.publicIp,
          tailscaleIp: dto.tailscaleIp ?? machine.tailscaleIp,
        },
      }),
    ]);

    return updatedMachine;
  }

  // ─── Machines (read) ─────────────────────────────────────────────────

  list(filter: ListMachinesDto = {}) {
    const where: Prisma.FleetMachineWhereInput = {};
    if (filter.role) where.role = filter.role;
    if (filter.account) where.account = filter.account;

    const take = Math.min(filter.take ?? DEFAULT_TAKE, MAX_TAKE);
    return this.prisma.fleetMachine.findMany({
      where,
      orderBy: { enrolledAt: "desc" },
      take,
      // Never expose the heartbeat HMAC secret over the API.
      select: this.machineSelectPublic(),
    });
  }

  async get(id: string) {
    const machine = await this.prisma.fleetMachine.findUnique({
      where: { id },
      select: this.machineSelectPublic(),
    });
    if (!machine) throw new NotFoundException("machine not found");
    return machine;
  }

  /**
   * Aggregate health: how many machines are alive (heartbeat in last 10 min)
   * vs total enrolled. Used by the dashboard banner + supervisor.
   */
  async health() {
    const total = await this.prisma.fleetMachine.count();
    const aliveSince = new Date(Date.now() - ALIVE_WINDOW_MS);
    const alive = await this.prisma.fleetMachine.count({
      where: { lastHeartbeatAt: { gte: aliveSince } },
    });
    return {
      total,
      alive,
      stale: total - alive,
      aliveWindowMs: ALIVE_WINDOW_MS,
      checkedAt: new Date().toISOString(),
    };
  }

  // ─── Enrollment ───────────────────────────────────────────────────────

  /**
   * Step 1 of the install flow. Creates a FleetEnrollment in `pending_approval`.
   * Idempotent on `(machineId, status='pending_approval')` — re-running install
   * on the same machine returns the existing pending row instead of stacking.
   *
   * Returns `{ enrollmentId, status, whatsappDraft }`. The whatsappDraft is a
   * MESSAGE BODY ONLY — never auto-sent (per Hard Wall #4). Roki / the
   * orchestrator decides when to fire it.
   */
  async enroll(dto: EnrollMachineDto) {
    // If a machine is already enrolled (FleetMachine row exists), reject —
    // re-enrollment must go through `uninstall` first.
    const existing = await this.prisma.fleetMachine.findUnique({
      where: { machineId: dto.machineId },
    });
    if (existing) {
      throw new ConflictException(
        `machine ${dto.machineId} is already enrolled — run uninstall first`,
      );
    }

    // Coalesce duplicate pending requests so retries don't stack.
    const pending = await this.prisma.fleetEnrollment.findFirst({
      where: { machineId: dto.machineId, status: "pending_approval" },
      orderBy: { createdAt: "desc" },
    });
    if (pending) {
      return {
        enrollmentId: pending.id,
        status: pending.status,
        whatsappDraft: this.buildApprovalWhatsappDraft(pending.id, dto),
      };
    }

    const created = await this.prisma.fleetEnrollment.create({
      data: {
        machineId: dto.machineId,
        hostname: dto.hostname,
        os: dto.os,
        publicKey: dto.publicKey,
        requestedRole: dto.requestedRole ?? null,
        status: "pending_approval",
      },
    });

    await this.audit.record(
      `machine:${dto.machineId}`,
      "fleet.enrollment.requested",
      created.id,
      { hostname: dto.hostname, os: dto.os, requestedRole: dto.requestedRole ?? null },
    );

    return {
      enrollmentId: created.id,
      status: created.status,
      // DRAFT ONLY — never sent. Caller (Tab 1 orchestrator) decides whether
      // to forward to WhatsApp via the WA-MY MCP bridge.
      whatsappDraft: this.buildApprovalWhatsappDraft(created.id, dto),
    };
  }

  /**
   * Step 2 — install.sh polls this until status flips to `approved`.
   * On the FIRST `approved` read, returns the secrets bundle and nulls
   * `tailscaleAuthkey` (per Hard Wall #2: NEVER expose tailscale_authkey
   * after first read). Subsequent reads return `secretsAlreadyFetched: true`.
   */
  async getEnrollment(id: string) {
    const enrollment = await this.prisma.fleetEnrollment.findUnique({
      where: { id },
    });
    if (!enrollment) throw new NotFoundException("enrollment not found");

    if (enrollment.status === "pending_approval") {
      return { id: enrollment.id, status: enrollment.status };
    }
    if (enrollment.status === "rejected") {
      return {
        id: enrollment.id,
        status: enrollment.status,
        rejectedAt: enrollment.approvedAt, // approvedAt doubles as decided-at
      };
    }
    // status === "approved"
    if (enrollment.secretsFetchedAt) {
      // Replay attempt — secrets already pulled. Return status only.
      return {
        id: enrollment.id,
        status: enrollment.status,
        secretsAlreadyFetched: true,
        secretsFetchedAt: enrollment.secretsFetchedAt,
      };
    }

    // First fetch — return the secrets, then null the authkey atomically.
    const secrets = {
      tailscaleAuthkey: enrollment.tailscaleAuthkey,
      sshKeys: (enrollment.sshKeys ?? []) as unknown,
      personaAssignments: (enrollment.personaAssignments ?? []) as unknown,
      account: enrollment.account,
    };

    await this.prisma.fleetEnrollment.update({
      where: { id },
      data: {
        tailscaleAuthkey: null,
        secretsFetchedAt: new Date(),
      },
    });

    await this.audit.record(
      `machine:${enrollment.machineId}`,
      "fleet.enrollment.secretsFetched",
      enrollment.id,
    );

    return {
      id: enrollment.id,
      status: enrollment.status,
      ...secrets,
    };
  }

  /**
   * Admin/Roki approves an enrollment. Generates the heartbeat HMAC secret,
   * stores it on the new FleetMachine row, and stamps the FleetEnrollment
   * with `approved` + the secrets bundle (which the install script will
   * fetch exactly once via `getEnrollment`).
   *
   * Wrapped in a transaction — if FleetMachine creation fails, the
   * enrollment stays pending so we can retry.
   */
  async approveEnrollment(
    actor: string,
    id: string,
    dto: ApproveEnrollmentDto,
  ) {
    const enrollment = await this.prisma.fleetEnrollment.findUnique({
      where: { id },
    });
    if (!enrollment) throw new NotFoundException("enrollment not found");
    if (enrollment.status !== "pending_approval") {
      throw new BadRequestException(
        `enrollment is ${enrollment.status}; only pending_approval can be approved`,
      );
    }

    // Defense-in-depth: the same machineId must not have an active
    // FleetMachine row (race with a parallel approval). Conflict if so.
    const conflict = await this.prisma.fleetMachine.findUnique({
      where: { machineId: enrollment.machineId },
    });
    if (conflict) {
      throw new ConflictException(
        `machineId ${enrollment.machineId} already has a FleetMachine row`,
      );
    }

    const role = dto.role ?? enrollment.requestedRole ?? "worker";
    const heartbeatSecret = randomBytes(32).toString("hex");
    // If Roki pasted a key in the dto, use it (escape-hatch for emergencies).
    // Otherwise mint via the Tailscale API (or stub-fallback if env missing).
    let tailscaleAuthkey: string | null = dto.tailscaleAuthkey ?? null;
    let tailscaleKeyId: string | null = null;
    let tailscaleStub = false;
    if (!tailscaleAuthkey) {
      const minted = await this.tailscale.mintAuthKey({
        role,
        extraTags: [`tag:role-${role}`, `tag:account-${dto.account}`],
      });
      tailscaleAuthkey = minted.key;
      tailscaleKeyId = minted.id;
      tailscaleStub = minted.stub;
    }

    const now = new Date();

    const [, updated] = await this.prisma.$transaction([
      this.prisma.fleetMachine.create({
        data: {
          machineId: enrollment.machineId,
          hostname: enrollment.hostname,
          hostAlias: dto.hostAlias ?? null,
          os: enrollment.os,
          publicKey: enrollment.publicKey,
          role,
          account: dto.account,
          heartbeatSecret,
          enrolledAt: now,
        },
      }),
      this.prisma.fleetEnrollment.update({
        where: { id },
        data: {
          status: "approved",
          approvedBy: actor,
          approvedAt: now,
          tailscaleAuthkey,
          sshKeys: dto.sshKeys as unknown as Prisma.InputJsonValue,
          personaAssignments:
            dto.personaAssignments as unknown as Prisma.InputJsonValue,
          account: dto.account,
        },
      }),
    ]);

    await this.audit.record(actor, "fleet.enrollment.approved", id, {
      machineId: enrollment.machineId,
      role,
      account: dto.account,
      personaCount: dto.personaAssignments.length,
      // NEVER record the auth-key. Only the Tailscale-side id (or stub flag)
      // so the audit trail can be cross-referenced against the Tailscale
      // dashboard for retroactive revocation.
      tailscaleKeyId,
      tailscaleStub,
      tailscaleManuallyProvided: !!dto.tailscaleAuthkey,
    });

    return {
      enrollmentId: updated.id,
      status: updated.status,
      machineId: enrollment.machineId,
      role,
      account: dto.account,
    };
  }

  async rejectEnrollment(
    actor: string,
    id: string,
    dto: RejectEnrollmentDto,
  ) {
    const enrollment = await this.prisma.fleetEnrollment.findUnique({
      where: { id },
    });
    if (!enrollment) throw new NotFoundException("enrollment not found");
    if (enrollment.status !== "pending_approval") {
      throw new BadRequestException(
        `enrollment is ${enrollment.status}; only pending_approval can be rejected`,
      );
    }

    const updated = await this.prisma.fleetEnrollment.update({
      where: { id },
      data: {
        status: "rejected",
        approvedBy: actor,
        approvedAt: new Date(),
      },
    });

    await this.audit.record(actor, "fleet.enrollment.rejected", id, {
      machineId: enrollment.machineId,
      reason: dto.reason ?? null,
    });

    return {
      enrollmentId: updated.id,
      status: updated.status,
    };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  /**
   * Compute the canonical HMAC payload, MAC it with the machine's
   * stored secret, and constant-time compare against `signature`.
   *
   * Returns a discriminated result so the caller can decide whether to
   * 401 (strict mode) or warn-and-pass (rollout mode). We deliberately
   * return distinct `reason` codes so the audit log distinguishes
   * "client never set up HMAC yet" from "client sent wrong signature".
   */
  private verifyHeartbeatSignature(
    heartbeatSecret: string | null,
    dto: HeartbeatDto,
    signature: string | undefined,
  ): { ok: true } | { ok: false; reason: string } {
    if (!heartbeatSecret) {
      // Older FleetMachine rows that pre-date the HMAC migration may
      // have a null secret. Treat as "not yet enrolled with HMAC" —
      // strict mode rejects, rollout mode warns.
      return { ok: false, reason: "machine_missing_secret" };
    }
    if (!signature) {
      return { ok: false, reason: "missing_signature_header" };
    }
    if (dto.lastHeartbeatId === undefined || dto.receivedAt === undefined) {
      // The HMAC payload binds these — without them the signature can't
      // be reconstructed. Reject as "missing_payload_fields" so the
      // operator sees which side of the upgrade is incomplete.
      return { ok: false, reason: "missing_payload_fields" };
    }
    const payload = buildHeartbeatHmacPayload({
      machineId: dto.machineId,
      lastHeartbeatId: dto.lastHeartbeatId,
      receivedAt: dto.receivedAt,
    });
    const expected = computeHeartbeatHmac(payload, heartbeatSecret);
    if (!verifyHeartbeatHmac(expected, signature)) {
      return { ok: false, reason: "signature_mismatch" };
    }
    return { ok: true };
  }

  /**
   * Drop the HMAC secret from FleetMachine reads. We use an explicit
   * `select` instead of post-processing so an accidental schema-add
   * doesn't silently leak fields — Class-C "fail closed".
   */
  private machineSelectPublic(): Prisma.FleetMachineSelect {
    return {
      id: true,
      machineId: true,
      hostname: true,
      hostAlias: true,
      os: true,
      publicIp: true,
      tailscaleIp: true,
      publicKey: true,
      role: true,
      account: true,
      enrolledAt: true,
      lastHeartbeatAt: true,
      // explicitly omitted: heartbeatSecret
    };
  }

  /**
   * Build the WhatsApp message Roki will see when an enrollment lands.
   * DRAFT only — emitted as a string for the orchestrator to forward.
   * Per Hard Wall #4 (whatsapp gate): never auto-sent from the BFF.
   */
  private buildApprovalWhatsappDraft(
    enrollmentId: string,
    dto: EnrollMachineDto,
  ): string {
    const link = `https://app.rokibrain.com/agency/fleet/enrollment/${enrollmentId}`;
    return [
      "New machine wants to join the fleet:",
      `  hostname: ${dto.hostname}`,
      `  os:       ${dto.os}`,
      `  machine:  ${dto.machineId.slice(0, 16)}…`,
      `  role:     ${dto.requestedRole ?? "(unspecified)"}`,
      "",
      `Approve: ${link}`,
    ].join("\n");
  }
}
