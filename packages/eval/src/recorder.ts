import { readFileSync, appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RunMetrics } from "./metrics.js";

export interface SuiteSummary {
  suite: string;
  totalRuns: number;
  passRate: number;
  meanWallClockMs: number;
  medianWallClockMs: number;
  meanSemanticActionSuccessRate: number;
  meanPostconditionPassRate: number;
  meanPlanSurvivalRate: number;
  staleActionEscapeRate: number;
  falseInvalidationRate: number;
  meanRecoverySuccessRate: number;
  meanTimeToRootCauseMs: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export class MetricsRecorder {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  record(metrics: RunMetrics): string {
    const dir = join(this.baseDir, metrics.suite);
    mkdirSync(dir, { recursive: true });

    const safeTimestamp = metrics.timestamp.replace(/[:.]/g, "-");
    const filename = `${metrics.task}-${safeTimestamp}.jsonl`;
    const filePath = join(dir, filename);

    appendFileSync(filePath, JSON.stringify(metrics) + "\n", "utf-8");
    return filePath;
  }

  summary(suite: string): SuiteSummary {
    const dir = join(this.baseDir, suite);

    let files: string[];
    try {
      files = readdirSync(dir).filter((f: string) => f.endsWith(".jsonl"));
    } catch {
      return emptySummary(suite);
    }

    const runs: RunMetrics[] = [];
    for (const file of files) {
      const content = readFileSync(join(dir, file), "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        runs.push(JSON.parse(trimmed) as RunMetrics);
      }
    }

    if (runs.length === 0) return emptySummary(suite);

    const passCount = runs.filter((r) => r.taskSuccess).length;

    const postconditionPassRates = runs.map((r) => {
      if (r.postconditionResults.length === 0) return 1;
      const passed = r.postconditionResults.filter((p) => p.passed).length;
      return passed / r.postconditionResults.length;
    });

    return {
      suite,
      totalRuns: runs.length,
      passRate: passCount / runs.length,
      meanWallClockMs: mean(runs.map((r) => r.wallClockMs)),
      medianWallClockMs: median(runs.map((r) => r.wallClockMs)),
      meanSemanticActionSuccessRate: mean(
        runs.map((r) => r.semanticActionSuccessRate),
      ),
      meanPostconditionPassRate: mean(postconditionPassRates),
      meanPlanSurvivalRate: mean(runs.map((r) => r.planSurvivalRate)),
      staleActionEscapeRate: mean(runs.map((r) => r.staleActionEscapeRate)),
      falseInvalidationRate: mean(runs.map((r) => r.falseInvalidationRate)),
      meanRecoverySuccessRate: mean(runs.map((r) => r.recoverySuccessRate)),
      meanTimeToRootCauseMs: mean(runs.map((r) => r.timeToRootCauseMs)),
    };
  }
}

function emptySummary(suite: string): SuiteSummary {
  return {
    suite,
    totalRuns: 0,
    passRate: 0,
    meanWallClockMs: 0,
    medianWallClockMs: 0,
    meanSemanticActionSuccessRate: 0,
    meanPostconditionPassRate: 0,
    meanPlanSurvivalRate: 0,
    staleActionEscapeRate: 0,
    falseInvalidationRate: 0,
    meanRecoverySuccessRate: 0,
    meanTimeToRootCauseMs: 0,
  };
}
