import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetricsRecorder } from "../src/recorder.js";
import type { RunMetrics } from "../src/metrics.js";

function makeMetrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    runId: "run-1",
    suite: "B",
    task: "login-flow",
    timestamp: "2026-03-27T10:00:00.000Z",
    taskSuccess: true,
    postconditionResults: [
      { description: "User logged in", passed: true, expected: true, actual: true },
    ],
    semanticActionSuccessRate: 0.9,
    planSurvivalRate: 0.8,
    staleActionEscapeRate: 0,
    falseInvalidationRate: 0.05,
    recoverySuccessRate: 1,
    timeToRootCauseMs: 250,
    tokensConsumed: 5000,
    wallClockMs: 12000,
    replans: 0,
    humanInterventionRequired: false,
    traceEventCount: 15,
    traceComplete: true,
    ...overrides,
  };
}

describe("MetricsRecorder", () => {
  let tmpDir: string;
  let recorder: MetricsRecorder;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "eval-test-"));
    recorder = new MetricsRecorder(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records a result and reads it back in summary", () => {
    const metrics = makeMetrics();
    const filePath = recorder.record(metrics);

    expect(filePath).toContain("login-flow-");
    expect(filePath).toContain(".jsonl");

    const summary = recorder.summary("B");
    expect(summary.totalRuns).toBe(1);
    expect(summary.passRate).toBe(1);
    expect(summary.meanWallClockMs).toBe(12000);
    expect(summary.medianWallClockMs).toBe(12000);
    expect(summary.meanSemanticActionSuccessRate).toBe(0.9);
    expect(summary.meanPostconditionPassRate).toBe(1);
    expect(summary.meanPlanSurvivalRate).toBe(0.8);
    expect(summary.staleActionEscapeRate).toBe(0);
    expect(summary.falseInvalidationRate).toBe(0.05);
    expect(summary.meanRecoverySuccessRate).toBe(1);
    expect(summary.meanTimeToRootCauseMs).toBe(250);
  });

  it("computes aggregates across multiple runs", () => {
    recorder.record(makeMetrics({ runId: "run-1", wallClockMs: 10000, taskSuccess: true }));
    recorder.record(
      makeMetrics({
        runId: "run-2",
        wallClockMs: 20000,
        taskSuccess: false,
        timestamp: "2026-03-27T11:00:00.000Z",
        semanticActionSuccessRate: 0.5,
        planSurvivalRate: 0.25,
        postconditionResults: [
          { description: "Check A", passed: true, expected: true, actual: true },
          { description: "Check B", passed: false, expected: "done", actual: "pending" },
        ],
        recoverySuccessRate: 0.5,
        timeToRootCauseMs: 750,
      }),
    );

    const summary = recorder.summary("B");
    expect(summary.totalRuns).toBe(2);
    expect(summary.passRate).toBe(0.5);
    expect(summary.meanWallClockMs).toBe(15000);
    expect(summary.medianWallClockMs).toBe(15000);
    expect(summary.meanSemanticActionSuccessRate).toBe(0.7);
    // run-1: 1/1 = 1.0, run-2: 1/2 = 0.5 => mean = 0.75
    expect(summary.meanPostconditionPassRate).toBe(0.75);
    expect(summary.meanPlanSurvivalRate).toBe(0.525);
    expect(summary.meanRecoverySuccessRate).toBe(0.75);
    expect(summary.meanTimeToRootCauseMs).toBe(500);
  });

  it("returns empty summary for nonexistent suite", () => {
    const summary = recorder.summary("C");
    expect(summary.totalRuns).toBe(0);
    expect(summary.passRate).toBe(0);
  });

  it("computes correct median for odd number of runs", () => {
    recorder.record(makeMetrics({ runId: "r1", wallClockMs: 5000, timestamp: "2026-03-27T10:00:00.000Z" }));
    recorder.record(makeMetrics({ runId: "r2", wallClockMs: 15000, timestamp: "2026-03-27T11:00:00.000Z" }));
    recorder.record(makeMetrics({ runId: "r3", wallClockMs: 25000, timestamp: "2026-03-27T12:00:00.000Z" }));

    const summary = recorder.summary("B");
    expect(summary.medianWallClockMs).toBe(15000);
  });
});
