// =============================================================================
// rokibrain.app — daemon shared types (M02)
// -----------------------------------------------------------------------------
// Shared between supervisor, ws-server, anti-ban, and child impls. Renderer
// imports the externally-visible subset via shared/ipc-contracts.ts.
// =============================================================================

/** Lifecycle of a supervised child process. */
export type ChildState =
  | 'idle' // never started
  | 'starting' // start() in flight
  | 'running' // healthy
  | 'crashing' // exited unexpectedly, awaiting backoff
  | 'restarting' // backoff elapsed, restart in flight
  | 'stopping' // graceful stop requested
  | 'stopped' // stopped cleanly (operator or app shutdown)
  | 'paused' // emergency-stopped, refuses new starts
  | 'permanently-failed'; // circuit-breaker tripped — needs explicit unlock()

export interface HealthStatus {
  ok: boolean;
  /** Optional human-readable message; surfaced to UI via daemon:status. */
  detail?: string;
  /** Lightweight metrics (rss bytes, cpu pct, lastMsgTs ms) — child-specific. */
  metrics?: Record<string, number | string | boolean>;
}

export interface ChildStatus {
  id: string;
  platform: string;
  state: ChildState;
  /** Total restart count across the supervisor's lifetime. */
  restartCount: number;
  /** Crashes within the rolling 60s window — drives circuit breaker. */
  recentCrashCount: number;
  /** ISO8601 of last state change. */
  changedAt: string;
  /** Last error message if state ∈ {crashing, permanently-failed}. */
  lastError?: string;
  /** Next planned restart (ISO8601) when in `crashing`. */
  nextRestartAt?: string;
}

export interface SupervisorStatus {
  wsPort: number;
  uptime: number;
  children: ChildStatus[];
  emergencyStopped: boolean;
}

/** Restart policy — ported semantics from apps/bridge-mac/.../WSClient.swift. */
export interface RestartPolicy {
  /** Initial backoff in ms. Default 1000. */
  initialBackoffMs: number;
  /** Max backoff in ms. Default 5 * 60 * 1000. */
  maxBackoffMs: number;
  /** Multiplicative factor. Default 2. */
  factor: number;
  /** Jitter as a fraction of the computed delay. 0..1. Default 0.2. */
  jitter: number;
  /** Crashes within this rolling window count toward the breaker. Default 60_000ms. */
  windowMs: number;
  /** Trip the breaker after this many crashes inside windowMs. Default 5. */
  maxCrashesInWindow: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  initialBackoffMs: 1_000,
  maxBackoffMs: 5 * 60 * 1_000,
  factor: 2,
  jitter: 0.2,
  windowMs: 60_000,
  maxCrashesInWindow: 5,
};

export interface ResourceCaps {
  /** Max resident memory in bytes; supervisor SIGTERMs the child if exceeded. */
  maxRssBytes: number;
  /** Max sustained CPU percent (0..100); soft warn only in v1. */
  maxCpuPercent: number;
}

export const DEFAULT_RESOURCE_CAPS: ResourceCaps = {
  maxRssBytes: 500 * 1024 * 1024, // 500 MB
  maxCpuPercent: 50,
};

/**
 * Messages flowing between Supervisor and a child impl. Children speak this
 * shape through `BaseMeshChild.handleSupervisorMessage`, regardless of the
 * underlying transport (stdio, child_process.fork, N-API, etc.). Concrete
 * child implementations may layer additional discriminants on top.
 */
export type SupervisorMessage =
  | { kind: 'init'; configJson: string }
  | { kind: 'shutdown'; graceful: boolean }
  | { kind: 'health-probe' }
  | { kind: 'pause' }
  | { kind: 'resume' };

export interface ChildEvent {
  /** Source child id. */
  childId: string;
  type:
    | 'started'
    | 'crashed'
    | 'exited'
    | 'permanently-failed'
    | 'restart-scheduled'
    | 'paused'
    | 'resumed'
    | 'health';
  message?: string;
  data?: unknown;
  ts: string; // ISO8601
}

/**
 * Anti-ban verdict — every outbound action MUST go through `withAntiBan`,
 * which returns this. Children NEVER bypass.
 */
export interface AntiBanVerdict {
  allowed: boolean;
  /** Populated when allowed=false; matches design §3 reason taxonomy. */
  reasons?: string[];
  /** Earliest legal retry; null when allowed=true. */
  nextWindowAt?: string;
  /** Counters returned by BFF for observability. */
  counters?: Record<string, number>;
}

/** WebSocket message envelope between renderer and daemon. */
export interface WsEnvelope<T = unknown> {
  /** Monotonic per-connection sequence number — used for backpressure dedup. */
  seq: number;
  /** Channel/topic — mirrors IPC channel naming (`rb.<domain>.<verb>`). */
  channel: string;
  payload: T;
}
