import type { QueryRequest } from "./query.js";
import type { ExecutionStep, ExecutionResult, PostconditionResult } from "./postcondition.js";

/**
 * The full audit log of a session.
 */
export interface Trace {
  readonly sessionId: string;
  readonly startedAt: string;
  readonly entries: readonly TraceEntry[];
  readonly durationMs: number;
}

export type TraceEntry =
  | NavigationEntry
  | ExtractionEntry
  | QueryEntry
  | ExecutionEntry
  | StateChangeEntry
  | ErrorEntry
  | ObservationEntry
  | SnapshotEntry;

interface TraceEntryBase {
  readonly timestamp: string;
  readonly seq: number;
}

export interface NavigationEntry extends TraceEntryBase {
  readonly type: "navigation";
  readonly url: string;
  readonly status: number | null;
}

export interface ExtractionEntry extends TraceEntryBase {
  readonly type: "extraction";
  readonly entityType: string;
  readonly count: number;
  readonly durationMs: number;
}

export interface QueryEntry extends TraceEntryBase {
  readonly type: "query";
  readonly entityType: string;
  readonly filter: unknown;
  readonly resultCount: number;
  readonly durationMs: number;
}

export interface ExecutionEntry extends TraceEntryBase {
  readonly type: "execution";
  readonly step: ExecutionStep;
  readonly result: ExecutionResult;
}

export interface StateChangeEntry extends TraceEntryBase {
  readonly type: "state_change";
  readonly description: string;
  readonly invalidatedCount: number;
}

export interface ErrorEntry extends TraceEntryBase {
  readonly type: "error";
  readonly code: string;
  readonly message: string;
  readonly context?: Record<string, unknown>;
}

export interface ObservationEntry extends TraceEntryBase {
  readonly type: "observation";
  readonly url: string;
  readonly entityCount: number;
  readonly durationMs: number;
}

export interface SnapshotEntry extends TraceEntryBase {
  readonly type: "snapshot";
  readonly label: string;
  readonly url: string;
  readonly snapshotHash: string;
  readonly previousSnapshotHash?: string | null;
  readonly changed: boolean;
  readonly addedCount: number;
  readonly removedCount: number;
  readonly entityCount: number;
}

/**
 * Read-only view into a session trace with convenience query methods.
 *
 * @example
 * const trace = await session.trace.current();
 * const summary = trace.summary();
 * console.log(`${summary.executionsSucceeded}/${summary.executionsTotal} succeeded`);
 */
export class TraceView {
  private readonly trace: Trace;

  constructor(trace: Trace) {
    this.trace = trace;
  }

  /** The session ID this trace belongs to. */
  get sessionId(): string {
    return this.trace.sessionId;
  }

  /** All trace entries in chronological order. */
  get entries(): readonly TraceEntry[] {
    return this.trace.entries;
  }

  /** Total session duration in milliseconds. */
  get durationMs(): number {
    return this.trace.durationMs;
  }

  /** Filter to execution entries only. */
  executions(): ExecutionEntry[] {
    return this.trace.entries.filter(
      (e): e is ExecutionEntry => e.type === "execution",
    );
  }

  /** Filter to error entries only. */
  errors(): ErrorEntry[] {
    return this.trace.entries.filter(
      (e): e is ErrorEntry => e.type === "error",
    );
  }

  /** Filter to query entries only. */
  queries(): QueryEntry[] {
    return this.trace.entries.filter(
      (e): e is QueryEntry => e.type === "query",
    );
  }

  /** Filter to snapshot entries only. */
  snapshots(): SnapshotEntry[] {
    return this.trace.entries.filter(
      (e): e is SnapshotEntry => e.type === "snapshot",
    );
  }

  /** Whether any error entries exist in the trace. */
  hasErrors(): boolean {
    return this.errors().length > 0;
  }

  /** Collect all postcondition results across all execution entries. */
  postconditionResults(): PostconditionResult[] {
    return this.executions().flatMap((e) => e.result.postconditions);
  }

  /** Compute an aggregate summary of the trace. */
  summary(): TraceSummary {
    const execs = this.executions();
    return {
      sessionId: this.trace.sessionId,
      totalEntries: this.trace.entries.length,
      executionsTotal: execs.length,
      executionsSucceeded: execs.filter((e) => e.result.status === "success")
        .length,
      executionsFailed: execs.filter((e) => e.result.status === "failed")
        .length,
      errorsTotal: this.errors().length,
      durationMs: this.trace.durationMs,
    };
  }
}

export interface TraceSummary {
  sessionId: string;
  totalEntries: number;
  executionsTotal: number;
  executionsSucceeded: number;
  executionsFailed: number;
  errorsTotal: number;
  durationMs: number;
}
