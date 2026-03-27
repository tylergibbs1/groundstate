/**
 * Test harness for Suite B: transport realism tests.
 *
 * Launches Chrome once, runs all tests sequentially against it,
 * reports results with pass/fail and timing.
 */

import { CdpClient, launchChrome, getPageWsUrl, sleep } from "./cdp.js";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface TestCase {
  name: string;
  fixture: string; // filename in /fixtures
  run: (cdp: CdpClient, fixtureUrl: string) => Promise<void>;
}

export interface TestResult {
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

export class SuiteBHarness {
  private port = 9333;
  private chrome: ChildProcess | null = null;
  private cdp: CdpClient | null = null;
  private fixturesDir: string;
  private verbose: boolean;

  constructor(opts: { verbose?: boolean } = {}) {
    this.fixturesDir = path.resolve(
      import.meta.dirname ?? process.cwd(),
      "../../../fixtures",
    );
    this.verbose = opts.verbose ?? false;
  }

  async setup(): Promise<void> {
    this.chrome = await launchChrome(this.port);
  }

  async teardown(): Promise<void> {
    this.cdp?.close();
    this.chrome?.kill();
    try {
      fs.rmSync(`/tmp/gs-suite-b-${process.pid}`, { recursive: true });
    } catch {}
  }

  async runTest(test: TestCase): Promise<TestResult> {
    const start = Date.now();
    const cdp = new CdpClient();

    try {
      const wsUrl = await getPageWsUrl(this.port);
      await cdp.connect(wsUrl);

      const fixtureUrl = `file://${this.fixturesDir}/${test.fixture}`;
      await cdp.navigate(fixtureUrl);

      await test.run(cdp, fixtureUrl);

      cdp.close();
      return {
        name: test.name,
        passed: true,
        durationMs: Date.now() - start,
      };
    } catch (e: any) {
      cdp.close();
      return {
        name: test.name,
        passed: false,
        durationMs: Date.now() - start,
        error: e.message || String(e),
      };
    }
  }

  async runAll(tests: TestCase[]): Promise<TestResult[]> {
    const results: TestResult[] = [];

    for (const test of tests) {
      if (this.verbose) process.stdout.write(`  ${test.name} ... `);

      const result = await this.runTest(test);
      results.push(result);

      if (this.verbose) {
        const icon = result.passed ? "✓" : "✗";
        const time = `(${result.durationMs}ms)`;
        console.log(
          `${icon} ${time}${result.error ? ` — ${result.error}` : ""}`,
        );
      }
    }

    return results;
  }

  printSummary(results: TestResult[]) {
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;
    const totalMs = results.reduce((s, r) => s + r.durationMs, 0);

    console.log(`\n  ${passed} passed, ${failed} failed (${totalMs}ms)\n`);

    if (failed > 0) {
      console.log("  Failures:");
      for (const r of results.filter((r) => !r.passed)) {
        console.log(`    ✗ ${r.name}: ${r.error}`);
      }
      console.log();
    }
  }
}

/** Simple assertion that throws on failure */
export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

/** Assert two values are equal (deep JSON comparison) */
export function assertEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label}: expected ${e}, got ${a}`);
  }
}
