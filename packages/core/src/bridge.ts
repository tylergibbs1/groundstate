import type { Action } from "./action.js";
import type { Entity } from "./entity.js";
import type {
  ExecutionResult,
  ExecutionPlan,
  ExecutionStep,
} from "./postcondition.js";
import type { QueryRequest } from "./query.js";
import type { GraphDiff } from "./reactive.js";
import type { Trace } from "./trace.js";
import { type Logger, getDefaultLogger } from "./logger.js";

/**
 * Interface for the napi bridge. This is the seam between the TypeScript
 * SDK and the native Rust addon. All data crosses as JSON strings.
 *
 * Extract this as an interface so Session can be tested with mocks.
 */
export interface Bridge {
  query(request: QueryRequest): Promise<Entity[]>;
  actionsFor(entityIds: string[]): Promise<Action[]>;
  execute(step: ExecutionStep): Promise<ExecutionResult>;
  plan(options: { goal: string; maxSteps?: number }): Promise<ExecutionPlan>;
  /** Subscribe to graph diffs pushed from the reactive observation loop. */
  onGraphChange(callback: (diff: GraphDiff) => void): void;
  /** Get the current graph version. */
  graphVersion(): Promise<number>;
  registerPlugin?(plugin: unknown): Promise<void>;
  listPlugins?(): Promise<unknown[]>;
  getTrace(): Promise<Trace>;
  getTraceSince?(sinceSeq: number): Promise<unknown[]>;
  evaluateJs?(script: string): Promise<unknown>;
  screenshot?(): Promise<string>;
  currentUrl?(): Promise<string>;
  clickSelector?(selector: string): Promise<void>;
  typeIntoSelector?(selector: string, text: string): Promise<void>;
  followLatestPageTarget?(): Promise<string>;
  close(): Promise<void>;
}

/**
 * Concrete bridge implementation that delegates to the napi NativeSession.
 *
 * This is the only class that touches the native addon. All JSON serialization
 * and deserialization happens here.
 */
export class NapiBridge implements Bridge {
  private native: NativeSessionLike;
  private readonly logger: Logger;

  /**
   * @param native - The underlying napi-rs native session handle.
   * @param logger - Optional logger instance. Falls back to the default SDK logger.
   */
  constructor(native: NativeSessionLike, logger?: Logger) {
    this.native = native;
    this.logger = logger ?? getDefaultLogger();
  }

  /**
   * Query entities from the Rust state graph.
   *
   * @param request - Wire-format query (entity type, optional where/limit/orderBy).
   * @returns Matching entities deserialized from JSON.
   */
  async query(request: QueryRequest): Promise<Entity[]> {
    const start = performance.now();
    const json = await this.native.query(JSON.stringify(request));
    const entities = JSON.parse(json) as Entity[];
    this.logger.bridgeOp("query", performance.now() - start, {
      entity: request.entity,
      resultCount: entities.length,
    });
    return entities;
  }

  /**
   * Derive available actions for a set of entity IDs.
   *
   * @param entityIds - IDs of entities to compute actions for.
   * @returns Actions the Rust core identified as available.
   */
  async actionsFor(entityIds: string[]): Promise<Action[]> {
    const start = performance.now();
    const json = await this.native.actionsFor(JSON.stringify(entityIds));
    const actions = JSON.parse(json) as Action[];
    this.logger.bridgeOp("actionsFor", performance.now() - start, {
      inputCount: entityIds.length,
      actionCount: actions.length,
    });
    return actions;
  }

  /**
   * Execute a single step via the Rust core.
   *
   * @param step - The execution step including action and optional params.
   * @returns Result with status, postcondition checks, and timing.
   */
  async execute(step: ExecutionStep): Promise<ExecutionResult> {
    const start = performance.now();
    const json = await this.native.execute(JSON.stringify(step));
    const result = JSON.parse(json) as ExecutionResult;
    this.logger.bridgeOp("execute", performance.now() - start, {
      stepId: step.id,
      status: result.status,
    });
    return result;
  }

  /**
   * Plan a sequence of steps to achieve a goal.
   *
   * Native planning is not yet implemented in the Rust core. This method
   * returns an empty plan and logs a warning. The Session layer falls back
   * to a heuristic planner when the bridge returns no steps.
   *
   * @param options - Goal description and optional step limit.
   * @returns An empty plan with confidence 0.
   */
  async plan(
    options: { goal: string; maxSteps?: number },
  ): Promise<ExecutionPlan> {
    this.logger.warn(
      "NapiBridge.plan() is not implemented in the Rust core. " +
      "Returning empty plan -- the Session will use its fallback heuristic planner.",
      { goal: options.goal },
    );
    return {
      goal: options.goal,
      steps: [],
      estimatedDurationMs: 0,
      confidence: 0,
    };
  }

  /**
   * Retrieve the full execution trace for this session.
   *
   * @returns The complete trace including all entries since session start.
   */
  async getTrace(): Promise<Trace> {
    const start = performance.now();
    const json = await this.native.getTrace();
    const trace = JSON.parse(json) as Trace;
    this.logger.bridgeOp("getTrace", performance.now() - start, {
      entryCount: trace.entries.length,
    });
    return trace;
  }

  /** Register a native plugin with the Rust core. */
  async registerPlugin(plugin: unknown): Promise<void> {
    if (!this.native.registerPlugin) return;
    await this.native.registerPlugin(JSON.stringify(plugin));
  }

  /** List registered native plugins. */
  async listPlugins(): Promise<unknown[]> {
    if (!this.native.listPlugins) return [];
    const json = await this.native.listPlugins();
    return JSON.parse(json) as unknown[];
  }

  /**
   * Get trace entries added after the given sequence number.
   *
   * @param sinceSeq - Only return entries with seq greater than this value.
   */
  async getTraceSince(sinceSeq: number): Promise<unknown[]> {
    if (!this.native.getTraceSince) return [];
    const json = await this.native.getTraceSince(sinceSeq);
    return JSON.parse(json) as unknown[];
  }

  /**
   * Subscribe to graph diffs pushed from the Rust reactive observation loop.
   * The callback fires on the Node.js event loop whenever the graph changes.
   */
  onGraphChange(callback: (diff: GraphDiff) => void): void {
    if (!this.native.subscribe) {
      this.logger.warn(
        "Native session does not support subscribe — graph diffs will not be pushed.",
      );
      return;
    }
    this.native.subscribe((err: Error | null, diffJson: string) => {
      if (err) {
        this.logger.warn("graph subscription error", { error: err.message });
        return;
      }
      const raw = JSON.parse(diffJson) as GraphDiff | { graph?: GraphDiff; actions?: unknown[] };
      const diff = normalizeGraphDiff(raw);
      callback(diff);
    });
  }

  /** Get the current graph version. */
  async graphVersion(): Promise<number> {
    if (!this.native.graphVersion) return 0;
    return this.native.graphVersion();
  }

  /**
   * Evaluate arbitrary JavaScript in the browser page.
   *
   * @param script - JavaScript source to evaluate.
   * @returns The deserialized return value.
   */
  async evaluateJs(script: string): Promise<unknown> {
    if (!this.native.evaluateJs) return null;
    const json = await this.native.evaluateJs(script);
    return JSON.parse(json) as unknown;
  }

  /**
   * Capture a screenshot of the current page.
   *
   * @returns Base64-encoded PNG image data.
   * @throws {Error} if the native session does not support screenshots.
   */
  async screenshot(): Promise<string> {
    if (!this.native.screenshot) {
      throw new Error("Native session does not support screenshots.");
    }
    return this.native.screenshot();
  }

  /** Get the current page URL. */
  async currentUrl(): Promise<string> {
    if (!this.native.currentUrl) return "";
    return this.native.currentUrl();
  }

  /**
   * Click an element by CSS selector.
   *
   * @param selector - CSS selector targeting the element.
   * @throws {Error} if the native session does not support raw selector clicks.
   */
  async clickSelector(selector: string): Promise<void> {
    if (!this.native.clickSelector) {
      throw new Error("Native session does not support raw selector clicks.");
    }
    await this.native.clickSelector(selector);
  }

  /**
   * Type text into an element identified by CSS selector.
   *
   * @param selector - CSS selector targeting the input element.
   * @param text - Text to type.
   * @throws {Error} if the native session does not support raw selector typing.
   */
  async typeIntoSelector(selector: string, text: string): Promise<void> {
    if (!this.native.typeIntoSelector) {
      throw new Error("Native session does not support raw selector typing.");
    }
    await this.native.typeIntoSelector(selector, text);
  }

  /** Switch to the newest page target if the browser opened a new tab/window. */
  async followLatestPageTarget(): Promise<string> {
    if (!this.native.followLatestPageTarget) {
      return "";
    }
    return this.native.followLatestPageTarget();
  }

  /** Close the native session and release resources. */
  async close(): Promise<void> {
    this.logger.debug("bridge closed");
    await this.native.close();
  }
}

function isFlatGraphDiff(
  raw: GraphDiff | { graph?: GraphDiff; actions?: unknown[] },
): raw is GraphDiff {
  return "graph_version" in raw || "upserted" in raw || "invalidated" in raw || "removed" in raw;
}

function normalizeGraphDiff(
  raw: GraphDiff | { graph?: GraphDiff; actions?: unknown[] },
): GraphDiff {
  if (isFlatGraphDiff(raw)) {
    return {
      graph_version: raw.graph_version ?? 0,
      upserted: raw.upserted ?? [],
      invalidated: raw.invalidated ?? [],
      removed: raw.removed ?? [],
      actions: raw.actions ?? [],
      resync: typeof raw.resync === "boolean" ? raw.resync : undefined,
    };
  }

  const graph = raw.graph;
  return {
    graph_version: graph?.graph_version ?? 0,
    upserted: graph?.upserted ?? [],
    invalidated: graph?.invalidated ?? [],
    removed: graph?.removed ?? [],
    actions: raw.actions ?? [],
    resync: typeof graph?.resync === "boolean" ? graph.resync : undefined,
  };
}

/**
 * Minimal interface matching the napi-rs generated NativeSession class.
 * Allows the bridge to work with both the real native addon and test mocks.
 */
export interface NativeSessionLike {
  query(queryJson: string): Promise<string>;
  actionsFor(entityRefsJson: string): Promise<string>;
  execute(stepJson: string): Promise<string>;
  /** Subscribe to graph diffs. Callback receives JSON-serialized GraphDiff. */
  subscribe?(
    callback: (err: Error | null, diffJson: string) => void,
  ): void;
  /** Get the current graph version. */
  graphVersion?(): Promise<number>;
  registerPlugin?(pluginJson: string): Promise<void>;
  listPlugins?(): Promise<string>;
  getTrace(): Promise<string>;
  getTraceSince?(sinceSeq: number): Promise<string>;
  evaluateJs?(script: string): Promise<string>;
  screenshot?(): Promise<string>;
  currentUrl?(): Promise<string>;
  clickSelector?(selector: string): Promise<void>;
  typeIntoSelector?(selector: string, text: string): Promise<void>;
  followLatestPageTarget?(): Promise<string>;
  close(): Promise<void>;
}
