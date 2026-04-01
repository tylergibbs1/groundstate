import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CdpClient, getPageWsUrl, launchChrome, sleep } from "./cdp.js";

interface CaseResult {
  readonly family: string;
  readonly name: string;
  readonly fixture: string;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly summary: string;
  readonly screenshotFile?: string;
  readonly details: Record<string, unknown>;
}

interface FamilyDefinition {
  readonly name: string;
  readonly description: string;
  readonly cases: readonly GeneralizationCase[];
}

interface GeneralizationCase {
  readonly name: string;
  readonly fixture: string;
  readonly run: (cdp: CdpClient) => Promise<Record<string, unknown>>;
  readonly validate: (details: Record<string, unknown>) => { passed: boolean; summary: string };
}

function expect(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function countByKind(entities: any[], kind: string): number {
  return entities.filter((entity) => entity._entity === kind).length;
}

function extractSearchResultDetails(entities: any[]) {
  const searchResults = entities.filter((entity) => entity._entity === "SearchResult");
  const links = entities.filter((entity) => entity._entity === "Link");
  const listItems = entities.filter((entity) => entity._entity === "ListItem");
  return {
    searchResults: searchResults.length,
    links: links.length,
    listItems: listItems.length,
    titles: searchResults.map((entity) => entity.title).filter(Boolean),
  };
}

function extractTableDetails(entities: any[]) {
  const tables = entities.filter((entity) => entity._entity === "Table");
  const rows = entities.filter((entity) => entity._entity === "TableRow");
  return {
    tables: tables.length,
    rows: rows.length,
    headers: tables[0]?.headers ?? [],
  };
}

function extractFormDetails(entities: any[]) {
  return {
    forms: countByKind(entities, "Form"),
    buttons: countByKind(entities, "Button"),
    tables: countByKind(entities, "Table"),
    rows: countByKind(entities, "TableRow"),
  };
}

const FAMILIES: readonly FamilyDefinition[] = [
  {
    name: "result_entities",
    description:
      "Content-rich pages with very different DOM shapes should still produce SearchResult entities instead of nav/link noise.",
    cases: [
      {
        name: "search page cards become SearchResult entities",
        fixture: "search-results.html",
        run: async (cdp) => extractSearchResultDetails(await cdp.extractEntities()),
        validate: (details) => ({
          passed:
            Number(details.searchResults) === 3 &&
            Array.isArray(details.titles) &&
            (details.titles as string[]).includes(
              "Reactive browser runtime architecture for resilient agents",
            ),
          summary: `expected 3 content results; got ${details.searchResults}`,
        }),
      },
      {
        name: "docs featured guides also become SearchResult entities",
        fixture: "docs-home.html",
        run: async (cdp) => extractSearchResultDetails(await cdp.extractEntities()),
        validate: (details) => ({
          passed:
            Number(details.searchResults) === 3 &&
            Number(details.listItems) >= 4 &&
            Array.isArray(details.titles) &&
            (details.titles as string[]).includes("World models for browser sessions"),
          summary: `expected docs page to yield 3 guide results and sidebar list items; got results=${details.searchResults}, items=${details.listItems}`,
        }),
      },
    ],
  },
  {
    name: "tabular_entities",
    description:
      "Tables should extract stably whether they are plain data grids or buried inside noisy dashboards.",
    cases: [
      {
        name: "plain invoice table extracts stable headers and rows",
        fixture: "invoices.html",
        run: async (cdp) => extractTableDetails(await cdp.extractEntities()),
        validate: (details) => ({
          passed:
            Number(details.tables) === 1 &&
            Number(details.rows) === 6 &&
            JSON.stringify(details.headers) ===
              JSON.stringify(["Vendor", "Amount", "Status", "Due Date"]),
          summary: `expected 1 table / 6 rows with invoice headers; got tables=${details.tables}, rows=${details.rows}`,
        }),
      },
      {
        name: "noisy dashboard still isolates the real data table",
        fixture: "nested-noise.html",
        run: async (cdp) => extractTableDetails(await cdp.extractEntities()),
        validate: (details) => ({
          passed: Number(details.tables) === 1 && Number(details.rows) === 6,
          summary: `expected noisy dashboard to yield exactly 1 table / 6 rows; got tables=${details.tables}, rows=${details.rows}`,
        }),
      },
    ],
  },
  {
    name: "workflow_forms",
    description:
      "Interactive workflows should resolve to form semantics even when state changes from inline validation to full auth replacement.",
    cases: [
      {
        name: "validation errors preserve form semantics",
        fixture: "validation-error.html",
        run: async (cdp) => {
          await cdp.click('button[type="submit"]');
          await sleep(150);
          return extractFormDetails(await cdp.extractEntities());
        },
        validate: (details) => ({
          passed: Number(details.forms) >= 1 && Number(details.buttons) >= 1,
          summary: `expected visible validation workflow to still expose a form; got forms=${details.forms}, buttons=${details.buttons}`,
        }),
      },
      {
        name: "auth timeout replacement re-roots around the login form",
        fixture: "auth-timeout.html",
        run: async (cdp) => {
          await cdp.evalJS(`window.expireSession?.()`);
          await cdp.waitFor(`Boolean(document.querySelector("#login-form"))`, {
            timeoutMs: 3000,
          });
          return extractFormDetails(await cdp.extractEntities());
        },
        validate: (details) => ({
          passed:
            Number(details.forms) >= 1 &&
            Number(details.buttons) >= 1 &&
            Number(details.tables) === 0,
          summary: `expected expired page to pivot from table to login form; got forms=${details.forms}, tables=${details.tables}`,
        }),
      },
    ],
  },
];

function generateGeneralizationReport(
  artifactsDir: string,
  families: readonly FamilyDefinition[],
  results: readonly CaseResult[],
) {
  const familySections = families
    .map((family) => {
      const familyResults = results.filter((result) => result.family === family.name);
      const passed = familyResults.filter((result) => result.passed).length;
      const cards = familyResults
        .map((result) => {
          const screenshot = result.screenshotFile
            ? `<img src="./${escapeHtml(result.screenshotFile)}" alt="${escapeHtml(result.name)}" />`
            : `<div class="placeholder">No screenshot</div>`;
          return `
            <article class="card">
              <header>
                <div>
                  <p class="fixture">${escapeHtml(result.fixture)}</p>
                  <h3>${escapeHtml(result.name)}</h3>
                </div>
                <span class="status ${result.passed ? "pass" : "fail"}">${result.passed ? "pass" : "fail"}</span>
              </header>
              <p class="summary">${escapeHtml(result.summary)}</p>
              <div class="meta">
                <span>${result.durationMs}ms</span>
              </div>
              <figure>${screenshot}</figure>
              <pre>${escapeHtml(JSON.stringify(result.details, null, 2))}</pre>
            </article>
          `;
        })
        .join("");

      return `
        <section class="family">
          <div class="family-header">
            <div>
              <p class="eyebrow">${escapeHtml(family.name)}</p>
              <h2>${escapeHtml(family.description)}</h2>
            </div>
            <div class="family-score ${passed === familyResults.length ? "pass" : "warn"}">
              ${passed}/${familyResults.length}
            </div>
          </div>
          <div class="cards">${cards}</div>
        </section>
      `;
    })
    .join("");

  const totalFamilies = families.length;
  const fullyPassingFamilies = families.filter((family) => {
    const familyResults = results.filter((result) => result.family === family.name);
    return familyResults.length > 0 && familyResults.every((result) => result.passed);
  }).length;
  const overallPassRate =
    results.length === 0 ? 0 : results.filter((result) => result.passed).length / results.length;

  const html = `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Groundstate Generalization Benchmark</title>
    <style>
      :root {
        --bg: #f7f3ec;
        --panel: rgba(255,255,255,0.88);
        --ink: #1f1a16;
        --muted: #6c6257;
        --line: rgba(31,26,22,0.12);
        --green: #166534;
        --red: #991b1b;
        --amber: #92400e;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        color: var(--ink);
        font-family: "Iowan Old Style", "Palatino Linotype", serif;
        background:
          radial-gradient(circle at top left, rgba(22,101,52,0.08), transparent 26%),
          radial-gradient(circle at top right, rgba(146,64,14,0.08), transparent 22%),
          linear-gradient(180deg, #fbf8f3 0%, var(--bg) 100%);
      }
      .wrap { max-width: 1360px; margin: 0 auto; padding: 32px 24px 72px; }
      .hero h1 { margin: 8px 0 12px; font-size: clamp(36px, 6vw, 64px); line-height: 0.96; max-width: 10ch; }
      .kicker, .eyebrow, .fixture, .meta span {
        color: var(--muted);
        font: 600 12px/1.3 ui-monospace, SFMono-Regular, monospace;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .lede { max-width: 72ch; color: var(--muted); font-size: 18px; line-height: 1.55; }
      .summary-strip {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 16px;
        margin: 26px 0 36px;
      }
      .summary-strip article {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 16px 18px;
      }
      .summary-strip strong { display: block; margin-top: 8px; font-size: 28px; }
      .family { margin-top: 42px; }
      .family-header {
        display: flex;
        justify-content: space-between;
        gap: 18px;
        align-items: start;
        margin-bottom: 18px;
      }
      .family-header h2 { margin: 6px 0 0; max-width: 44rem; font-size: 28px; line-height: 1.1; }
      .family-score {
        border-radius: 999px;
        padding: 10px 14px;
        font: 700 12px/1 ui-monospace, SFMono-Regular, monospace;
      }
      .family-score.pass { background: rgba(22,101,52,0.12); color: var(--green); }
      .family-score.warn { background: rgba(146,64,14,0.12); color: var(--amber); }
      .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
      .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 22px;
        overflow: hidden;
        box-shadow: 0 18px 42px rgba(31,26,22,0.08);
      }
      .card header {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding: 18px 18px 10px;
      }
      .card h3 { margin: 8px 0 0; font-size: 22px; line-height: 1.08; }
      .status {
        align-self: start;
        border-radius: 999px;
        padding: 8px 12px;
        font: 700 12px/1 ui-monospace, SFMono-Regular, monospace;
        text-transform: uppercase;
      }
      .status.pass { background: rgba(22,101,52,0.12); color: var(--green); }
      .status.fail { background: rgba(153,27,27,0.12); color: var(--red); }
      .summary { padding: 0 18px; color: var(--muted); min-height: 48px; }
      .meta { padding: 10px 18px 0; }
      figure { margin: 14px 18px; border: 1px solid var(--line); border-radius: 16px; overflow: hidden; background: rgba(255,255,255,0.7); }
      figure img, .placeholder { display: block; width: 100%; aspect-ratio: 16 / 10; object-fit: cover; }
      .placeholder { display: grid; place-items: center; color: var(--muted); font: 600 12px/1 ui-monospace, SFMono-Regular, monospace; }
      pre {
        margin: 0 18px 18px;
        padding: 12px;
        border-radius: 14px;
        overflow: auto;
        background: #171717;
        color: #f5f5f5;
        font: 12px/1.45 ui-monospace, SFMono-Regular, monospace;
      }
      @media (max-width: 800px) {
        .summary-strip { grid-template-columns: 1fr; }
        .family-header { display: block; }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <header class="hero">
        <p class="kicker">Groundstate · generalization benchmark</p>
        <h1>Can the same semantic model survive different page shapes?</h1>
        <p class="lede">
          This suite is the anti-overfitting check. Families group fixtures that express the same browser concept through very different markup so we can measure whether Groundstate is learning stable page structure instead of just winning one demo.
        </p>
      </header>
      <section class="summary-strip">
        <article>
          <span class="eyebrow">Overall case pass rate</span>
          <strong>${(overallPassRate * 100).toFixed(0)}%</strong>
        </article>
        <article>
          <span class="eyebrow">Families fully passing</span>
          <strong>${fullyPassingFamilies}/${totalFamilies}</strong>
        </article>
        <article>
          <span class="eyebrow">North-star score</span>
          <strong>${Math.round((fullyPassingFamilies / totalFamilies) * 100)}%</strong>
        </article>
      </section>
      ${familySections}
    </div>
  </body>
  </html>`;

  writeFileSync(join(artifactsDir, "report.html"), html, "utf-8");
}

export async function runGeneralizationBenchmark(
  opts: { visible?: boolean; verbose?: boolean; stepDelayMs?: number } = {},
) {
  const visible = opts.visible ?? false;
  const verbose = opts.verbose ?? false;
  const stepDelayMs = opts.stepDelayMs ?? (visible ? 800 : 0);
  const port = 9555;
  const artifactsDir = resolve(
    import.meta.dirname ?? process.cwd(),
    "../artifacts/generalization-benchmark",
  );
  mkdirSync(artifactsDir, { recursive: true });
  rmSync(join(artifactsDir, "results.json"), { force: true });

  const fixturesDir = resolve(import.meta.dirname ?? process.cwd(), "../../../fixtures");
  const chrome = await launchChrome(port, { headless: !visible });
  const results: CaseResult[] = [];

  try {
    for (const family of FAMILIES) {
      for (const testCase of family.cases) {
        const cdp = new CdpClient();
        const started = Date.now();
        try {
          const wsUrl = await getPageWsUrl(port);
          await cdp.connect(wsUrl);
          await cdp.navigate(`file://${fixturesDir}/${testCase.fixture}`);
          if (stepDelayMs > 0) await sleep(stepDelayMs);

          const details = await testCase.run(cdp);
          const verdict = testCase.validate(details);
          const screenshotFile = `${family.name}-${testCase.fixture.replace(/\.html$/, "")}.png`;
          await cdp.saveScreenshot(join(artifactsDir, screenshotFile));

          const result: CaseResult = {
            family: family.name,
            name: testCase.name,
            fixture: testCase.fixture,
            passed: verdict.passed,
            durationMs: Date.now() - started,
            summary: verdict.summary,
            screenshotFile,
            details,
          };
          results.push(result);

          if (verbose) {
            console.log(
              `${result.passed ? "✓" : "✗"} [${family.name}] ${testCase.name} (${result.durationMs}ms)`,
            );
          }
        } catch (error) {
          const result: CaseResult = {
            family: family.name,
            name: testCase.name,
            fixture: testCase.fixture,
            passed: false,
            durationMs: Date.now() - started,
            summary: error instanceof Error ? error.message : String(error),
            details: {},
          };
          results.push(result);
          if (verbose) {
            console.log(`✗ [${family.name}] ${testCase.name} (${result.durationMs}ms)`);
            console.log(`  ${result.summary}`);
          }
        } finally {
          cdp.close();
        }
      }
    }
  } finally {
    chrome.kill();
  }

  writeFileSync(join(artifactsDir, "results.json"), JSON.stringify(results, null, 2), "utf-8");
  generateGeneralizationReport(artifactsDir, FAMILIES, results);

  const total = results.length;
  const passed = results.filter((result) => result.passed).length;
  const familyPasses = FAMILIES.filter((family) => {
    const familyResults = results.filter((result) => result.family === family.name);
    return familyResults.length > 0 && familyResults.every((result) => result.passed);
  }).length;

  return {
    total,
    passed,
    overallPassRate: total === 0 ? 0 : passed / total,
    familyPasses,
    totalFamilies: FAMILIES.length,
    reportPath: join(artifactsDir, "report.html"),
    resultsPath: join(artifactsDir, "results.json"),
  };
}
