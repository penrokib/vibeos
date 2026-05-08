// =============================================================================
// rokibrain.app — BaseMeshChild abstract (M02)
// -----------------------------------------------------------------------------
// Every supervised child (whatsmeow wa, tdlib tg, discord, email, whisper,
// chromium-cdp, tmux-bridge) extends BaseMeshChild. Module agents M04+ plug in
// concrete subclasses. M02 ships only this contract + a NoOpChild for tests.
//
// Hardwall contract:
//   - `start()` MUST be idempotent (calling twice during state=running is a no-op).
//   - `stop(graceful)` MUST resolve within 10s; if not, supervisor SIGKILLs.
//   - All outbound platform actions MUST be wrapped in `withAntiBan(...)` from
//     `./anti-ban.ts`. Children that skip this fail review.
// =============================================================================

import type {
  ChildEvent,
  HealthStatus,
  ResourceCaps,
  RestartPolicy,
  SupervisorMessage,
} from './types';

export interface ChildContext {
  /** Stable id within this Supervisor instance — also used as log filename. */
  readonly id: string;
  /** Platform tag — 'whatsapp' | 'telegram' | … | 'tmux' | 'voice' | 'noop'. */
  readonly platform: string;
  /** Per-child override of restart policy; supervisor falls back to defaults. */
  readonly restartPolicy?: Partial<RestartPolicy>;
  /** Per-child override of resource caps. */
  readonly resourceCaps?: Partial<ResourceCaps>;
  /** Optional structured config blob handed to the child via init message. */
  readonly initConfig?: Record<string, unknown>;
}

/**
 * Subclasses implement all four lifecycle methods. The Supervisor never
 * inspects child internals — only invokes the methods and listens to events
 * via `onEvent`.
 */
export abstract class BaseMeshChild {
  readonly id: string;
  readonly platform: string;

  private eventListeners = new Set<(evt: ChildEvent) => void>();

  protected constructor(ctx: ChildContext) {
    this.id = ctx.id;
    this.platform = ctx.platform;
  }

  /** Spawn the underlying process / open the connection. Idempotent. */
  abstract start(): Promise<void>;

  /**
   * Request stop. `graceful=true` → SIGTERM-equivalent + drain. `graceful=false`
   * → immediate SIGKILL-equivalent. MUST resolve within 10s either way.
   */
  abstract stop(graceful: boolean): Promise<void>;

  /** Quick health probe; called every 30s by supervisor. */
  abstract health(): Promise<HealthStatus>;

  /** Pass-through messages from Supervisor (init, pause, resume, etc.). */
  abstract handleSupervisorMessage(msg: SupervisorMessage): Promise<void>;

  // ---- event plumbing (supervisor subscribes; children emit) ----------------

  onEvent(listener: (evt: ChildEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  protected emit(
    type: ChildEvent['type'],
    extra?: Pick<ChildEvent, 'message' | 'data'>,
  ): void {
    const evt: ChildEvent = {
      childId: this.id,
      type,
      ts: new Date().toISOString(),
      ...(extra?.message !== undefined ? { message: extra.message } : {}),
      ...(extra?.data !== undefined ? { data: extra.data } : {}),
    };
    for (const l of this.eventListeners) {
      try {
        l(evt);
      } catch (err) {
        // Never let a listener crash the child.
        // eslint-disable-next-line no-console
        console.error(`[BaseMeshChild ${this.id}] listener threw`, err);
      }
    }
  }
}

/**
 * Factory signature — used by the child registry. M04+ register their
 * concrete subclasses by platform name. Kept loose (Promise<BaseMeshChild>)
 * because some children (tdlib N-API addon) may need async load.
 */
export type ChildFactory = (ctx: ChildContext) => Promise<BaseMeshChild>;

/**
 * Empty registry — M04+ extend by calling `registerChildFactory(...)`. This
 * file ships the contract only; no real platforms yet.
 */
const factories = new Map<string, ChildFactory>();

export function registerChildFactory(platform: string, factory: ChildFactory): void {
  if (factories.has(platform)) {
    throw new Error(`child factory for platform '${platform}' already registered`);
  }
  factories.set(platform, factory);
}

export function getChildFactory(platform: string): ChildFactory | undefined {
  return factories.get(platform);
}

export function listRegisteredPlatforms(): string[] {
  return [...factories.keys()];
}

/** Test-only — clears the registry so each test starts from a clean slate. */
export function __resetChildRegistryForTests(): void {
  factories.clear();
}
