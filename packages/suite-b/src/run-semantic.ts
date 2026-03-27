#!/usr/bin/env npx tsx

import { runSemanticBenchmark } from "./semantic-benchmark.js";
import type { SuiteSummary } from "../../eval/src/recorder.js";

const verbose = process.argv.includes("--verbose");
const visible = process.argv.includes("--visible") || process.argv.includes("--watch");
const slowArg = process.argv.find((arg) => arg.startsWith("--delay-ms="));
const stepDelayMs = slowArg ? Number(slowArg.split("=")[1]) : undefined;

function printSummary(label: string, data: SuiteSummary) {
  console.log(`Bucket ${label}`);
  console.log(`  runs: ${data.totalRuns}`);
  console.log(`  pass rate: ${(data.passRate * 100).toFixed(1)}%`);
  console.log(`  plan survival: ${(data.meanPlanSurvivalRate * 100).toFixed(1)}%`);
  console.log(`  stale action escape: ${(data.staleActionEscapeRate * 100).toFixed(1)}%`);
  console.log(`  false invalidation: ${(data.falseInvalidationRate * 100).toFixed(1)}%`);
  console.log(`  recovery success: ${(data.meanRecoverySuccessRate * 100).toFixed(1)}%`);
  console.log(`  mean time to root cause: ${data.meanTimeToRootCauseMs.toFixed(0)}ms`);
}

async function main() {
  console.log("══════════════════════════════════════════════════");
  console.log("  Groundstate Semantic Continuity Benchmark");
  console.log(
    `  Buckets: stable, benign churn, real disruption${visible ? " · visible mode" : ""}`,
  );
  console.log("══════════════════════════════════════════════════\n");

  const output = await runSemanticBenchmark({ verbose, visible, stepDelayMs });

  printSummary("A", output.summaries.A);
  console.log();
  printSummary("B", output.summaries.B);
  console.log();
  printSummary("C", output.summaries.C);
  console.log();
  console.log(`Artifacts: ${output.artifactsDir}`);
  console.log(`Report: ${output.reportPath}`);

  const failed = output.results.filter((result) => !result.taskSuccess).length;
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error("Fatal:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
