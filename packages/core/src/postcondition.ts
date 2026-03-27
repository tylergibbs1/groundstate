import type { Action, Condition } from "./action.js";

/**
 * A step in an execution plan.
 */
export interface ExecutionStep {
  readonly id: string;
  readonly action: Action;
  readonly params?: Record<string, unknown>;
  readonly description: string;
}

/**
 * The result of executing a single step.
 */
export interface ExecutionResult {
  readonly stepId: string;
  readonly status: "success" | "failed" | "skipped";
  readonly postconditions: PostconditionResult[];
  readonly durationMs: number;
  readonly error?: ExecutionError;
}

export interface PostconditionResult {
  readonly condition: Condition;
  readonly passed: boolean;
  readonly actual?: unknown;
  readonly message?: string;
}

export interface ExecutionError {
  readonly code: string;
  readonly message: string;
  readonly recoverable: boolean;
}

/**
 * A plan is an ordered sequence of steps with a stated goal.
 */
export interface ExecutionPlan {
  readonly goal: string;
  readonly steps: readonly ExecutionStep[];
  readonly estimatedDurationMs: number;
  readonly confidence: number;
}
