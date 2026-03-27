#!/usr/bin/env npx tsx
/**
 * Suite B runner: real browser, deterministic scripts, no model.
 *
 * Usage:
 *   npx tsx src/run.ts             # normal output
 *   npx tsx src/run.ts --verbose   # per-test output
 */

import { SuiteBHarness } from "./harness.js";
import { ALL_TESTS } from "./tests.js";

const verbose = process.argv.includes("--verbose");

async function main() {
  console.log("══════════════════════════════════════════════════");
  console.log("  Suite B: Transport Realism Tests");
  console.log("  Real browser, deterministic scripts, no model");
  console.log("══════════════════════════════════════════════════\n");

  const harness = new SuiteBHarness({ verbose });

  try {
    console.log("→ Launching Chrome...");
    await harness.setup();
    console.log(`→ Running ${ALL_TESTS.length} tests...\n`);

    const results = await harness.runAll(ALL_TESTS);
    harness.printSummary(results);

    const failed = results.filter((r) => !r.passed).length;
    process.exitCode = failed > 0 ? 1 : 0;
  } finally {
    await harness.teardown();
  }
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
