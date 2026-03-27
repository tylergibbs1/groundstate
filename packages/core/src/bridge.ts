import type { Action } from "./action.js";
import type { Entity } from "./entity.js";
import type {
  ExecutionResult,
  ExecutionPlan,
  ExecutionStep,
} from "./postcondition.js";
import type { QueryRequest } from "./query.js";
import type { Trace } from "./trace.js";

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
  registerPlugin?(plugin: unknown): Promise<void>;
  listPlugins?(): Promise<unknown[]>;
  getTrace(): Promise<Trace>;
  getTraceSince?(sinceSeq: number): Promise<unknown[]>;
  refresh?(): Promise<Entity[]>;
  evaluateJs?(script: string): Promise<unknown>;
  screenshot?(): Promise<string>;
  currentUrl?(): Promise<string>;
  clickSelector?(selector: string): Promise<void>;
  typeIntoSelector?(selector: string, text: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Concrete bridge implementation that delegates to the napi NativeSession.
 *
 * This is the only class that touches the native addon. All JSON serialization
 * and deserialization happens here.
 */
export class NapiBridge implements Bridge {
  // Using `any` for the native session type since the generated .d.ts
  // isn't available until after the native build.
  private native: NativeSessionLike;

  constructor(native: NativeSessionLike) {
    this.native = native;
  }

  async query(request: QueryRequest): Promise<Entity[]> {
    const json = await this.native.query(JSON.stringify(request));
    return JSON.parse(json) as Entity[];
  }

  async actionsFor(entityIds: string[]): Promise<Action[]> {
    const json = await this.native.actionsFor(JSON.stringify(entityIds));
    return JSON.parse(json) as Action[];
  }

  async execute(step: ExecutionStep): Promise<ExecutionResult> {
    const json = await this.native.execute(JSON.stringify(step));
    return JSON.parse(json) as ExecutionResult;
  }

  async plan(
    _options: { goal: string; maxSteps?: number },
  ): Promise<ExecutionPlan> {
    // Planning is not yet implemented in the Rust core.
    // For the MVP, return a stub plan.
    return {
      goal: _options.goal,
      steps: [],
      estimatedDurationMs: 0,
      confidence: 0,
    };
  }

  async getTrace(): Promise<Trace> {
    const json = await this.native.getTrace();
    return JSON.parse(json) as Trace;
  }

  async registerPlugin(plugin: unknown): Promise<void> {
    if (!this.native.registerPlugin) return;
    await this.native.registerPlugin(JSON.stringify(plugin));
  }

  async listPlugins(): Promise<unknown[]> {
    if (!this.native.listPlugins) return [];
    const json = await this.native.listPlugins();
    return JSON.parse(json) as unknown[];
  }

  async getTraceSince(sinceSeq: number): Promise<unknown[]> {
    if (!this.native.getTraceSince) return [];
    const json = await this.native.getTraceSince(sinceSeq);
    return JSON.parse(json) as unknown[];
  }

  async refresh(): Promise<Entity[]> {
    if (!this.native.refresh) return [];
    const json = await this.native.refresh();
    return JSON.parse(json) as Entity[];
  }

  async evaluateJs(script: string): Promise<unknown> {
    if (!this.native.evaluateJs) return null;
    const json = await this.native.evaluateJs(script);
    return JSON.parse(json) as unknown;
  }

  async screenshot(): Promise<string> {
    if (!this.native.screenshot) {
      throw new Error("Native session does not support screenshots.");
    }
    return this.native.screenshot();
  }

  async currentUrl(): Promise<string> {
    if (!this.native.currentUrl) return "";
    return this.native.currentUrl();
  }

  async clickSelector(selector: string): Promise<void> {
    if (!this.native.clickSelector) {
      throw new Error("Native session does not support raw selector clicks.");
    }
    await this.native.clickSelector(selector);
  }

  async typeIntoSelector(selector: string, text: string): Promise<void> {
    if (!this.native.typeIntoSelector) {
      throw new Error("Native session does not support raw selector typing.");
    }
    await this.native.typeIntoSelector(selector, text);
  }

  async close(): Promise<void> {
    await this.native.close();
  }
}

/**
 * Minimal interface matching the napi-rs generated NativeSession class.
 * Allows the bridge to work with both the real native addon and test mocks.
 */
export interface NativeSessionLike {
  query(queryJson: string): Promise<string>;
  actionsFor(entityRefsJson: string): Promise<string>;
  execute(stepJson: string): Promise<string>;
  registerPlugin?(pluginJson: string): Promise<void>;
  listPlugins?(): Promise<string>;
  getTrace(): Promise<string>;
  getTraceSince?(sinceSeq: number): Promise<string>;
  refresh?(): Promise<string>;
  evaluateJs?(script: string): Promise<string>;
  screenshot?(): Promise<string>;
  currentUrl?(): Promise<string>;
  clickSelector?(selector: string): Promise<void>;
  typeIntoSelector?(selector: string, text: string): Promise<void>;
  close(): Promise<void>;
}
