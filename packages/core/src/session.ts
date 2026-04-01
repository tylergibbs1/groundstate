import type { Bridge } from "./bridge.js";
import { ActionSet, type Action } from "./action.js";
import { EntitySet, type Entity, type EntityRef } from "./entity.js";
import type { QueryOptions, QueryRequest } from "./query.js";
import type { GraphDiff, Unsubscribe } from "./reactive.js";
import { TraceView } from "./trace.js";
import type {
  ExecutionStep,
  ExecutionResult,
  ExecutionPlan,
} from "./postcondition.js";
import { SessionError } from "./errors.js";
import { OverlayManager } from "./overlay/index.js";
import { getDefaultLogger, type Logger } from "./logger.js";

/** Diagnostic information about a single action's validity and targets. */
export interface ActionDiagnostics {
  /** The action being inspected. */
  readonly action: Action;
  /** Number of target entities resolved from the current state graph. */
  readonly targetCount: number;
  /** The resolved target entities. */
  readonly targetEntities: readonly Entity[];
  /** Whether the action is likely executable given current state. */
  readonly likelyValid: boolean;
  /** Human-readable reasons explaining the diagnostic result. */
  readonly reasons: readonly string[];
}

/** Handle returned by `session.trace.subscribe()`. Call `unsubscribe()` to stop polling. */
export interface TraceSubscription {
  unsubscribe(): void;
}

/**
 * Criteria for finding elements in the browser page.
 * All fields are optional and combined with AND semantics.
 */
export interface LocatorQuery {
  /** ARIA role to match (e.g. "button", "link"). */
  readonly role?: string;
  /** Visible text content to match. */
  readonly text?: string;
  /** ARIA label or associated `<label>` text. */
  readonly label?: string;
  /** Element title attribute. */
  readonly title?: string;
  /** Input placeholder text. */
  readonly placeholder?: string;
  /** CSS selector to scope the search. */
  readonly selector?: string;
  /** Require exact text match instead of substring (default: false). */
  readonly exact?: boolean;
  /** Maximum number of matches to return (default: 20). */
  readonly limit?: number;
}

/** A DOM element matched by a {@link LocatorQuery}. */
export interface LocatorMatch {
  /** CSS selector that uniquely identifies this element. */
  readonly selector: string;
  /** Visible text content of the element. */
  readonly text: string;
  /** ARIA role, if present. */
  readonly role?: string;
  /** href attribute for links. */
  readonly href?: string;
  /** title attribute. */
  readonly title?: string;
  /** Resolved label text. */
  readonly label?: string;
}

interface ClickObservation {
  readonly url: string;
  readonly title: string;
  readonly domNodeCount: number;
  readonly bodyTextHash: string;
  readonly targetPresent: boolean;
  readonly targetHash: string;
}

/**
 * Low-level session access for direct browser interaction.
 * Available via `session.raw`. Prefer semantic methods when possible.
 */
export interface RawSessionAccess {
  /** Evaluate JavaScript in the browser page context. */
  evaluate<T = unknown>(script: string): Promise<T>;
  /** Capture a base64-encoded PNG screenshot. */
  screenshot(): Promise<string>;
  /** Get the current page URL. */
  currentUrl(): Promise<string>;
  /** Click an element by CSS selector. */
  clickSelector(selector: string): Promise<void>;
  /** Type text into an element by CSS selector. */
  typeIntoSelector(selector: string, text: string): Promise<void>;
  /** Switch to the latest page target if a click opened a new tab/window. */
  followLatestPageTarget?(): Promise<string>;
  /** Click an element by entity ref string. */
  clickRef(ref: string): Promise<Entity>;
  /** Type text into an element by entity ref string. */
  typeIntoRef(ref: string, text: string): Promise<Entity>;
  /** Get incremental session updates since a cursor position. */
  sessionUpdates(cursor?: SessionUpdateCursor): Promise<SessionUpdatePacket>;
}

/** Cursor for incremental session updates. */
export interface SessionUpdateCursor {
  /** Only return trace events with seq greater than this. */
  readonly traceSeq?: number;
  /** Include a base64 screenshot in the response. */
  readonly includeScreenshot?: boolean;
}

/** Incremental update packet from the session. */
export interface SessionUpdatePacket {
  readonly traceEvents: readonly unknown[];
  readonly entities: readonly Entity[];
  readonly currentUrl: string;
  readonly screenshotBase64?: string;
}

/** Options for polling-based wait methods. */
export interface WaitOptions {
  /** Maximum time to wait in milliseconds (default: 10000). */
  readonly timeoutMs?: number;
  /** Polling interval in milliseconds (default: 250). */
  readonly pollMs?: number;
}

/**
 * A single operation in a batch sequence. Executed in order via `session.batch.run()`.
 */
export type BatchOperation =
  | {
      readonly type: "click";
      readonly locator: LocatorQuery;
      readonly description?: string;
    }
  | {
      readonly type: "type";
      readonly locator: LocatorQuery;
      readonly text: string;
      readonly description?: string;
    }
  | {
      readonly type: "wait_for_url";
      readonly pattern: string | RegExp;
      readonly description?: string;
    }
  | {
      readonly type: "wait_for_text";
      readonly text: string;
      readonly locator?: LocatorQuery;
      readonly description?: string;
    }
  | {
      readonly type: "refresh";
      readonly description?: string;
    };

/** Result of a single operation within a batch. */
export interface BatchResult {
  /** Zero-based index of the operation in the batch. */
  readonly index: number;
  /** The operation that was executed. */
  readonly operation: BatchOperation;
  /** Whether the operation succeeded. */
  readonly ok: boolean;
  /** Operation-specific detail (e.g. matched element, URL). */
  readonly detail?: unknown;
 }

/** Context passed to custom action derivers. */
export interface CustomActionContext {
  readonly entities: readonly Entity[];
  readonly session: Session;
}

/**
 * User-defined action deriver. Registered via `session.use()` or plugins.
 * Called during `session.actions.for()` to produce additional actions
 * beyond what the Rust core derives.
 */
export interface CustomActionDeriver {
  readonly name: string;
  /** Derive actions from the current entity set. */
  derive(context: CustomActionContext): Action[] | Promise<Action[]>;
}

/** Context passed to recovery policies on execution failure. */
export interface RecoveryContext {
  readonly session: Session;
  readonly step: ExecutionStep;
  readonly result: ExecutionResult;
}

/**
 * A policy that can intercept and recover from failed execution steps.
 * Registered via `session.recovery.register()` or plugins.
 */
export interface RecoveryPolicy {
  readonly name: string;
  /** Return true if this policy can handle the failure. */
  matches(context: RecoveryContext): boolean | Promise<boolean>;
  /** Attempt recovery and return a new result. */
  recover(context: RecoveryContext): ExecutionResult | Promise<ExecutionResult>;
}

/**
 * A bundle of action derivers, recovery policies, and native registrations.
 * Install via `session.use(plugin)`.
 */
export interface SessionPlugin {
  readonly name: string;
  readonly actionDerivers?: readonly CustomActionDeriver[];
  readonly recoveryPolicies?: readonly RecoveryPolicy[];
  readonly native?: readonly unknown[];
}

/**
 * A live browser session with a persistent state graph.
 *
 * This is the primary developer-facing object. It wraps the Rust core
 * via the bridge and exposes semantic operations: query, actions, execute, trace.
 */
export class Session {
  private readonly bridge: Bridge;
  private readonly logger: Logger;
  private closed = false;
  private readonly onClose?: () => Promise<void> | void;
  private readonly customActionDerivers: CustomActionDeriver[] = [];
  private readonly recoveryPolicies: RecoveryPolicy[] = [];
  private _graphVersion = 0;
  private readonly graphChangeListeners: Array<(diff: GraphDiff) => void> = [];

  /** Namespace for action-related methods (derive, inspect). */
  readonly actions: SessionActions;
  /** Namespace for execution trace access and subscription. */
  readonly trace: SessionTrace;
  /** Namespace for recovery policy registration. */
  readonly recovery: SessionRecovery;
  /** Low-level browser access (JS eval, screenshots, selectors). */
  readonly raw: SessionRaw;
  /** Native plugin management. */
  readonly plugins: SessionPlugins;
  /** Semantic element locator (find, click, type by role/text/label). */
  readonly locator: SessionLocator;
  /** Polling-based waiters (URL, text, condition, load state). */
  readonly wait: SessionWait;
  /** Sequential batch execution of multiple operations. */
  readonly batch: SessionBatch;
  /** In-browser state overlay (visual debugging). */
  readonly overlay: SessionOverlay;

  /**
   * @param bridge - The bridge to the Rust core (typically a NapiBridge).
   * @param opts - Optional callbacks and overlay toggle.
   */
  constructor(bridge: Bridge, opts: { onClose?: () => Promise<void> | void; overlay?: boolean } = {}) {
    this.bridge = bridge;
    this.logger = getDefaultLogger();
    this.onClose = opts.onClose;
    this.actions = new SessionActions(this.bridge, this);
    this.trace = new SessionTrace(this.bridge);
    this.recovery = new SessionRecovery(this);
    this.raw = new SessionRaw(this.bridge, this);
    this.plugins = new SessionPlugins(this.bridge, this);
    this.locator = new SessionLocator(this.raw);
    this.wait = new SessionWait(this.raw, this.locator, this.bridge);
    this.batch = new SessionBatch(this.raw, this.locator, this.wait);
    this.overlay = new SessionOverlay(this.bridge, opts.overlay ?? false);

    // Wire up the reactive push channel from the Rust observation loop.
    // All graph diffs flow through here and are dispatched to subscribers.
    this.bridge.onGraphChange((diff: GraphDiff) => {
      this._graphVersion = diff.graph_version;
      for (const listener of this.graphChangeListeners) {
        listener(diff);
      }
      // Push graph diffs to the overlay highlight layer (non-blocking).
      void this.overlay._applyDiff(diff);
    });
  }

  /**
   * Query entities from the current state graph.
   *
   * @param options - Entity type, optional where clause, limit, and ordering.
   * @returns An {@link EntitySet} of matching entities.
   * @throws {@link SessionError} if the session is closed.
   *
   * @example
   * const rows = await session.query({
   *   entity: "InvoiceRow",
   *   where: { status: "Unpaid", amount: { gt: 10000 } },
   * });
   */
  async query<
    TFields extends Record<string, unknown> = Record<string, unknown>,
  >(options: QueryOptions<TFields>): Promise<EntitySet<Entity<TFields>>> {
    this.ensureOpen();

    const request: QueryRequest = {
      entity: options.entity,
      where: options.where as Record<string, unknown>,
      limit: options.limit,
      orderBy: options.orderBy
        ? {
            field: options.orderBy.field as string,
            direction: options.orderBy.direction,
          }
        : undefined,
    };

    const results = await this.bridge.query(request);
    return new EntitySet(results as unknown as Entity<TFields>[]);
  }

  /**
   * Execute a single step. Dispatches the action, waits for the page to settle,
   * and verifies postconditions. On failure, registered recovery policies are
   * tried in order.
   *
   * @param step - The step to execute, including the action and optional params.
   * @returns The execution result with status, postcondition checks, and timing.
   * @throws {@link SessionError} if the session is closed.
   *
   * @example
   * const result = await session.execute({
   *   id: "step-1",
   *   action: deleteAction,
   *   description: "Delete the first invoice row",
   * });
   */
  async execute(step: ExecutionStep): Promise<ExecutionResult> {
    this.ensureOpen();

    // Auto-attach the current graph version for staleness detection.
    // The Rust core will reject execution if the graph has changed.
    const stepWithVersion = {
      ...step,
      expected_graph_version: this._graphVersion,
    };

    const result = await this.bridge.execute(stepWithVersion);

    // The trace now contains the execution event — sync the overlay from it.
    await this.overlay._sync();

    if (result.status === "success") return result;

    for (const policy of this.recoveryPolicies) {
      const context: RecoveryContext = { session: this, step, result };
      if (await policy.matches(context)) {
        return policy.recover(context);
      }
    }

    return result;
  }

  /**
   * Plan a sequence of steps to achieve a goal.
   *
   * First attempts native planning via the bridge. If the bridge returns
   * no steps (e.g. not yet implemented), falls back to a heuristic planner
   * that ranks available actions by keyword overlap with the goal.
   *
   * @param options - Goal description and optional maximum step count.
   * @returns An execution plan with ranked steps and a confidence score.
   * @throws {@link SessionError} if the session is closed.
   *
   * @example
   * const plan = await session.plan({ goal: "delete all unpaid invoices" });
   * for (const step of plan.steps) {
   *   await session.execute(step);
   * }
   */
  async plan(options: {
    goal: string;
    maxSteps?: number;
  }): Promise<ExecutionPlan> {
    this.ensureOpen();

    const planned = await this.bridge.plan(options);
    if (planned.steps.length > 0) return planned;

    return this.buildFallbackPlan(options);
  }

  /**
   * Close the session and release browser resources.
   * Safe to call multiple times -- subsequent calls are no-ops.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.overlay.destroy();
    await this.bridge.close();
    await this.onClose?.();
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new SessionError("Session is closed");
    }
  }

  /**
   * Install a plugin that provides action derivers, recovery policies,
   * or native registrations.
   *
   * @param plugin - The plugin to install.
   * @returns `this` for chaining.
   */
  use(plugin: SessionPlugin): this {
    plugin.actionDerivers?.forEach((deriver) =>
      this.customActionDerivers.push(deriver),
    );
    plugin.recoveryPolicies?.forEach((policy) =>
      this.recoveryPolicies.push(policy),
    );
    plugin.native?.forEach((registration) => {
      void this.bridge.registerPlugin?.(registration);
    });
    return this;
  }

  /** @internal -- used by SessionActions to include custom derivers. */
  getCustomActionDerivers(): readonly CustomActionDeriver[] {
    return this.customActionDerivers;
  }

  /**
   * Current graph version, updated automatically by the reactive loop.
   * Use this to detect staleness — if it changed since you last read,
   * the graph has been updated.
   */
  get graphVersion(): number {
    return this._graphVersion;
  }

  /**
   * Subscribe to raw graph diffs from the reactive observation loop.
   * Fires whenever the graph changes due to DOM mutations.
   *
   * @returns Unsubscribe function.
   */
  onGraphChange(callback: (diff: GraphDiff) => void): Unsubscribe {
    this.graphChangeListeners.push(callback);
    return () => {
      const idx = this.graphChangeListeners.indexOf(callback);
      if (idx >= 0) this.graphChangeListeners.splice(idx, 1);
    };
  }

  /**
   * Subscribe to entities matching a query. The callback fires with fresh
   * results whenever the graph changes in a way that could affect the query.
   *
   * This is the Convex `useQuery` equivalent — a live subscription.
   *
   * @returns Unsubscribe function.
   */
  subscribe<TFields extends Record<string, unknown> = Record<string, unknown>>(
    options: QueryOptions<TFields>,
    callback: (entities: EntitySet<Entity<TFields>>) => void,
  ): Unsubscribe {
    this.ensureOpen();

    const entityKind = options.entity.toLowerCase();

    return this.onGraphChange((diff) => {
      // Check if this diff is relevant to the subscription's entity kind
      const relevant =
        diff.resync ||
        diff.upserted.some(
          (e) => e.kind.toLowerCase() === entityKind,
        ) ||
        diff.invalidated.length > 0 ||
        diff.removed.length > 0;

      if (!relevant) return;

      // Re-query to get the fresh result set
      void this.query<TFields>(options).then(callback);
    });
  }

  /**
   * Wait for a condition by subscribing to graph changes, not polling.
   * Resolves when the predicate returns true for the query results.
   *
   * @param query - Entity query to subscribe to.
   * @param predicate - Condition to wait for.
   * @param options - Optional timeout.
   * @returns The entities that satisfied the predicate.
   */
  waitFor<TFields extends Record<string, unknown> = Record<string, unknown>>(
    query: QueryOptions<TFields>,
    predicate: (entities: EntitySet<Entity<TFields>>) => boolean,
    options?: { timeoutMs?: number },
  ): Promise<EntitySet<Entity<TFields>>> {
    this.ensureOpen();
    const timeoutMs = options?.timeoutMs ?? 10_000;

    return new Promise<EntitySet<Entity<TFields>>>((resolve, reject) => {
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsub();
        reject(
          new SessionError(
            `waitFor timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      // Check current state first
      void this.query<TFields>(query).then((entities) => {
        if (settled) return;
        if (predicate(entities)) {
          settled = true;
          clearTimeout(timeout);
          resolve(entities);
        }
      });

      const unsub = this.subscribe<TFields>(query, (entities) => {
        if (settled) return;
        if (predicate(entities)) {
          settled = true;
          clearTimeout(timeout);
          unsub();
          resolve(entities);
        }
      });
    });
  }

  private async buildFallbackPlan(options: {
    goal: string;
    maxSteps?: number;
  }): Promise<ExecutionPlan> {
    const goalTerms = tokenize(options.goal);
    const maxSteps = options.maxSteps ?? 5;
    const allEntities = await collectEntitiesByKnownKinds(this.bridge);
    const allActions = await this.actions.for(allEntities);

    const ranked = allActions.actions
      .map((action) => {
        const actionTerms = tokenize([
          action.name,
          action.type,
          action.targets.join(" "),
        ].join(" "));
        const overlap = goalTerms.filter((term) => actionTerms.includes(term)).length;
        const score = overlap + action.confidence;
        return { action, score };
      })
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxSteps);

    return {
      goal: options.goal,
      steps: ranked.map((candidate, index) => ({
        id: `planned-step-${index + 1}`,
        action: candidate.action,
        description: candidate.action.name,
      })),
      estimatedDurationMs: ranked.length * 1_500,
      confidence:
        ranked.length === 0
          ? 0
          : ranked.reduce((sum, candidate) => sum + Math.min(candidate.score, 1), 0) /
            ranked.length,
    };
  }
}

/**
 * Namespaced action methods, accessed via `session.actions`.
 */
class SessionActions {
  private readonly logger: Logger;

  constructor(
    private readonly bridge: Bridge,
    private readonly session: Session,
  ) {
    this.logger = getDefaultLogger();
  }

  /**
   * Derive available actions for a set of entities.
   *
   * Combines actions from the Rust core with any registered custom derivers.
   *
   * @param entities - Entities to compute actions for (EntitySet or array).
   * @returns Deduplicated set of available actions.
   */
  async for<T extends Entity>(
    entities: EntitySet<T> | Entity[],
  ): Promise<ActionSet> {
    const baseEntities =
      entities instanceof EntitySet ? entities.entities : entities;
    const ids = baseEntities.map((e) => e.id);

    const actions = await this.bridge.actionsFor(ids);
    const custom = await Promise.all(
      this.session.getCustomActionDerivers().map((deriver) =>
        deriver.derive({ entities: baseEntities, session: this.session }),
      ),
    );

    const allActions = dedupeActions([...actions, ...custom.flat()]);
    this.logger.actions(baseEntities.length, allActions.length, custom.flat().length);
    return new ActionSet(allActions);
  }

  /**
   * Inspect an action to determine its validity and resolve its targets.
   *
   * @param action - The action to inspect.
   * @returns Diagnostic information including resolved targets and validity.
   */
  async inspect(action: Action): Promise<ActionDiagnostics> {
    const entities = await this.findTargets(action.targets);
    const reasons: string[] = [];

    if (action.targets.length === 0) {
      reasons.push("Action has no explicit semantic targets.");
    }
    if (action.targets.length > 0 && entities.length === 0) {
      reasons.push("None of the action target entities could be resolved from the current state.");
    }
    if (action.preconditions.length > 0) {
      reasons.push(
        `${action.preconditions.length} precondition(s) must hold before execution.`,
      );
    }
    if (action.postconditions.length > 0) {
      reasons.push(
        `${action.postconditions.length} postcondition(s) will be verified after execution.`,
      );
    }

    return {
      action,
      targetCount: entities.length,
      targetEntities: entities,
      likelyValid: action.targets.length === 0 || entities.length > 0,
      reasons,
    };
  }

  private async findTargets(targetIds: readonly string[]): Promise<Entity[]> {
    if (targetIds.length === 0) return [];

    const entities = await collectEntitiesByKnownKinds(this.bridge);
    return entities.filter((entity) => targetIds.includes(entity.id));
  }
}

class SessionRecovery {
  constructor(private readonly session: Session) {}

  /**
   * Register a recovery policy for failed execution steps.
   *
   * @param policy - The recovery policy to register.
   */
  register(policy: RecoveryPolicy): void {
    this.session.use({ name: `recovery:${policy.name}`, recoveryPolicies: [policy] });
  }
}

class SessionPlugins {
  constructor(
    private readonly bridge: Bridge,
    private readonly _session: Session,
  ) {}

  /**
   * Register a native (Rust-side) plugin.
   *
   * @param plugin - Plugin registration payload forwarded to the Rust core.
   * @throws {@link SessionError} if the bridge does not support native plugins.
   */
  async registerNative(plugin: unknown): Promise<void> {
    if (!this.bridge.registerPlugin) {
      throw new SessionError("This session does not support native plugin registration.");
    }
    await this.bridge.registerPlugin(plugin);
  }

  /** List all registered native plugins. */
  async listNative(): Promise<unknown[]> {
    if (!this.bridge.listPlugins) return [];
    return this.bridge.listPlugins();
  }
}

/**
 * Namespaced trace methods, accessed via `session.trace`.
 */
class SessionTrace {
  constructor(private readonly bridge: Bridge) {}

  /** Get the current execution trace for this session. */
  async current(): Promise<TraceView> {
    const data = await this.bridge.getTrace();
    return new TraceView(data);
  }

  /**
   * Subscribe to trace updates via polling.
   *
   * @param onChange - Callback invoked when new trace entries appear.
   * @param options - Polling interval (default: 500ms).
   * @returns A subscription handle. Call `.unsubscribe()` to stop.
   */
  subscribe(
    onChange: (trace: TraceView) => void | Promise<void>,
    options: { intervalMs?: number } = {},
  ): TraceSubscription {
    const intervalMs = options.intervalMs ?? 500;
    let lastEntryCount = -1;
    let lastSeq = 0;
    let active = true;

    const tick = async () => {
      if (!active) return;
      if (this.bridge.getTraceSince) {
        const delta = await this.bridge.getTraceSince(lastSeq);
        if (delta.length > 0) {
          const trace = await this.current();
          lastEntryCount = trace.entries.length;
          const latest = trace.entries.at(-1);
          if (latest) lastSeq = latest.seq;
          await onChange(trace);
          return;
        }
      }

      const trace = await this.current();
      if (trace.entries.length !== lastEntryCount || lastEntryCount === -1) {
        lastEntryCount = trace.entries.length;
        const latest = trace.entries.at(-1);
        if (latest) lastSeq = latest.seq;
        await onChange(trace);
      }
    };

    void tick();
    const handle = setInterval(() => void tick(), intervalMs);

    return {
      unsubscribe() {
        active = false;
        clearInterval(handle);
      },
    };
  }
}

class SessionRaw implements RawSessionAccess {
  constructor(
    private readonly bridge: Bridge,
    private readonly session: Session,
  ) {}

  async evaluate<T = unknown>(script: string): Promise<T> {
    if (!this.bridge.evaluateJs) {
      throw new SessionError("This session does not support raw JS evaluation.");
    }
    return (await this.bridge.evaluateJs(script)) as T;
  }

  async screenshot(): Promise<string> {
    if (!this.bridge.screenshot) {
      throw new SessionError("This session does not support screenshots.");
    }
    return this.bridge.screenshot();
  }

  async currentUrl(): Promise<string> {
    if (!this.bridge.currentUrl) {
      throw new SessionError("This session does not expose currentUrl.");
    }
    return this.bridge.currentUrl();
  }

  async clickSelector(selector: string): Promise<void> {
    if (!this.bridge.clickSelector) {
      throw new SessionError("This session does not support raw selector clicks.");
    }
    await this.bridge.clickSelector(selector);
  }

  async typeIntoSelector(selector: string, text: string): Promise<void> {
    if (!this.bridge.typeIntoSelector) {
      throw new SessionError("This session does not support raw selector typing.");
    }
    await this.bridge.typeIntoSelector(selector, text);
  }

  async followLatestPageTarget(): Promise<string> {
    if (!this.bridge.followLatestPageTarget) return "";
    return this.bridge.followLatestPageTarget();
  }

  async clickRef(ref: string): Promise<Entity> {
    const entity = await resolveEntityRef(this.bridge, ref);
    await this.clickSelector(entity._source);
    return entity;
  }

  async typeIntoRef(ref: string, text: string): Promise<Entity> {
    const entity = await resolveEntityRef(this.bridge, ref);
    await this.typeIntoSelector(entity._source, text);
    return entity;
  }

  async sessionUpdates(
    cursor: SessionUpdateCursor = {},
  ): Promise<SessionUpdatePacket> {
    const traceEvents = this.bridge.getTraceSince
      ? await this.bridge.getTraceSince(cursor.traceSeq ?? 0)
      : [];
    const currentUrl = this.bridge.currentUrl ? await this.bridge.currentUrl() : "";
    const screenshotBase64 =
      cursor.includeScreenshot && this.bridge.screenshot
        ? await this.bridge.screenshot()
        : undefined;

    return {
      traceEvents,
      entities: [],
      currentUrl,
      screenshotBase64,
    };
  }
}

/** Semantic element locator. Find, click, and type by role, text, label, etc. */
class SessionLocator {
  constructor(private readonly raw: RawSessionAccess) {}

  /**
   * Find all elements matching the locator query.
   *
   * @param query - Locator criteria (all fields combined with AND).
   * @returns Matched elements with selectors and metadata.
   */
  async find(query: LocatorQuery): Promise<readonly LocatorMatch[]> {
    const script = buildLocatorScript(query);
    return this.raw.evaluate<LocatorMatch[]>(script);
  }

  /** Find the first element matching the query, or undefined. */
  async first(query: LocatorQuery): Promise<LocatorMatch | undefined> {
    const matches = await this.find({ ...query, limit: 1 });
    return matches[0];
  }

  /**
   * Find and click the first matching element.
   *
   * @param query - Locator criteria.
   * @returns The matched element.
   * @throws {@link SessionError} if no element matches.
   */
  async click(query: LocatorQuery): Promise<LocatorMatch> {
    const match = await this.first(query);
    if (!match) {
      throw new SessionError(`No element matched locator ${JSON.stringify(query)}`);
    }
    const before = await captureClickObservation(this.raw, match.selector);
    await this.raw.clickSelector(match.selector);
    const after = await waitForClickTransition(this.raw, match, before);
    if (!didClickCauseStateTransition(before, after)) {
      throw new SessionError(
        `Click on ${match.selector} produced no observable browser state transition.`,
      );
    }
    return match;
  }

  /**
   * Find the first matching element and type text into it.
   *
   * @param query - Locator criteria.
   * @param text - Text to type.
   * @returns The matched element.
   * @throws {@link SessionError} if no element matches.
   */
  async type(query: LocatorQuery, text: string): Promise<LocatorMatch> {
    const match = await this.first(query);
    if (!match) {
      throw new SessionError(`No element matched locator ${JSON.stringify(query)}`);
    }
    await this.raw.typeIntoSelector(match.selector, text);
    return match;
  }
}

/** Polling-based waiters for URL changes, text appearance, conditions, and load state. */
class SessionWait {
  constructor(
    private readonly raw: RawSessionAccess,
    private readonly locator: SessionLocator,
    private readonly bridge: Bridge,
  ) {}

  /**
   * Wait for the page URL to match a pattern.
   *
   * @param pattern - Substring or RegExp to match against the URL.
   * @param options - Timeout and polling interval.
   * @returns The matching URL.
   * @throws {@link SessionError} on timeout.
   */
  async forUrl(pattern: string | RegExp, options: WaitOptions = {}): Promise<string> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const pollMs = options.pollMs ?? 250;
    const matcher =
      typeof pattern === "string"
        ? (value: string) => value.includes(pattern)
        : (value: string) => pattern.test(value);

    return pollUntil(
      async () => {
        const url = await this.raw.currentUrl();
        return matcher(url) ? url : null;
      },
      timeoutMs,
      pollMs,
      `URL to match ${String(pattern)}`,
    );
  }

  /**
   * Wait for text to appear on the page.
   *
   * @param text - Text content to wait for.
   * @param locator - Optional locator to scope the search.
   * @param options - Timeout and polling interval.
   * @returns The matching elements.
   * @throws {@link SessionError} on timeout.
   */
  async forText(
    text: string,
    locator: LocatorQuery = {},
    options: WaitOptions = {},
  ): Promise<readonly LocatorMatch[]> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const pollMs = options.pollMs ?? 250;

    return pollUntil(
      async () => {
        const matches = await this.locator.find({ ...locator, text });
        return matches.length > 0 ? matches : null;
      },
      timeoutMs,
      pollMs,
      `text "${text}"`,
    );
  }

  /**
   * Wait for a custom JavaScript condition to become truthy.
   *
   * @param script - JavaScript to evaluate. Must return a truthy value when the condition is met.
   * @param options - Timeout and polling interval.
   * @returns The truthy value returned by the script.
   * @throws {@link SessionError} on timeout.
   */
  async forCondition<T = unknown>(
    script: string,
    options: WaitOptions = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const pollMs = options.pollMs ?? 250;

    return pollUntil(
      async () => {
        const value = await this.raw.evaluate<T | null>(script);
        return value ? value : null;
      },
      timeoutMs,
      pollMs,
      "custom condition",
    );
  }

  /**
   * Wait for the page entity state to stabilize (graph version stops changing).
   *
   * In the reactive model, the graph is automatically updated by the
   * observation loop. This method waits until the graph version is stable
   * (no changes for two consecutive polls).
   *
   * @param options - Timeout and polling interval.
   * @returns The stable entity set.
   * @throws {@link SessionError} on timeout.
   */
  async forLoadState(options: WaitOptions = {}): Promise<EntitySet> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const pollMs = options.pollMs ?? 250;
    const start = Date.now();
    let previousVersion = await this.bridge.graphVersion();

    while (Date.now() - start < timeoutMs) {
      await delay(pollMs);
      const currentVersion = await this.bridge.graphVersion();
      if (currentVersion === previousVersion && currentVersion > 0) {
        // Graph version stable — page has settled.
        return new EntitySet([]);
      }
      previousVersion = currentVersion;
    }

    throw new SessionError("Timed out waiting for page load state to settle.");
  }
}

/** Execute a sequence of batch operations in order. */
class SessionBatch {
  constructor(
    private readonly raw: RawSessionAccess,
    private readonly locator: SessionLocator,
    private readonly wait: SessionWait,
  ) {}

  /**
   * Run a sequence of operations (click, type, wait, refresh) in order.
   *
   * @param operations - Ordered list of operations to execute.
   * @returns Results for each operation, in order.
   */
  async run(operations: readonly BatchOperation[]): Promise<readonly BatchResult[]> {
    const results: BatchResult[] = [];

    for (const [index, operation] of operations.entries()) {
      switch (operation.type) {
        case "click": {
          const match = await this.locator.click(operation.locator);
          results.push({ index, operation, ok: true, detail: match });
          break;
        }
        case "type": {
          const match = await this.locator.type(operation.locator, operation.text);
          results.push({ index, operation, ok: true, detail: match });
          break;
        }
        case "wait_for_url": {
          const url = await this.wait.forUrl(operation.pattern);
          results.push({ index, operation, ok: true, detail: { url } });
          break;
        }
        case "wait_for_text": {
          const matches = await this.wait.forText(
            operation.text,
            operation.locator,
          );
          results.push({ index, operation, ok: true, detail: matches });
          break;
        }
        case "refresh": {
          // In reactive mode, the graph is always fresh.
          // This is a no-op preserved for batch operation compatibility.
          results.push({
            index,
            operation,
            ok: true,
            detail: { entityCount: 0 },
          });
          break;
        }
      }
    }

    return results;
  }
}

/**
 * Namespaced overlay methods, accessed via `session.overlay`.
 *
 * When enabled, the overlay is automatically injected into the browser page
 * and updated after every execute/refresh cycle. It can also be driven
 * manually for custom workflows.
 */
/**
 * Reactive overlay driven by the trace log.
 *
 * The trace is the single source of truth for all state transitions
 * (navigations, extractions, executions, errors, snapshots). The overlay
 * subscribes to it via `sync()` — advancing a cursor, deriving its view,
 * and pushing the result to the browser.
 *
 * No imperative "mark executing" / "mark result" calls. The overlay
 * learns about state changes the same way any other subscriber would:
 * by reading the log.
 */
class SessionOverlay {
  /** @internal */
  readonly _manager: OverlayManager;
  private readonly bridge: Bridge;
  private enabled: boolean;

  constructor(bridge: Bridge, enabled: boolean) {
    this.bridge = bridge;
    this._manager = new OverlayManager(bridge);
    this.enabled = enabled;
  }

  /** Inject the overlay and sync initial state from the trace. */
  async enable(): Promise<void> {
    this.enabled = true;
    await this._manager.inject();
    await this.bootstrapHighlights();
    await this._manager.sync();
  }

  /** Remove the overlay. */
  async disable(): Promise<void> {
    this.enabled = false;
    await this._manager.destroy();
  }

  /** Remove the overlay from the page (called on session close). */
  async destroy(): Promise<void> {
    await this._manager.destroy();
  }

  /** Whether the overlay is currently enabled. */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Sync the overlay with the trace log.
   *
   * Called after any operation that may have advanced the trace
   * (execute, refresh, navigate). The overlay reads new entries,
   * derives its view, and pushes to the browser.
   *
   * @internal
   */
  async _sync(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this._manager.sync();
    } catch {
      // Overlay sync failures are non-fatal.
    }
  }

  /**
   * Feed a graph diff to the highlight layer.
   * @internal — called from the session's onGraphChange handler.
   */
  async _applyDiff(diff: GraphDiff): Promise<void> {
    if (!this.enabled) return;
    try {
      await this._manager.applyDiff(diff);
      await this._manager.sync();
    } catch {
      // Overlay diff failures are non-fatal.
    }
  }

  /** @internal — called by Runtime after session creation when overlay: true. */
  async _autoEnable(): Promise<void> {
    await this.enable();
  }

  private async bootstrapHighlights(): Promise<void> {
    try {
      const entities = await collectEntitiesByKnownKinds(this.bridge);
      this._manager.seed(entities);
    } catch {
      // Overlay bootstrap failures are non-fatal.
    }
  }
}


const PLANNING_ENTITY_KINDS = [
  "Table",
  "TableRow",
  "Form",
  "Modal",
  "Button",
  "Link",
  "ListItem",
  "Pagination",
  "Dialog",
  "Menu",
  "List",
  "SearchResult",
] as const;

async function collectEntitiesByKnownKinds(
  bridge: Pick<Bridge, "query">,
): Promise<Entity[]> {
  const collected = await Promise.all(
    PLANNING_ENTITY_KINDS.map((entity) =>
      bridge.query({ entity, where: undefined, limit: undefined, orderBy: undefined }),
    ),
  );

  return dedupeEntities(collected.flat());
}

function dedupeEntities(entities: Entity[]): Entity[] {
  const seen = new Set<string>();
  const unique: Entity[] = [];

  for (const entity of entities) {
    if (seen.has(entity.id)) continue;
    seen.add(entity.id);
    unique.push(entity);
  }

  return unique;
}

function dedupeActions(actions: Action[]): Action[] {
  const seen = new Set<string>();
  const unique: Action[] = [];

  for (const action of actions) {
    const key = `${action.id}:${action.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(action);
  }

  return unique;
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 1);
}

function buildLocatorScript(query: LocatorQuery): string {
  const payload = JSON.stringify(query);
  return `(() => {
    const query = ${payload};
    const limit = query.limit ?? 20;
    const exact = Boolean(query.exact);
    const normalize = (value) => (value ?? "").replace(/\\s+/g, " ").trim();
    const sanitizeSelector = (value) => {
      if (typeof value !== "string") return undefined;
      const trimmed = value.trim();
      if (!trimmed) return undefined;
      const unwrapped = trimmed.replace(/^['"\`]+|['"\`]+$/g, "");
      return unwrapped || undefined;
    };
    const match = (candidate, expected) => {
      if (!expected) return true;
      const left = normalize(candidate).toLowerCase();
      const right = normalize(expected).toLowerCase();
      return exact ? left === right : left.includes(right);
    };
    const cssEscape = (value) => {
      if (globalThis.CSS && CSS.escape) return CSS.escape(value);
      return String(value).replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"');
    };
    const selectorFor = (element) => {
      if (element.id) return "#" + cssEscape(element.id);
      if (element.getAttribute("name")) {
        return element.tagName.toLowerCase() + '[name="' + cssEscape(element.getAttribute("name")) + '"]';
      }
      if (element.getAttribute("href")) {
        return element.tagName.toLowerCase() + '[href="' + cssEscape(element.getAttribute("href")) + '"]';
      }
      let current = element;
      const parts = [];
      while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
        let part = current.tagName.toLowerCase();
        if (current.parentElement) {
          const siblings = Array.from(current.parentElement.children).filter((child) => child.tagName === current.tagName);
          if (siblings.length > 1) {
            part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
          }
        }
        parts.unshift(part);
        current = current.parentElement;
      }
      return parts.join(" > ");
    };
    const selector = sanitizeSelector(query.selector);
    let nodes = [];
    try {
      nodes = selector
        ? Array.from(document.querySelectorAll(selector))
        : Array.from(document.querySelectorAll('a, button, input, textarea, select, [role], li, article'));
    } catch {
      nodes = [];
    }
    const results = [];
    for (const element of nodes) {
      const text = normalize(element.innerText || element.textContent || element.getAttribute("value"));
      const role = normalize(element.getAttribute("role")) || undefined;
      const title = normalize(element.getAttribute("title")) || undefined;
      const associatedLabel = (() => {
        if (!element.id) return "";
        const labels = Array.from(document.getElementsByTagName("label"));
        const match = labels.find((labelEl) => labelEl.getAttribute("for") === element.id);
        return normalize(match?.textContent);
      })();
      const label =
        normalize(element.getAttribute("aria-label")) ||
        associatedLabel ||
        undefined;
      const placeholder = normalize(element.getAttribute("placeholder")) || undefined;
      if (!match(role, query.role)) continue;
      if (!match(text, query.text)) continue;
      if (!match(label, query.label)) continue;
      if (!match(title, query.title)) continue;
      if (!match(placeholder, query.placeholder)) continue;
      results.push({
        selector: selectorFor(element),
        text,
        role,
        href: element.getAttribute("href") || undefined,
        title,
        label,
      });
      if (results.length >= limit) break;
    }
    return results;
  })()`;
}

async function pollUntil<T>(
  fn: () => Promise<T | null>,
  timeoutMs: number,
  pollMs: number,
  description: string,
): Promise<T> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value !== null) return value;
    await delay(pollMs);
  }

  throw new SessionError(`Timed out waiting for ${description}.`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureClickObservation(
  raw: Pick<RawSessionAccess, "evaluate" | "currentUrl">,
  selector: string,
): Promise<ClickObservation> {
  const observation = await raw.evaluate<Omit<ClickObservation, "url">>(
    `(() => {
      const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
      const hash = (value) => {
        let acc = 0;
        for (let i = 0; i < value.length; i += 1) {
          acc = (acc * 31 + value.charCodeAt(i)) >>> 0;
        }
        return acc.toString(16);
      };

      let target = null;
      try {
        target = document.querySelector(${JSON.stringify(selector)});
      } catch {
        target = null;
      }

      const bodyText = normalize(document.body?.innerText || document.body?.textContent || "").slice(0, 4000);
      const targetState = target
        ? normalize([
            target.outerHTML,
            target.getAttribute("aria-expanded"),
            target.getAttribute("aria-pressed"),
            target.getAttribute("aria-selected"),
            target.getAttribute("aria-checked"),
            "value" in target ? target.value : "",
            "checked" in target ? String(Boolean(target.checked)) : "",
            document.activeElement === target ? "focused" : "",
          ].join("|")).slice(0, 3000)
        : "";

      return {
        title: document.title || "",
        domNodeCount: document.querySelectorAll("body *").length,
        bodyTextHash: hash(bodyText),
        targetPresent: Boolean(target),
        targetHash: hash(targetState),
      };
    })()`,
  );

  return {
    url: await raw.currentUrl(),
    ...observation,
  };
}

function didClickCauseStateTransition(
  before: ClickObservation,
  after: ClickObservation,
): boolean {
  return (
    before.url !== after.url ||
    before.title !== after.title ||
    before.domNodeCount !== after.domNodeCount ||
    before.bodyTextHash !== after.bodyTextHash ||
    before.targetPresent !== after.targetPresent ||
    before.targetHash !== after.targetHash
  );
}

function isLikelyNavigationalClick(match: LocatorMatch): boolean {
  if (match.role?.toLowerCase() === "link") return true;
  if (match.href && !match.href.startsWith("#")) return true;
  return /^a(\b|[\[#.:])/.test(match.selector);
}

async function waitForClickTransition(
  raw: Pick<RawSessionAccess, "evaluate" | "currentUrl" | "followLatestPageTarget">,
  match: LocatorMatch,
  before: ClickObservation,
): Promise<ClickObservation> {
  const timeoutMs = isLikelyNavigationalClick(match) ? 2_500 : 1_200;
  const pollMs = 100;

  try {
    return await pollUntil(
      async () => {
        const current = await captureClickObservation(raw, match.selector);
        return didClickCauseStateTransition(before, current) ? current : null;
      },
      timeoutMs,
      pollMs,
      `click transition for ${match.selector}`,
    );
  } catch (error) {
    if (isLikelyNavigationalClick(match)) {
      const switchedUrl = await raw.followLatestPageTarget?.();
      if (switchedUrl) {
        const current = await captureClickObservation(raw, match.selector);
        if (didClickCauseStateTransition(before, current)) {
          return current;
        }
      }
      throw error;
    }
    return captureClickObservation(raw, match.selector);
  }
}

async function resolveEntityRef(
  bridge: Pick<Bridge, "query">,
  ref: string,
): Promise<Entity> {
  const entities = await collectEntitiesByKnownKinds(bridge);
  const match = entities.find((entity) => entity._ref === ref);
  if (!match) {
    throw new SessionError(`No entity matched interactive ref ${ref}.`);
  }
  return match;
}
