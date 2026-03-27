import type { Bridge } from "./bridge.js";
import { ActionSet, type Action } from "./action.js";
import { EntitySet, type Entity, type EntityRef } from "./entity.js";
import type { QueryOptions, QueryRequest } from "./query.js";
import { TraceView } from "./trace.js";
import type {
  ExecutionStep,
  ExecutionResult,
  ExecutionPlan,
} from "./postcondition.js";
import { SessionError } from "./errors.js";
import { OverlayManager } from "./overlay/index.js";

export interface ActionDiagnostics {
  readonly action: Action;
  readonly targetCount: number;
  readonly targetEntities: readonly Entity[];
  readonly likelyValid: boolean;
  readonly reasons: readonly string[];
}

export interface TraceSubscription {
  unsubscribe(): void;
}

export interface LocatorQuery {
  readonly role?: string;
  readonly text?: string;
  readonly label?: string;
  readonly title?: string;
  readonly placeholder?: string;
  readonly selector?: string;
  readonly exact?: boolean;
  readonly limit?: number;
}

export interface LocatorMatch {
  readonly selector: string;
  readonly text: string;
  readonly role?: string;
  readonly href?: string;
  readonly title?: string;
  readonly label?: string;
}

export interface RawSessionAccess {
  evaluate<T = unknown>(script: string): Promise<T>;
  screenshot(): Promise<string>;
  currentUrl(): Promise<string>;
  clickSelector(selector: string): Promise<void>;
  typeIntoSelector(selector: string, text: string): Promise<void>;
  clickRef(ref: string): Promise<Entity>;
  typeIntoRef(ref: string, text: string): Promise<Entity>;
  refresh(): Promise<EntitySet>;
  sessionUpdates(cursor?: SessionUpdateCursor): Promise<SessionUpdatePacket>;
}

export interface SessionUpdateCursor {
  readonly traceSeq?: number;
  readonly includeScreenshot?: boolean;
}

export interface SessionUpdatePacket {
  readonly traceEvents: readonly unknown[];
  readonly entities: readonly Entity[];
  readonly currentUrl: string;
  readonly screenshotBase64?: string;
}

export interface WaitOptions {
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

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

export interface BatchResult {
  readonly index: number;
  readonly operation: BatchOperation;
  readonly ok: boolean;
  readonly detail?: unknown;
 }

export interface CustomActionContext {
  readonly entities: readonly Entity[];
  readonly session: Session;
}

export interface CustomActionDeriver {
  readonly name: string;
  derive(context: CustomActionContext): Action[] | Promise<Action[]>;
}

export interface RecoveryContext {
  readonly session: Session;
  readonly step: ExecutionStep;
  readonly result: ExecutionResult;
}

export interface RecoveryPolicy {
  readonly name: string;
  matches(context: RecoveryContext): boolean | Promise<boolean>;
  recover(context: RecoveryContext): ExecutionResult | Promise<ExecutionResult>;
}

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
  private closed = false;
  private readonly onClose?: () => Promise<void> | void;
  private readonly customActionDerivers: CustomActionDeriver[] = [];
  private readonly recoveryPolicies: RecoveryPolicy[] = [];

  readonly actions: SessionActions;
  readonly trace: SessionTrace;
  readonly recovery: SessionRecovery;
  readonly raw: SessionRaw;
  readonly plugins: SessionPlugins;
  readonly locator: SessionLocator;
  readonly wait: SessionWait;
  readonly batch: SessionBatch;
  readonly overlay: SessionOverlay;

  constructor(bridge: Bridge, opts: { onClose?: () => Promise<void> | void; overlay?: boolean } = {}) {
    this.bridge = bridge;
    this.onClose = opts.onClose;
    this.actions = new SessionActions(this.bridge, this);
    this.trace = new SessionTrace(this.bridge);
    this.recovery = new SessionRecovery(this);
    this.raw = new SessionRaw(this.bridge, this);
    this.plugins = new SessionPlugins(this.bridge, this);
    this.locator = new SessionLocator(this.raw);
    this.wait = new SessionWait(this.raw, this.locator);
    this.batch = new SessionBatch(this.raw, this.locator, this.wait);
    this.overlay = new SessionOverlay(this.bridge, opts.overlay ?? false);
  }

  /**
   * Query entities from the current state graph.
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
   * and verifies postconditions.
   */
  async execute(step: ExecutionStep): Promise<ExecutionResult> {
    this.ensureOpen();

    const result = await this.bridge.execute(step);

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

  /** Close the session and release browser resources. */
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

  getCustomActionDerivers(): readonly CustomActionDeriver[] {
    return this.customActionDerivers;
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
  constructor(
    private readonly bridge: Bridge,
    private readonly session: Session,
  ) {}

  /** Get available actions for a set of entities. */
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

    return new ActionSet(dedupeActions([...actions, ...custom.flat()]));
  }

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

  register(policy: RecoveryPolicy): void {
    this.session.use({ name: `recovery:${policy.name}`, recoveryPolicies: [policy] });
  }
}

class SessionPlugins {
  constructor(
    private readonly bridge: Bridge,
    private readonly _session: Session,
  ) {}

  async registerNative(plugin: unknown): Promise<void> {
    if (!this.bridge.registerPlugin) {
      throw new SessionError("This session does not support native plugin registration.");
    }
    await this.bridge.registerPlugin(plugin);
  }

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

  async refresh(): Promise<EntitySet> {
    if (!this.bridge.refresh) {
      throw new SessionError("This session does not support manual refresh.");
    }
    return new EntitySet(await this.bridge.refresh());
  }

  async sessionUpdates(
    cursor: SessionUpdateCursor = {},
  ): Promise<SessionUpdatePacket> {
    const traceEvents = this.bridge.getTraceSince
      ? await this.bridge.getTraceSince(cursor.traceSeq ?? 0)
      : [];
    const entities = this.bridge.refresh ? await this.bridge.refresh() : [];
    const currentUrl = this.bridge.currentUrl ? await this.bridge.currentUrl() : "";
    const screenshotBase64 =
      cursor.includeScreenshot && this.bridge.screenshot
        ? await this.bridge.screenshot()
        : undefined;

    return {
      traceEvents,
      entities,
      currentUrl,
      screenshotBase64,
    };
  }
}

class SessionLocator {
  constructor(private readonly raw: RawSessionAccess) {}

  async find(query: LocatorQuery): Promise<readonly LocatorMatch[]> {
    const script = buildLocatorScript(query);
    return this.raw.evaluate<LocatorMatch[]>(script);
  }

  async first(query: LocatorQuery): Promise<LocatorMatch | undefined> {
    const matches = await this.find({ ...query, limit: 1 });
    return matches[0];
  }

  async click(query: LocatorQuery): Promise<LocatorMatch> {
    const match = await this.first(query);
    if (!match) {
      throw new SessionError(`No element matched locator ${JSON.stringify(query)}`);
    }
    await this.raw.clickSelector(match.selector);
    return match;
  }

  async type(query: LocatorQuery, text: string): Promise<LocatorMatch> {
    const match = await this.first(query);
    if (!match) {
      throw new SessionError(`No element matched locator ${JSON.stringify(query)}`);
    }
    await this.raw.typeIntoSelector(match.selector, text);
    return match;
  }
}

class SessionWait {
  constructor(
    private readonly raw: RawSessionAccess,
    private readonly locator: SessionLocator,
  ) {}

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

  async forLoadState(options: WaitOptions = {}): Promise<EntitySet> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const pollMs = options.pollMs ?? 250;
    const start = Date.now();
    let previous = "";

    while (Date.now() - start < timeoutMs) {
      const entities = await this.raw.refresh();
      const signature = JSON.stringify(
        entities.entities.map((entity) => `${entity.id}:${entity._entity}`),
      );
      if (signature === previous && signature.length > 0) {
        return entities;
      }
      previous = signature;
      await delay(pollMs);
    }

    throw new SessionError("Timed out waiting for page load state to settle.");
  }
}

class SessionBatch {
  constructor(
    private readonly raw: RawSessionAccess,
    private readonly locator: SessionLocator,
    private readonly wait: SessionWait,
  ) {}

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
          const entities = await this.raw.refresh();
          results.push({
            index,
            operation,
            ok: true,
            detail: { entityCount: entities.count },
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
  private enabled: boolean;

  constructor(bridge: Bridge, enabled: boolean) {
    this._manager = new OverlayManager(bridge);
    this.enabled = enabled;
  }

  /** Inject the overlay and sync initial state from the trace. */
  async enable(): Promise<void> {
    this.enabled = true;
    await this._manager.inject();
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

  /** @internal — called by Runtime after session creation when overlay: true. */
  async _autoEnable(): Promise<void> {
    await this.enable();
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
    const nodes = query.selector
      ? Array.from(document.querySelectorAll(query.selector))
      : Array.from(document.querySelectorAll('a, button, input, textarea, select, [role], li, article'));
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
