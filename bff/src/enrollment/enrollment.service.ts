import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "@vibeos/database";
import { AuditService } from "../audit/audit.service";
import { TailscaleService } from "./tailscale.service";

const ENROLLMENT_PENDING = "pending_approval";
const ENROLLMENT_APPROVED = "approved";
const ENROLLMENT_REJECTED = "rejected";

/**
 * EnrollmentService — WhatsApp approval gate for new machine enrollments.
 *
 * Pairs with FleetModule's `/fleet/enroll` (Phase 5c). When a machine
 * runs `bin/install.sh`, FleetModule creates a row in `fleet_enrollments`
 * with status=`pending_approval`. This service:
 *   1. Drafts a WhatsApp message for Roki to copy/paste-send.
 *   2. Once Roki replies "approve <id>" via the WA bridge webhook, we
 *      flip status, mint the tailscale auth-key, set persona_assignments.
 *   3. Reject path zeroes out the secret and audits.
 *
 * Why drafts (not auto-send)? The WA bridge is on M1 (Malaysian number for
 * Dewx work, see whatsapp-bridges memory). Until that bridge is finalized,
 * we keep a copy-paste workflow so Roki can shepherd manually. The path to
 * full auto-send is documented in protocols/voice-grammar.md (numbered choices).
 */
@Injectable()
export class EnrollmentService {
  private readonly logger = new Logger(EnrollmentService.name);
  private readonly draftsDir: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly tailscale: TailscaleService,
  ) {
    const fallbackBrain = resolve(process.cwd(), "../../../rokibrain");
    const brainRoot =
      this.config.get<string>("ROKIBRAIN_ROOT") ?? fallbackBrain;
    this.draftsDir =
      this.config.get<string>("ENROLLMENT_DRAFTS_DIR") ??
      resolve(brainRoot, "personas/ceo/drafts");
    try {
      if (!existsSync(this.draftsDir))
        mkdirSync(this.draftsDir, { recursive: true });
    } catch (err) {
      this.logger.warn(
        `enrollment drafts dir not initializable (${(err as Error).message})`,
      );
    }
  }

  /**
   * Draft the WhatsApp approval message and pin it under the CEO persona's
   * drafts folder. Called by FleetModule whenever a new enrollment is created.
   * Idempotent — re-running just rewrites the same draft.
   */
  async draftWaApprovalMessage(enrollmentId: string): Promise<{
    enrollment_id: string;
    draft_path: string;
    body: string;
  }> {
    const enrollment = await this.prisma.fleetEnrollment.findUnique({
      where: { id: enrollmentId },
    });
    if (!enrollment) {
      throw new NotFoundException(`enrollment ${enrollmentId} not found`);
    }
    const role = enrollment.requestedRole ?? "worker";
    const body =
      `New machine ${enrollment.hostname} wants to enroll as ${role}. ` +
      `Reply 'approve ${enrollment.id}' or 'reject ${enrollment.id}'`;

    const draftPath = resolve(
      this.draftsDir,
      `wa-enrollment-approval-${enrollment.id}.md`,
    );
    const md =
      `# WhatsApp enrollment approval — ${enrollment.hostname}\n\n` +
      `**Enrollment ID:** \`${enrollment.id}\`\n` +
      `**Requested role:** ${role}\n` +
      `**OS:** ${enrollment.os}\n` +
      `**Created:** ${enrollment.createdAt.toISOString()}\n` +
      `**Status:** ${enrollment.status}\n\n` +
      `## Send this on WhatsApp\n\n` +
      "```\n" +
      body +
      "\n```\n\n" +
      `## Reply parsing\n\n` +
      `- "approve ${enrollment.id}" → POST /enrollment/wa-approve/${enrollment.id}\n` +
      `- "reject ${enrollment.id}"  → POST /enrollment/wa-reject/${enrollment.id}\n`;

    try {
      await writeFile(draftPath, md, "utf8");
    } catch (err) {
      this.logger.error(
        `failed to write enrollment draft: ${(err as Error).message}`,
      );
    }
    return { enrollment_id: enrollment.id, draft_path: draftPath, body };
  }

  /** GET /enrollment/wa-pending — list enrollments awaiting WA approval. */
  listPending() {
    return this.prisma.fleetEnrollment.findMany({
      where: { status: ENROLLMENT_PENDING },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  /**
   * POST /enrollment/wa-approve/:id — Roki approves via WA reply (webhook
   * from WA bridge). Mints the tailscale auth-key, stamps approved_by/at.
   * Idempotent: re-approving an approved enrollment returns the same row.
   */
  async approve(actor: string, enrollmentId: string) {
    const enrollment = await this.prisma.fleetEnrollment.findUnique({
      where: { id: enrollmentId },
    });
    if (!enrollment) {
      throw new NotFoundException(`enrollment ${enrollmentId} not found`);
    }
    if (enrollment.status === ENROLLMENT_REJECTED) {
      throw new BadRequestException(
        `enrollment ${enrollmentId} was rejected; cannot approve`,
      );
    }
    if (enrollment.status === ENROLLMENT_APPROVED) {
      // Idempotent re-approve — return current state without minting a new key.
      return enrollment;
    }

    const role = enrollment.requestedRole ?? "worker";
    // Real Tailscale tailnet-keys API mint with stub fallback (TailscaleService
    // returns `stub: true` if env vars are missing, never throws in stub-mode).
    const minted = await this.tailscale.mintAuthKey({
      role,
      extraTags: [`tag:role-${role}`],
    });

    const personaAssignments = defaultPersonasForRole(role);

    const updated = await this.prisma.fleetEnrollment.update({
      where: { id: enrollmentId },
      data: {
        status: ENROLLMENT_APPROVED,
        approvedBy: actor,
        approvedAt: new Date(),
        tailscaleAuthkey: minted.key,
        personaAssignments,
      },
    });

    // Audit record machineId + enrollmentId + tailscaleKeyId. NEVER the key.
    // Hard wall: the auth-key is one-time-fetch per FleetEnrollment design;
    // this side rail must not give it a second life via the audit log.
    await this.audit.record(actor, "enrollment.approve", enrollmentId, {
      hostname: enrollment.hostname,
      role,
      personaAssignments,
      tailscaleKeyId: minted.id,
      tailscaleStub: minted.stub,
    });
    return updated;
  }

  /** POST /enrollment/wa-reject/:id — Roki rejects via WA reply. */
  async reject(actor: string, enrollmentId: string) {
    const enrollment = await this.prisma.fleetEnrollment.findUnique({
      where: { id: enrollmentId },
    });
    if (!enrollment) {
      throw new NotFoundException(`enrollment ${enrollmentId} not found`);
    }
    if (enrollment.status === ENROLLMENT_APPROVED) {
      throw new BadRequestException(
        `enrollment ${enrollmentId} already approved; cannot reject`,
      );
    }
    if (enrollment.status === ENROLLMENT_REJECTED) {
      // Idempotent.
      return enrollment;
    }

    const updated = await this.prisma.fleetEnrollment.update({
      where: { id: enrollmentId },
      data: {
        status: ENROLLMENT_REJECTED,
        approvedBy: actor,
        approvedAt: new Date(),
        tailscaleAuthkey: null,
      },
    });

    await this.audit.record(actor, "enrollment.reject", enrollmentId, {
      hostname: enrollment.hostname,
    });
    return updated;
  }
}

/**
 * Default persona slug list per role. Stubbed — Phase 5c hooks this up to
 * the persona registry so an enrolling machine can advertise its capability
 * profile (RAM, CPU, GPU) and we pick personas that fit. For now, role-only.
 */
function defaultPersonasForRole(role: string): string[] {
  switch (role) {
    case "orchestrator":
      return ["ceo", "cto", "fleet-ops-c-level"];
    case "scraper":
      return ["ahn-scraper-coordinator-specialist"];
    case "testing":
      return ["bug-summary-specialist"];
    case "worker":
    default:
      return [];
  }
}
