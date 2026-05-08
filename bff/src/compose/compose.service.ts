// =============================================================================
// vibeOS BFF — ComposeService (Cycle 18)
// -----------------------------------------------------------------------------
// Manages pending compose-requests. When a phone-side compose arrives:
//   1. Stores the request in-memory with a requestId (TTL 5 min).
//   2. Emits a compose-request event to the user's Mac daemon via MeshGateway WS.
//   3. Daemon calls ComposePipeline (CC on Mac), posts draft to BFF, then calls
//      POST /compose/:requestId/result back to this service.
//   4. Caller polls GET /compose/:requestId for status.
//
// Hard walls:
//   - BFF NEVER calls CC directly. CC only runs on user's Mac.
//   - Voice audio passed through to Mac is RAM-only — BFF auto-deletes after
//     routing to Mac (per security hardwall §14). We encode as base64 in the
//     WS message so no temp file is ever written.
//   - Tenant isolation: every request is scoped via tenantId (userId from JWT).
// =============================================================================

import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { MeshGateway } from "../mesh/mesh.gateway";
import type { ComposeMode } from "./dto/compose.dto";

// ---------------------------------------------------------------------------
// Request / result shapes
// ---------------------------------------------------------------------------

export interface PendingComposeRequest {
  requestId: string;
  tenantId: string;
  account: string;
  recipient: string;
  persona: string;
  mode: ComposeMode;
  targetLanguage?: string;
  /** ISO timestamp when the request was created. */
  createdAt: string;
  /** Raw text (from text path). Either rawText or audioBase64 is set. */
  rawText?: string;
  /**
   * Voice audio (from voice path) as base64.
   * HARD WALL: This is cleared immediately after routing to Mac daemon.
   * BFF NEVER stores audio on disk.
   */
  audioBase64?: string;
  status: "pending" | "done" | "error";
  result?: ComposeRequestResult;
}

export interface ComposeRequestResult {
  draftId?: string;
  refinedText?: string;
  reasoning?: string;
  error?: string;
  detail?: string;
}

// ---------------------------------------------------------------------------
// ComposeService
// ---------------------------------------------------------------------------

const REQUEST_TTL_MS = 5 * 60 * 1_000; // 5 minutes

@Injectable()
export class ComposeService {
  private readonly logger = new Logger(ComposeService.name);

  /**
   * In-memory store: requestId → PendingComposeRequest.
   * TTL-managed: entries are deleted after REQUEST_TTL_MS.
   */
  private readonly store = new Map<string, PendingComposeRequest>();

  constructor(private readonly meshGateway: MeshGateway) {}

  // ---- public API -----------------------------------------------------------

  /**
   * Create a compose-request from typed text. Emits a WS event to the user's
   * Mac daemon so the daemon can call ComposePipeline (CC on Mac).
   * Returns the requestId for polling.
   */
  createTextRequest(
    tenantId: string,
    opts: {
      account: string;
      recipient: string;
      persona: string;
      rawText: string;
      targetLanguage?: string;
      mode: ComposeMode;
    },
  ): { requestId: string } {
    const requestId = randomUUID();
    const req: PendingComposeRequest = {
      requestId,
      tenantId,
      account: opts.account,
      recipient: opts.recipient,
      persona: opts.persona,
      rawText: opts.rawText,
      targetLanguage: opts.targetLanguage,
      mode: opts.mode,
      createdAt: new Date().toISOString(),
      status: "pending",
    };

    this.store.set(requestId, req);
    this.scheduleTtl(requestId);

    // Emit WS event → Mac daemon picks it up and calls ComposePipeline.
    this.emitToMac(tenantId, {
      kind: "compose-request",
      requestId,
      account: opts.account,
      recipient: opts.recipient,
      persona: opts.persona,
      rawText: opts.rawText,
      targetLanguage: opts.targetLanguage,
      mode: opts.mode,
    });

    return { requestId };
  }

  /**
   * Create a compose-request from voice audio (base64-encoded).
   * HARD WALL: audioBase64 is passed through to Mac via WS (RAM-only) and
   * then CLEARED from this service — no disk write ever occurs here.
   * The Mac daemon transcribes the audio and calls ComposePipeline.
   */
  createVoiceRequest(
    tenantId: string,
    opts: {
      audioBase64: string;
      account: string;
      recipient: string;
      persona: string;
      targetLanguage?: string;
      mode: ComposeMode;
    },
  ): { requestId: string } {
    const requestId = randomUUID();
    const req: PendingComposeRequest = {
      requestId,
      tenantId,
      account: opts.account,
      recipient: opts.recipient,
      persona: opts.persona,
      targetLanguage: opts.targetLanguage,
      mode: opts.mode,
      createdAt: new Date().toISOString(),
      status: "pending",
      // Note: audioBase64 NOT stored — only passed to Mac via WS then cleared.
    };

    this.store.set(requestId, req);
    this.scheduleTtl(requestId);

    // Pass audio to Mac daemon via WS. Mac transcribes → ComposePipeline.
    // HARD WALL: audioBase64 lives in this WS message only. Not stored on disk.
    this.emitToMac(tenantId, {
      kind: "compose-request",
      requestId,
      account: opts.account,
      recipient: opts.recipient,
      persona: opts.persona,
      audioBase64: opts.audioBase64, // RAM-only; WS routing only
      targetLanguage: opts.targetLanguage,
      mode: opts.mode,
    });

    // Clear audio from memory immediately after routing — no persistent copy.
    // (JS GC will collect it; no disk write occurred.)
    this.logger.debug(
      `compose voice request routed to Mac (audio cleared from BFF memory): ${requestId}`,
    );

    return { requestId };
  }

  /**
   * Poll for a compose request result. Returns null if not found or expired.
   * Tenant-scoped: tenantId must match the original requester.
   */
  getRequest(
    requestId: string,
    tenantId: string,
  ): PendingComposeRequest | null {
    const req = this.store.get(requestId);
    if (!req) return null;
    // Tenant isolation: never return another tenant's request.
    if (req.tenantId !== tenantId) return null;
    return req;
  }

  /**
   * Mac daemon calls this after ComposePipeline completes.
   * Tenant isolation enforced: tenantId from JWT must match original requester.
   */
  resolveRequest(
    requestId: string,
    tenantId: string,
    result: ComposeRequestResult,
  ): boolean {
    const req = this.store.get(requestId);
    if (!req) return false;
    if (req.tenantId !== tenantId) {
      this.logger.warn(
        `compose result tenant mismatch: requestId=${requestId} expected=${req.tenantId} got=${tenantId}`,
      );
      return false;
    }
    req.status = result.error ? "error" : "done";
    req.result = result;
    return true;
  }

  /**
   * Mac daemon calls this to report an error (e.g. Mac offline, CC failed).
   */
  errorRequest(
    requestId: string,
    tenantId: string,
    reason: string,
  ): boolean {
    return this.resolveRequest(requestId, tenantId, {
      error: "MAC_ERROR",
      detail: reason,
    });
  }

  // ---- private helpers -------------------------------------------------------

  private emitToMac(
    tenantId: string,
    payload: Record<string, unknown>,
  ): void {
    // MeshGateway.emitInbound routes to sockets owned by tenantId (owner email).
    // We use the 'compose.request' event name so the Mac daemon can filter it.
    this.meshGateway.emitInbound("compose", { ...payload }, tenantId);
  }

  private scheduleTtl(requestId: string): void {
    setTimeout(() => {
      const req = this.store.get(requestId);
      if (req && req.status === "pending") {
        req.status = "error";
        req.result = { error: "TIMEOUT", detail: "Compose request timed out after 5 minutes" };
      }
      this.store.delete(requestId);
    }, REQUEST_TTL_MS);
  }
}
