#!/usr/bin/env node

/**
 * Groundstate vs Stagehand — Live Browsing Benchmark
 *
 * Runs extraction and interaction tasks on real websites (Hacker News, Wikipedia)
 * using both Groundstate (deterministic, zero LLM) and Stagehand (LLM-powered).
 *
 * Usage:
 *   npx tsx src/index.ts             # Run both systems (needs OPENAI_API_KEY for Stagehand)
 *   npx tsx src/index.ts --gs-only   # Run Groundstate only
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Load .env from project root
try {
  const envPath = resolve(import.meta.dirname ?? ".", "../../.env");
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
} catch {
  // No .env file, that's fine
}
import { hnExtract } from "./tasks/hn-extract.js";
import { hnNavigate } from "./tasks/hn-navigate.js";
import { wikiTable } from "./tasks/wiki-table.js";
import { runGroundstate, shutdownChrome } from "./runners/groundstate.js";
import { runStagehand, stagehandAvailable } from "./runners/stagehand.js";
import { printConsoleReport, writeHtmlReport } from "./report.js";
import type { BenchTask, TaskReport } from "./types.js";

const TASKS: BenchTask[] = [hnExtract, hnNavigate, wikiTable];

async function main() {
  const gsOnly = process.argv.includes("--gs-only");
  const runSh = !gsOnly && stagehandAvailable();

  console.log("\n  Groundstate vs Stagehand — Live Browsing Benchmark\n");
  console.log(`  Systems: Groundstate${runSh ? " + Stagehand" : " (Stagehand skipped — no API key)"}`);
  console.log(`  Tasks: ${TASKS.map((t) => t.name).join(", ")}\n`);

  if (!runSh && !gsOnly) {
    console.log(
      "  Set OPENAI_API_KEY or ANTHROPIC_API_KEY to include Stagehand.\n",
    );
  }

  const reports: TaskReport[] = [];

  for (const task of TASKS) {
    console.log(`  Running: ${task.name}...`);

    // Groundstate
    console.log(`    [GS] starting...`);
    const gsResult = await runGroundstate(task);
    const gsPassed = gsResult.postconditions.filter((p) => p.passed).length;
    console.log(
      `    [GS] done — ${gsPassed}/${gsResult.postconditions.length} passed, ${gsResult.latencyMs}ms${gsResult.error ? ` (ERROR: ${gsResult.error.slice(0, 60)})` : ""}`,
    );

    const report: TaskReport = { task, results: [gsResult] };

    // Stagehand
    if (runSh) {
      console.log(`    [SH] starting...`);
      const shResult = await runStagehand(task);
      const shPassed = shResult.postconditions.filter((p) => p.passed).length;
      console.log(
        `    [SH] done — ${shPassed}/${shResult.postconditions.length} passed, ${shResult.latencyMs}ms, ~${shResult.tokensConsumed} tokens${shResult.error ? ` (ERROR: ${shResult.error.slice(0, 60)})` : ""}`,
      );
      report.results.push(shResult);
    }

    reports.push(report);
    console.log();
  }

  // Clean up shared Chrome instance
  shutdownChrome();

  // Report
  printConsoleReport(reports);

  const artifactsDir = resolve(
    import.meta.dirname ?? ".",
    "../artifacts",
  );
  writeHtmlReport(artifactsDir, reports);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
