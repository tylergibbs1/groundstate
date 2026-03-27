export interface RunMetrics {
  runId: string;
  suite: "A" | "B" | "C" | "D";
  task: string;
  timestamp: string; // ISO 8601
  bucket?: "stable" | "benign_churn" | "real_disruption";
  mutationType?: string;

  // Core metrics from the PRD
  taskSuccess: boolean;
  postconditionResults: PostconditionMetric[];
  semanticActionSuccessRate: number; // 0-1
  planSurvivalRate: number; // 0-1 (plan remains valid after benign UI churn)
  staleActionEscapeRate: number; // 0-1 (actions executed that should have been invalidated)
  falseInvalidationRate: number; // 0-1 (unnecessary invalidations)
  recoverySuccessRate: number; // 0-1
  timeToRootCauseMs: number; // mean time from failure-inducing mutation to causal diagnosis

  // Cost/performance
  tokensConsumed: number;
  wallClockMs: number;
  replans: number;
  humanInterventionRequired: boolean;

  // Trace
  traceEventCount: number;
  traceComplete: boolean; // all expected events present

  // Optional metadata
  model?: string;
  promptVersion?: string;
  browserVersion?: string;
  viewport?: { width: number; height: number };
}

export interface PostconditionMetric {
  description: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
}
