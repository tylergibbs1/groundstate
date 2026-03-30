import type { ZodType } from "zod";

export interface BenchTask {
  /** Human-readable task name. */
  name: string;
  /** Unique slug for artifact filenames. */
  slug: string;
  /** Steps to execute in order. */
  steps: TaskStep[];
  /** Postconditions verified against accumulated extractions. */
  postconditions: Postcondition[];
}

export type TaskStep =
  | { type: "navigate"; url: string }
  | {
      type: "extract";
      /** Natural-language instruction for Stagehand. */
      instruction: string;
      /** Zod schema for Stagehand's typed extraction. */
      schema: ZodType;
      /** Label for this extraction in results. */
      label: string;
    }
  | {
      type: "click";
      /** CSS selector (for Groundstate) */
      selector: string;
      /** Natural-language instruction (for Stagehand) */
      instruction: string;
    }
  | { type: "wait"; ms: number };

export interface Postcondition {
  description: string;
  check: (extractions: Map<string, unknown>) => boolean;
}

export interface SystemResult {
  system: "groundstate" | "stagehand";
  task: string;
  extractions: Map<string, unknown>;
  postconditions: PostconditionResult[];
  latencyMs: number;
  tokensConsumed: number;
  error?: string;
}

export interface PostconditionResult {
  description: string;
  passed: boolean;
}

export interface TaskReport {
  task: BenchTask;
  results: SystemResult[];
}
