import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskReport, SystemResult } from "./types.js";

export function printConsoleReport(reports: TaskReport[]) {
  const line = "─".repeat(78);
  console.log();
  console.log(`  Groundstate vs Stagehand — Live Browsing Benchmark`);
  console.log(`  ${line}`);
  console.log(
    `  ${"Task".padEnd(24)} ${"System".padEnd(12)} ${"Accuracy".padEnd(14)} ${"Latency".padEnd(12)} ${"Tokens".padEnd(10)}`,
  );
  console.log(`  ${line}`);

  let gsTotal = { passed: 0, total: 0, latency: 0, tokens: 0 };
  let shTotal = { passed: 0, total: 0, latency: 0, tokens: 0 };

  for (const report of reports) {
    const gs = report.results.find((r) => r.system === "groundstate");
    const sh = report.results.find((r) => r.system === "stagehand");

    if (gs) {
      const passed = gs.postconditions.filter((p) => p.passed).length;
      const total = gs.postconditions.length;
      const acc = `${passed}/${total} ${pct(passed, total)}`;
      const lat = gs.error ? "ERROR" : `${gs.latencyMs}ms`;
      console.log(
        `  ${report.task.name.padEnd(24)} ${"GS".padEnd(12)} ${acc.padEnd(14)} ${lat.padEnd(12)} ${String(gs.tokensConsumed).padEnd(10)}`,
      );
      gsTotal.passed += passed;
      gsTotal.total += total;
      gsTotal.latency += gs.latencyMs;
      gsTotal.tokens += gs.tokensConsumed;
      if (gs.error) console.log(`    ${"ERROR:".padEnd(36)} ${gs.error.slice(0, 80)}`);
    }

    if (sh) {
      const passed = sh.postconditions.filter((p) => p.passed).length;
      const total = sh.postconditions.length;
      const acc = `${passed}/${total} ${pct(passed, total)}`;
      const lat = sh.error ? "ERROR" : `${sh.latencyMs}ms`;
      console.log(
        `  ${"".padEnd(24)} ${"Stagehand".padEnd(12)} ${acc.padEnd(14)} ${lat.padEnd(12)} ${`~${sh.tokensConsumed}`.padEnd(10)}`,
      );
      shTotal.passed += passed;
      shTotal.total += total;
      shTotal.latency += sh.latencyMs;
      shTotal.tokens += sh.tokensConsumed;
      if (sh.error) console.log(`    ${"ERROR:".padEnd(36)} ${sh.error.slice(0, 80)}`);
    } else {
      console.log(
        `  ${"".padEnd(24)} ${"Stagehand".padEnd(12)} ${"(skipped)".padEnd(14)} ${"—".padEnd(12)} ${"—".padEnd(10)}`,
      );
    }
    console.log(`  ${line}`);
  }

  // Totals
  console.log(
    `  ${"TOTAL".padEnd(24)} ${"GS".padEnd(12)} ${`${gsTotal.passed}/${gsTotal.total} ${pct(gsTotal.passed, gsTotal.total)}`.padEnd(14)} ${`${gsTotal.latency}ms`.padEnd(12)} ${String(gsTotal.tokens).padEnd(10)}`,
  );
  if (shTotal.total > 0) {
    console.log(
      `  ${"".padEnd(24)} ${"Stagehand".padEnd(12)} ${`${shTotal.passed}/${shTotal.total} ${pct(shTotal.passed, shTotal.total)}`.padEnd(14)} ${`${shTotal.latency}ms`.padEnd(12)} ${`~${shTotal.tokens}`.padEnd(10)}`,
    );
  }
  console.log();
}

export function writeHtmlReport(artifactsDir: string, reports: TaskReport[]) {
  mkdirSync(artifactsDir, { recursive: true });

  const rows = reports
    .flatMap((report) =>
      report.results.map((result) => {
        const passed = result.postconditions.filter((p) => p.passed).length;
        const total = result.postconditions.length;
        const allPassed = passed === total;
        return `
          <tr class="${allPassed ? "pass" : "fail"}">
            <td>${esc(report.task.name)}</td>
            <td>${esc(result.system)}</td>
            <td>${passed}/${total} (${pct(passed, total)})</td>
            <td>${result.error ? "ERROR" : `${result.latencyMs}ms`}</td>
            <td>${result.system === "stagehand" ? "~" : ""}${result.tokensConsumed}</td>
            <td class="postconditions">${result.postconditions
              .map(
                (pc) =>
                  `<span class="${pc.passed ? "pc-pass" : "pc-fail"}">${pc.passed ? "PASS" : "FAIL"} ${esc(pc.description)}</span>`,
              )
              .join("<br>")}</td>
            ${result.error ? `<td class="error">${esc(result.error.slice(0, 200))}</td>` : "<td></td>"}
          </tr>`;
      }),
    )
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Groundstate vs Stagehand</title>
  <style>
    :root { --bg: #fafaf9; --card: #ffffff; --green: #166534; --red: #991b1b; --muted: #78716c; --line: #e7e5e4; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: var(--bg); color: #1c1917; margin: 0; padding: 40px 20px; }
    .wrap { max-width: 1100px; margin: 0 auto; }
    h1 { font-size: 28px; margin-bottom: 8px; }
    .subtitle { color: var(--muted); margin-bottom: 32px; }
    table { width: 100%; border-collapse: collapse; background: var(--card); border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
    th { background: #18181b; color: #f4f4f5; padding: 12px 16px; text-align: left; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px; }
    td { padding: 12px 16px; border-bottom: 1px solid var(--line); font-size: 14px; }
    tr.pass td:first-child { border-left: 4px solid var(--green); }
    tr.fail td:first-child { border-left: 4px solid var(--red); }
    .pc-pass { color: var(--green); }
    .pc-fail { color: var(--red); font-weight: 600; }
    .postconditions { font-size: 12px; line-height: 1.6; }
    .error { color: var(--red); font-size: 12px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Groundstate vs Stagehand</h1>
    <p class="subtitle">Live browsing benchmark — Hacker News + Wikipedia</p>
    <table>
      <thead>
        <tr>
          <th>Task</th>
          <th>System</th>
          <th>Accuracy</th>
          <th>Latency</th>
          <th>Tokens</th>
          <th>Postconditions</th>
          <th>Error</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </div>
</body>
</html>`;

  writeFileSync(join(artifactsDir, "report.html"), html, "utf-8");
  console.log(`  Report written to ${join(artifactsDir, "report.html")}`);
}

function pct(passed: number, total: number): string {
  if (total === 0) return "—";
  return `${Math.round((passed / total) * 100)}%`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
