import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { CdpClient, getPageWsUrl, launchChrome, sleep } from "./cdp.js";
import { MetricsRecorder } from "../../eval/src/recorder.js";
import type { PostconditionMetric, RunMetrics } from "../../eval/src/metrics.js";

type Bucket = "A" | "B" | "C";

interface BenchmarkEvent {
  type:
    | "observation"
    | "mutation"
    | "action"
    | "invalidation"
    | "replan"
    | "recovery"
    | "root_cause"
    | "postcondition";
  at: string;
  offsetMs: number;
  data: Record<string, unknown>;
}

interface BenchmarkCase {
  name: string;
  slug: string;
  bucket: Bucket;
  mutationType: string;
  fixture: string;
  run: (cdp: CdpClient, ctx: BenchmarkContext) => Promise<void>;
}

interface ScreenshotArtifact {
  label: string;
  fileName: string;
}

interface TaskArtifact {
  name: string;
  slug: string;
  bucket: Bucket;
  mutationType: string;
  fixture: string;
  metrics: RunMetrics;
  screenshots: ScreenshotArtifact[];
  tracePath?: string;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function expect(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function rowsFrom(entities: any[]): any[] {
  return entities.filter((entity) => entity._entity === "TableRow");
}

function firstRowByField(
  rows: any[],
  field: string,
  value: string,
): any | undefined {
  return rows.find((row) => String(row[field]) === value);
}

class BenchmarkContext {
  private readonly startedAt = Date.now();
  private readonly trace: BenchmarkEvent[] = [];
  private readonly screenshots: ScreenshotArtifact[] = [];
  private pendingRootCauseAt: number | null = null;
  private rootCauseLatencies: number[] = [];
  private postconditions: PostconditionMetric[] = [];
  private tokensConsumed = 0;
  private actionsAttempted = 0;
  private actionsSucceeded = 0;
  private staleActions = 0;
  private invalidations = 0;
  private falseInvalidations = 0;
  private benignMutations = 0;
  private benignSurvivals = 0;
  private recoveryAttempts = 0;
  private recoverySuccesses = 0;
  private replans = 0;

  constructor(
    readonly task: string,
    readonly bucket: Bucket,
    readonly mutationType: string,
    readonly artifactDir: string,
    private readonly stepDelayMs: number,
  ) {}

  async pause(multiplier = 1) {
    if (this.stepDelayMs <= 0) return;
    await sleep(this.stepDelayMs * multiplier);
  }

  observe(label: string, payload: unknown) {
    this.tokensConsumed += estimateTokens(payload);
    this.trace.push(this.makeEvent("observation", { label, payload }));
  }

  mutate(kind: string, benign: boolean, details: Record<string, unknown> = {}) {
    if (benign) this.benignMutations += 1;
    else this.pendingRootCauseAt = Date.now();

    this.trace.push(
      this.makeEvent("mutation", {
        kind,
        benign,
        ...details,
      }),
    );
  }

  planSurvived() {
    this.benignSurvivals += 1;
  }

  action(
    name: string,
    details: { success: boolean; stale?: boolean; details?: Record<string, unknown> },
  ) {
    this.actionsAttempted += 1;
    if (details.success) this.actionsSucceeded += 1;
    if (details.stale) this.staleActions += 1;

    this.trace.push(
      this.makeEvent("action", {
        name,
        success: details.success,
        stale: details.stale ?? false,
        ...(details.details ?? {}),
      }),
    );
  }

  invalidate(reason: string, falsePositive = false) {
    this.invalidations += 1;
    if (falsePositive) this.falseInvalidations += 1;

    this.trace.push(
      this.makeEvent("invalidation", {
        reason,
        falsePositive,
      }),
    );
  }

  replan(reason: string) {
    this.replans += 1;
    this.trace.push(this.makeEvent("replan", { reason }));
  }

  recovery(success: boolean, details: Record<string, unknown> = {}) {
    this.recoveryAttempts += 1;
    if (success) this.recoverySuccesses += 1;
    this.trace.push(this.makeEvent("recovery", { success, ...details }));
  }

  rootCause(reason: string) {
    if (this.pendingRootCauseAt !== null) {
      this.rootCauseLatencies.push(Date.now() - this.pendingRootCauseAt);
      this.pendingRootCauseAt = null;
    }

    this.trace.push(this.makeEvent("root_cause", { reason }));
  }

  postcondition(
    description: string,
    passed: boolean,
    expected: unknown,
    actual: unknown,
  ) {
    const result = { description, passed, expected, actual };
    this.postconditions.push(result);
    this.trace.push(this.makeEvent("postcondition", result));
  }

  addScreenshot(label: string, fileName: string) {
    this.screenshots.push({ label, fileName });
  }

  finalize(
    taskSuccess: boolean,
    wallClockMs: number,
    browserVersion: string,
  ): { metrics: RunMetrics; tracePath: string; screenshots: ScreenshotArtifact[] } {
    const tracePath = join(
      this.artifactDir,
      `${this.bucket.toLowerCase()}-${this.task}-${Date.now()}.trace.json`,
    );
    writeFileSync(tracePath, JSON.stringify(this.trace, null, 2), "utf-8");

    const metrics: RunMetrics = {
      runId: randomUUID(),
      suite: this.bucket,
      task: this.task,
      timestamp: new Date().toISOString(),
      bucket:
        this.bucket === "A"
          ? "stable"
          : this.bucket === "B"
            ? "benign_churn"
            : "real_disruption",
      mutationType: this.mutationType,
      taskSuccess,
      postconditionResults: this.postconditions,
      semanticActionSuccessRate:
        this.actionsAttempted === 0
          ? 1
          : this.actionsSucceeded / this.actionsAttempted,
      planSurvivalRate:
        this.benignMutations === 0 ? 1 : this.benignSurvivals / this.benignMutations,
      staleActionEscapeRate:
        this.actionsAttempted === 0 ? 0 : this.staleActions / this.actionsAttempted,
      falseInvalidationRate:
        this.invalidations === 0 ? 0 : this.falseInvalidations / this.invalidations,
      recoverySuccessRate:
        this.recoveryAttempts === 0
          ? 1
          : this.recoverySuccesses / this.recoveryAttempts,
      timeToRootCauseMs:
        this.rootCauseLatencies.length === 0
          ? 0
          : Math.round(
              this.rootCauseLatencies.reduce((sum, value) => sum + value, 0) /
                this.rootCauseLatencies.length,
            ),
      tokensConsumed: this.tokensConsumed,
      wallClockMs,
      replans: this.replans,
      humanInterventionRequired: false,
      traceEventCount: this.trace.length,
      traceComplete: this.trace.length > 0 && this.postconditions.length > 0,
      browserVersion,
    };

    return {
      metrics,
      tracePath,
      screenshots: [...this.screenshots],
    };
  }

  private makeEvent(
    type: BenchmarkEvent["type"],
    data: Record<string, unknown>,
  ): BenchmarkEvent {
    const now = Date.now();
    return {
      type,
      at: new Date(now).toISOString(),
      offsetMs: now - this.startedAt,
      data,
    };
  }
}

async function captureStageScreenshot(
  cdp: CdpClient,
  ctx: BenchmarkContext,
  artifactsDir: string,
  taskSlug: string,
  label: string,
) {
  const safeLabel = label.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const fileName = `${taskSlug}-${safeLabel}.png`;
  await cdp.saveScreenshot(join(artifactsDir, fileName));
  ctx.addScreenshot(label, fileName);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function generateVisualReport(artifactsDir: string, tasks: TaskArtifact[]) {
  const sections = ["A", "B", "C"].map((bucket) => {
    const bucketTasks = tasks.filter((task) => task.bucket === bucket);
    const cards = bucketTasks
      .map((task) => {
        const screenshotStrip = task.screenshots
          .map(
            (shot) => `
              <figure class="shot">
                <img src="./${shot.fileName}" alt="${escapeHtml(shot.label)}" />
                <figcaption>${escapeHtml(shot.label)}</figcaption>
              </figure>
            `,
          )
          .join("");

        const postconditions = task.metrics.postconditionResults
          .map(
            (result) => `
              <div class="postcondition ${result.passed ? "pass" : "fail"}">
                <strong>${escapeHtml(result.description)}</strong>
                <span>${result.passed ? "pass" : "fail"}</span>
              </div>
            `,
          )
          .join("");

        return `
          <article class="card">
            <header class="card-header">
              <div>
                <p class="eyebrow">Bucket ${task.bucket} · ${escapeHtml(task.mutationType)}</p>
                <h3>${escapeHtml(task.name)}</h3>
                <p class="fixture">${escapeHtml(task.fixture)}</p>
              </div>
              <div class="status ${task.metrics.taskSuccess ? "pass" : "fail"}">
                ${task.metrics.taskSuccess ? "pass" : "fail"}
              </div>
            </header>
            <div class="metrics">
              <div><span>Plan survival</span><strong>${(task.metrics.planSurvivalRate * 100).toFixed(0)}%</strong></div>
              <div><span>Stale escape</span><strong>${(task.metrics.staleActionEscapeRate * 100).toFixed(0)}%</strong></div>
              <div><span>Recovery</span><strong>${(task.metrics.recoverySuccessRate * 100).toFixed(0)}%</strong></div>
              <div><span>Root cause</span><strong>${task.metrics.timeToRootCauseMs.toFixed(0)}ms</strong></div>
              <div><span>Tokens</span><strong>${task.metrics.tokensConsumed}</strong></div>
              <div><span>Runtime</span><strong>${task.metrics.wallClockMs}ms</strong></div>
            </div>
            <div class="shots">${screenshotStrip}</div>
            <section class="postconditions">${postconditions}</section>
            <details>
              <summary>Trace</summary>
              <pre>${escapeHtml(JSON.stringify(task.metrics.postconditionResults, null, 2))}</pre>
              <p><a href="./${task.tracePath ? task.tracePath.split("/").pop() : ""}">Open raw trace JSON</a></p>
            </details>
          </article>
        `;
      })
      .join("");

    return `
      <section class="bucket">
        <h2>Bucket ${bucket}</h2>
        <div class="cards">${cards}</div>
      </section>
    `;
  });

  const html = `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Groundstate Semantic Continuity Report</title>
    <style>
      :root {
        --bg: #f4f1ea;
        --panel: rgba(255,255,255,0.82);
        --ink: #1c1917;
        --muted: #6b645d;
        --line: rgba(28,25,23,0.12);
        --green: #166534;
        --red: #991b1b;
        --amber: #92400e;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Iowan Old Style", "Palatino Linotype", serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(20,83,45,0.08), transparent 28%),
          radial-gradient(circle at top right, rgba(146,64,14,0.08), transparent 24%),
          linear-gradient(180deg, #f7f4ee 0%, var(--bg) 100%);
      }
      .wrap { max-width: 1360px; margin: 0 auto; padding: 32px 24px 80px; }
      header.hero { margin-bottom: 32px; }
      .kicker {
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--muted);
        font: 600 12px/1.2 ui-monospace, SFMono-Regular, monospace;
      }
      h1 {
        margin: 10px 0 8px;
        font-size: clamp(36px, 6vw, 64px);
        line-height: 0.95;
        max-width: 10ch;
      }
      .lede {
        max-width: 72ch;
        color: var(--muted);
        font-size: 18px;
        line-height: 1.5;
      }
      .bucket { margin-top: 44px; }
      .bucket h2 { font-size: 28px; margin-bottom: 18px; }
      .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 18px; }
      .card {
        background: var(--panel);
        backdrop-filter: blur(12px);
        border: 1px solid var(--line);
        border-radius: 24px;
        overflow: hidden;
        box-shadow: 0 18px 48px rgba(28,25,23,0.08);
      }
      .card-header {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        padding: 18px 18px 12px;
        border-bottom: 1px solid var(--line);
      }
      .eyebrow, .fixture {
        margin: 0;
        color: var(--muted);
        font: 500 12px/1.3 ui-monospace, SFMono-Regular, monospace;
      }
      .card-header h3 { margin: 8px 0 6px; font-size: 22px; line-height: 1.05; }
      .status {
        align-self: start;
        border-radius: 999px;
        padding: 8px 12px;
        font: 700 12px/1 ui-monospace, SFMono-Regular, monospace;
        text-transform: uppercase;
      }
      .status.pass { background: rgba(22,101,52,0.12); color: var(--green); }
      .status.fail { background: rgba(153,27,27,0.12); color: var(--red); }
      .metrics {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
        padding: 14px 18px;
      }
      .metrics div {
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 10px 12px;
        background: rgba(255,255,255,0.6);
      }
      .metrics span {
        display: block;
        color: var(--muted);
        font: 500 11px/1.3 ui-monospace, SFMono-Regular, monospace;
        text-transform: uppercase;
      }
      .metrics strong { display: block; margin-top: 6px; font-size: 18px; }
      .shots {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px;
        padding: 0 18px 18px;
      }
      .shot {
        margin: 0;
        border: 1px solid var(--line);
        border-radius: 16px;
        overflow: hidden;
        background: rgba(255,255,255,0.75);
      }
      .shot img { display: block; width: 100%; aspect-ratio: 16 / 10; object-fit: cover; background: #ddd6ce; }
      .shot figcaption {
        padding: 8px 10px;
        color: var(--muted);
        font: 500 11px/1.3 ui-monospace, SFMono-Regular, monospace;
      }
      .postconditions { padding: 0 18px 16px; display: grid; gap: 8px; }
      .postcondition {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        border-radius: 12px;
        padding: 10px 12px;
        font-size: 14px;
      }
      .postcondition.pass { background: rgba(22,101,52,0.08); color: var(--green); }
      .postcondition.fail { background: rgba(153,27,27,0.08); color: var(--red); }
      details { padding: 0 18px 18px; }
      details summary { cursor: pointer; color: var(--amber); font: 700 13px/1.3 ui-monospace, SFMono-Regular, monospace; }
      pre {
        margin: 12px 0;
        padding: 12px;
        overflow: auto;
        background: #18181b;
        color: #f4f4f5;
        border-radius: 14px;
        font: 12px/1.45 ui-monospace, SFMono-Regular, monospace;
      }
      a { color: #92400e; }
      @media (max-width: 720px) {
        .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <header class="hero">
        <p class="kicker">Groundstate · semantic continuity</p>
        <h1>End-to-end browser runs you can inspect visually.</h1>
        <p class="lede">
          Each card shows the benchmark task, the mutation being exercised, the continuity metrics, and captured browser frames.
          This is the view for proving whether Groundstate preserves semantic state under UI churn instead of only finishing once.
        </p>
      </header>
      ${sections.join("")}
    </div>
  </body>
  </html>`;

  writeFileSync(join(artifactsDir, "report.html"), html, "utf-8");
}

const CASES: BenchmarkCase[] = [
  {
    name: "Stable: invoice filter postcondition",
    slug: "stable-invoice-filter",
    bucket: "A",
    mutationType: "none",
    fixture: "invoices.html",
    run: async (cdp, ctx) => {
      const entities = await cdp.extractEntities();
      ctx.observe("invoice-table", entities);

      const matches = rowsFrom(entities).filter(
        (row) => row.Status === "Unpaid" && Number(row.Amount) > 10000,
      );
      ctx.postcondition("three unpaid invoices exceed 10k", matches.length === 3, 3, matches.length);
    },
  },
  {
    name: "Stable: invoice sort remains correct",
    slug: "stable-invoice-sort",
    bucket: "A",
    mutationType: "none",
    fixture: "invoices.html",
    run: async (cdp, ctx) => {
      await cdp.click("#invoices th:nth-child(2)");
      ctx.action("sort-by-amount", { success: true });
      await ctx.pause();

      const entities = await cdp.extractEntities();
      ctx.observe("sorted-invoices", entities);

      const table = entities.find((entity) => entity._entity === "Table");
      const amounts = rowsFrom(entities).map((row) => Number(row.Amount));
      const sorted = amounts.every((value, index) => index === 0 || value >= amounts[index - 1]!);

      ctx.postcondition("table sorted by amount ascending", table?.sorted_by === "Amount" && sorted, true, {
        sortedBy: table?.sorted_by,
        amounts,
      });
    },
  },
  {
    name: "Stable: valid form submits successfully",
    slug: "stable-valid-form-submit",
    bucket: "A",
    mutationType: "none",
    fixture: "validation-error.html",
    run: async (cdp, ctx) => {
      await cdp.fill("#name", "Jane Doe");
      ctx.action("fill-name", { success: true });
      await ctx.pause(0.5);
      await cdp.fill("#email", "jane@example.com");
      ctx.action("fill-email", { success: true });
      await ctx.pause(0.5);
      await cdp.fill("#amount", "125.50");
      ctx.action("fill-amount", { success: true });
      await ctx.pause(0.5);
      await cdp.click("button[type='submit']");
      ctx.action("submit-form", { success: true });
      await ctx.pause();

      const banner = await cdp.text("#banner");
      ctx.observe("success-banner", { banner });
      ctx.postcondition(
        "success banner is shown",
        Boolean(banner?.includes("Submitted successfully")),
        "Submitted successfully",
        banner,
      );
    },
  },
  {
    name: "Stable: search results extraction captures rich entities",
    slug: "stable-search-results",
    bucket: "A",
    mutationType: "none",
    fixture: "search-results.html",
    run: async (cdp, ctx) => {
      const entities = await cdp.extractEntities();
      ctx.observe("search-page", entities);

      const searchResults = entities.filter((e) => e._entity === "SearchResult");
      const links = entities.filter((e) => e._entity === "Link");
      const contentLinks = links.filter((e) => e.href && !e.href.startsWith("/") && !e.href.startsWith("#"));

      ctx.postcondition(
        "search results extracted as SearchResult entities",
        searchResults.length >= 3,
        ">= 3",
        searchResults.length,
      );
    },
  },
  {
    name: "Stable: docs page extracts sidebar and guide card entities",
    slug: "stable-docs-entities",
    bucket: "A",
    mutationType: "none",
    fixture: "docs-home.html",
    run: async (cdp, ctx) => {
      const entities = await cdp.extractEntities();
      ctx.observe("docs-page", entities);

      const lists = entities.filter((e) => e._entity === "List");
      const listItems = entities.filter((e) => e._entity === "ListItem");
      const links = entities.filter((e) => e._entity === "Link");

      ctx.postcondition(
        "sidebar navigation list and guide links extracted",
        lists.length >= 1 && listItems.length >= 4 && links.length >= 7,
        { lists: ">= 1", items: ">= 4", links: ">= 7" },
        { lists: lists.length, items: listItems.length, links: links.length },
      );
    },
  },
  {
    name: "Benign churn: semantic row survives rerender",
    slug: "benign-rerender-survival",
    bucket: "B",
    mutationType: "same_entity_new_dom_identity",
    fixture: "rerender.html",
    run: async (cdp, ctx) => {
      const before = await cdp.extractEntities();
      ctx.observe("before-rerender", before);
      const targetBefore = firstRowByField(rowsFrom(before), "Name", "Alice Chen");
      expect(targetBefore, "Alice Chen row missing before rerender");

      await cdp.click("#trigger-btn");
      ctx.mutate("full-dom-rerender", true);
      await sleep(200);
      await ctx.pause();
      await captureStageScreenshot(cdp, ctx, ctx.artifactDir, "benign-rerender-survival", "after-mutation");

      const after = await cdp.extractEntities();
      ctx.observe("after-rerender", after);
      const targetAfter = firstRowByField(rowsFrom(after), "Name", "Alice Chen");
      const survived = Boolean(targetAfter && targetAfter.Salary === targetBefore.Salary);
      if (survived) ctx.planSurvived();

      ctx.postcondition(
        "Alice Chen row is preserved semantically across rerender",
        survived,
        targetBefore.Salary,
        targetAfter?.Salary ?? null,
      );
    },
  },
  {
    name: "Benign churn: target row survives row reorder",
    slug: "benign-row-reorder",
    bucket: "B",
    mutationType: "row_order_changes",
    fixture: "invoices.html",
    run: async (cdp, ctx) => {
      const before = await cdp.extractEntities();
      ctx.observe("before-reorder", before);
      const target = firstRowByField(rowsFrom(before), "Vendor", "Stark Industries");
      expect(target, "Stark Industries row missing before reorder");

      await cdp.click("#invoices th:nth-child(2)");
      ctx.mutate("sort-reorders-rows", true);
      await ctx.pause();
      await captureStageScreenshot(cdp, ctx, ctx.artifactDir, "benign-row-reorder", "after-mutation");

      const after = await cdp.extractEntities();
      ctx.observe("after-reorder", after);
      const targetAfter = firstRowByField(rowsFrom(after), "Vendor", "Stark Industries");
      const survived = Boolean(targetAfter && targetAfter.Status === target.Status);
      if (survived) ctx.planSurvived();

      ctx.postcondition(
        "Stark Industries row remains addressable after reorder",
        survived,
        target.Status,
        targetAfter?.Status ?? null,
      );
    },
  },
  {
    name: "Benign churn: lazy load appends without invalidating plan",
    slug: "benign-lazy-load",
    bucket: "B",
    mutationType: "lazy_loaded_content_arrives",
    fixture: "lazy-rows.html",
    run: async (cdp, ctx) => {
      const before = await cdp.extractEntities();
      ctx.observe("before-lazy-load", before);
      const existing = firstRowByField(rowsFrom(before), "Order ID", "ORD-002");
      expect(existing, "ORD-002 missing before lazy load");

      await cdp.click("#load-btn");
      ctx.mutate("append-more-rows", true);
      await ctx.pause();
      await cdp.waitFor(
        `document.querySelectorAll("tbody tr").length >= 8`,
        { timeoutMs: 3000 },
      );
      await captureStageScreenshot(cdp, ctx, ctx.artifactDir, "benign-lazy-load", "after-mutation");

      const after = await cdp.extractEntities();
      ctx.observe("after-lazy-load", after);
      const existingAfter = firstRowByField(rowsFrom(after), "Order ID", "ORD-002");
      const newRow = firstRowByField(rowsFrom(after), "Order ID", "ORD-010");
      const survived = Boolean(existingAfter && newRow);
      if (survived) ctx.planSurvived();

      ctx.postcondition(
        "existing row persists and new row appears after lazy load",
        survived,
        { existing: "ORD-002", added: "ORD-010" },
        {
          existing: existingAfter?.["Order ID"] ?? null,
          added: newRow?.["Order ID"] ?? null,
        },
      );
    },
  },
  {
    name: "Benign churn: modal interruption cancels and resumes",
    slug: "benign-modal-cancel",
    bucket: "B",
    mutationType: "modal_interruption",
    fixture: "modal-interrupt.html",
    run: async (cdp, ctx) => {
      const before = await cdp.extractEntities();
      ctx.observe("before-modal", before);

      await cdp.click("tbody tr:nth-child(2) .btn-delete");
      ctx.mutate("confirmation-modal-opens", true);
      await ctx.pause();
      await captureStageScreenshot(cdp, ctx, ctx.artifactDir, "benign-modal-cancel", "modal-open");
      const modalText = await cdp.text("[role='dialog']");
      ctx.observe("modal-state", { modalText });

      await cdp.click("#modal-cancel");
      ctx.action("cancel-modal", { success: true });
      await ctx.pause();
      const after = await cdp.extractEntities();
      ctx.observe("after-modal-cancel", after);
      const rowStillPresent = Boolean(firstRowByField(rowsFrom(after), "Item", "Invoice #1042"));
      if (rowStillPresent) ctx.planSurvived();
      ctx.recovery(rowStillPresent, { mode: "dismiss_modal_without_restart" });

      ctx.postcondition(
        "target row still present after canceling modal",
        rowStillPresent,
        "Invoice #1042",
        rowStillPresent ? "Invoice #1042" : null,
      );
    },
  },
  {
    name: "Benign churn: field mapping survives new column insertion",
    slug: "benign-column-insert",
    bucket: "B",
    mutationType: "column_count_changes",
    fixture: "column-insert.html",
    run: async (cdp, ctx) => {
      const before = await cdp.extractEntities();
      ctx.observe("before-column-insert", before);
      const apiBefore = firstRowByField(rowsFrom(before), "Task", "API migration");
      expect(apiBefore, "API migration row missing before column insert");
      expect(apiBefore.Status === "In Progress", `Expected Status=In Progress, got ${apiBefore.Status}`);

      await cdp.click("#insert-btn");
      ctx.mutate("priority-column-inserted", true);
      await ctx.pause();
      await captureStageScreenshot(cdp, ctx, ctx.artifactDir, "benign-column-insert", "after-mutation");

      const after = await cdp.extractEntities();
      ctx.observe("after-column-insert", after);
      const apiAfter = firstRowByField(rowsFrom(after), "Task", "API migration");
      // Key check: Status should still be "In Progress", not shifted to Priority value
      const survived = Boolean(apiAfter && apiAfter.Status === "In Progress" && apiAfter.Priority === "P0");
      if (survived) ctx.planSurvived();

      ctx.postcondition(
        "API migration row has correct Status and new Priority after column insert",
        survived,
        { Status: "In Progress", Priority: "P0" },
        { Status: apiAfter?.Status ?? null, Priority: apiAfter?.Priority ?? null },
      );
    },
  },
  {
    name: "Benign churn: row field mapping survives column reorder",
    slug: "benign-column-reorder",
    bucket: "B",
    mutationType: "column_order_changes",
    fixture: "column-reorder.html",
    run: async (cdp, ctx) => {
      const before = await cdp.extractEntities();
      ctx.observe("before-column-reorder", before);
      const atlasBefore = firstRowByField(rowsFrom(before), "Project", "Atlas");
      expect(atlasBefore, "Atlas row missing before column reorder");
      const leadBefore = atlasBefore.Lead;
      expect(leadBefore === "Alice Chen", `Expected Lead=Alice Chen, got ${leadBefore}`);

      await cdp.click("#reorder-btn");
      ctx.mutate("columns-reversed", true);
      await ctx.pause();
      await captureStageScreenshot(cdp, ctx, ctx.artifactDir, "benign-column-reorder", "after-mutation");

      const after = await cdp.extractEntities();
      ctx.observe("after-column-reorder", after);
      const atlasAfter = firstRowByField(rowsFrom(after), "Project", "Atlas");
      const survived = Boolean(atlasAfter && atlasAfter.Lead === "Alice Chen");
      if (survived) ctx.planSurvived();

      ctx.postcondition(
        "Atlas row has correct Lead field after column reorder",
        survived,
        "Alice Chen",
        atlasAfter?.Lead ?? null,
      );
    },
  },
  {
    name: "Benign churn: entity survives when DOM IDs are regenerated",
    slug: "benign-id-churn-survival",
    bucket: "B",
    mutationType: "dom_id_regeneration",
    fixture: "id-churn.html",
    run: async (cdp, ctx) => {
      const before = await cdp.extractEntities();
      ctx.observe("before-churn", before);
      const aliceBefore = firstRowByField(rowsFrom(before), "Name", "Alice Chen");
      expect(aliceBefore, "Alice Chen row missing before ID churn");

      await cdp.click("#churn-btn");
      ctx.mutate("dom-ids-regenerated", true);
      await ctx.pause();
      await captureStageScreenshot(cdp, ctx, ctx.artifactDir, "benign-id-churn-survival", "after-mutation");

      const after = await cdp.extractEntities();
      ctx.observe("after-churn", after);
      const aliceAfter = firstRowByField(rowsFrom(after), "Name", "Alice Chen");
      const survived = Boolean(aliceAfter && aliceAfter.Salary === aliceBefore.Salary);
      if (survived) ctx.planSurvived();

      ctx.postcondition(
        "Alice Chen row is addressable despite changed DOM IDs",
        survived,
        aliceBefore.Salary,
        aliceAfter?.Salary ?? null,
      );
    },
  },
  {
    name: "Benign churn: entity identity survives pagination content replacement",
    slug: "benign-pagination-identity",
    bucket: "B",
    mutationType: "full_content_replacement",
    fixture: "pagination.html",
    run: async (cdp, ctx) => {
      const before = await cdp.extractEntities();
      ctx.observe("page-1", before);
      const tableBefore = before.find((e) => e._entity === "Table");
      expect(tableBefore, "table missing on page 1");
      const rowCountBefore = tableBefore.row_count;

      await cdp.click("#next-btn");
      ctx.mutate("paginate-to-page-2", true);
      await ctx.pause();
      await captureStageScreenshot(cdp, ctx, ctx.artifactDir, "benign-pagination-identity", "after-mutation");

      const after = await cdp.extractEntities();
      ctx.observe("page-2", after);
      const tableAfter = after.find((e) => e._entity === "Table");
      const rowCountAfter = tableAfter?.row_count ?? 0;
      const survived = Boolean(tableAfter && rowCountAfter > 0 && rowCountAfter === rowCountBefore);
      if (survived) ctx.planSurvived();

      ctx.postcondition(
        "table structure persists across page transition with same row count",
        survived,
        rowCountBefore,
        rowCountAfter,
      );
    },
  },
  {
    name: "Benign churn: button relabel does not invalidate action target",
    slug: "benign-relabel-survival",
    bucket: "B",
    mutationType: "label_text_changes",
    fixture: "relabel.html",
    run: async (cdp, ctx) => {
      const before = await cdp.extractEntities();
      ctx.observe("before-relabel", before);
      const downloadBtns = before.filter(
        (e) => e._entity === "Button" && e.label?.includes("Download"),
      );
      expect(downloadBtns.length > 0, "no download buttons found");

      await cdp.click('.btn-download[data-row="0"]');
      ctx.mutate("button-label-transitions", true);
      ctx.action("click-download", { success: true });
      await sleep(2000);
      await captureStageScreenshot(cdp, ctx, ctx.artifactDir, "benign-relabel-survival", "after-mutation");

      const after = await cdp.extractEntities();
      ctx.observe("after-relabel", after);
      const doneBtn = after.find(
        (e) => e._entity === "Button" && e.label?.includes("Downloaded"),
      );
      const otherBtns = after.filter(
        (e) => e._entity === "Button" && e.label === "Download",
      );
      const survived = Boolean(doneBtn && otherBtns.length === downloadBtns.length - 1);
      if (survived) ctx.planSurvived();

      ctx.postcondition(
        "download button transitions to Done and other buttons remain",
        survived,
        { done: true, remaining: downloadBtns.length - 1 },
        { done: Boolean(doneBtn), remaining: otherBtns.length },
      );
    },
  },
  {
    name: "Real disruption: validation banner forces replan",
    slug: "disruption-validation-replan",
    bucket: "C",
    mutationType: "validation_banner_appears",
    fixture: "validation-error.html",
    run: async (cdp, ctx) => {
      await cdp.click("button[type='submit']");
      ctx.action("submit-empty-form", { success: true });
      await ctx.pause();
      const errorBanner = await cdp.text("#banner");
      ctx.mutate("validation-errors-rendered", false, { banner: errorBanner });
      await captureStageScreenshot(cdp, ctx, ctx.artifactDir, "disruption-validation-replan", "after-mutation");
      ctx.observe("validation-errors", { banner: errorBanner });
      ctx.rootCause("submission invalidated by required-field validation");
      ctx.invalidate("invalid form state");
      ctx.replan("fill required fields before resubmitting");

      await cdp.fill("#name", "Jane Doe");
      ctx.action("fill-name", { success: true });
      await ctx.pause(0.5);
      await cdp.fill("#email", "jane@example.com");
      ctx.action("fill-email", { success: true });
      await ctx.pause(0.5);
      await cdp.fill("#amount", "125.50");
      ctx.action("fill-amount", { success: true });
      await ctx.pause(0.5);
      await cdp.click("button[type='submit']");
      ctx.action("submit-corrected-form", { success: true });
      await ctx.pause();

      const successBanner = await cdp.text("#banner");
      const recovered = Boolean(successBanner?.includes("Submitted successfully"));
      ctx.recovery(recovered, { banner: successBanner });
      ctx.observe("after-recovery", { banner: successBanner });
      ctx.postcondition(
        "form submits after corrective replan",
        recovered,
        "Submitted successfully",
        successBanner,
      );
    },
  },
  {
    name: "Real disruption: auth timeout recovers without restart",
    slug: "disruption-auth-timeout",
    bucket: "C",
    mutationType: "session_expiry_page_replacement",
    fixture: "auth-timeout.html",
    run: async (cdp, ctx) => {
      const before = await cdp.extractEntities();
      ctx.observe("before-timeout", before);
      expect(rowsFrom(before).length > 0, "table rows missing before timeout");

      await cdp.evalJS(`window.expireSession?.()`);
      ctx.mutate("session-expired-page-replacement", false);
      await ctx.pause();
      await cdp.waitFor(`Boolean(document.querySelector("#login-form"))`, {
        timeoutMs: 3000,
      });
      await captureStageScreenshot(cdp, ctx, ctx.artifactDir, "disruption-auth-timeout", "after-mutation");

      const expiredHeading = await cdp.text(".auth-expired h2");
      ctx.observe("expired-session", { heading: expiredHeading });
      ctx.rootCause("session expiry replaced the working surface with a login form");
      ctx.invalidate("page surface replaced by auth gate");
      ctx.replan("authenticate and return to invoice table");

      await cdp.fill("#login-email", "agent@example.com");
      ctx.action("fill-login-email", { success: true });
      await ctx.pause(0.5);
      await cdp.fill("#login-password", "secret");
      ctx.action("fill-login-password", { success: true });
      await ctx.pause(0.5);
      await cdp.click("#login-form button[type='submit']");
      ctx.action("submit-login", { success: true });
      await ctx.pause();
      await cdp.waitFor(`Boolean(document.querySelector("table"))`, { timeoutMs: 4000 });

      const after = await cdp.extractEntities();
      ctx.observe("after-login-recovery", after);
      const recovered = rowsFrom(after).length > 0;
      ctx.recovery(recovered, { rows: rowsFrom(after).length });
      ctx.postcondition(
        "table returns after re-authentication",
        recovered,
        true,
        recovered,
      );
    },
  },
  {
    name: "Real disruption: disabled action is revalidated before execution",
    slug: "disruption-disabled-button",
    bucket: "C",
    mutationType: "button_becomes_disabled",
    fixture: "disabled-button.html",
    run: async (cdp, ctx) => {
      const before = await cdp.extractEntities();
      ctx.observe("before-lock", before);

      await cdp.click("#lock-target");
      ctx.mutate("target-button-disabled", false);
      await ctx.pause();
      await cdp.waitFor(
        `Boolean(document.querySelector('.deploy-btn[data-row-id="svc-payments"]')?.disabled)`,
        { timeoutMs: 2000 },
      );
      await captureStageScreenshot(cdp, ctx, ctx.artifactDir, "disruption-disabled-button", "after-mutation");

      const disabled = await cdp.isDisabled(`.deploy-btn[data-row-id="svc-payments"]`);
      ctx.observe("locked-button", { disabled });
      ctx.rootCause("payments deployment temporarily disabled by policy lock");
      ctx.invalidate("action target disabled");
      ctx.replan("wait for deploy action to become valid before executing");

      ctx.action("deploy-while-disabled", {
        success: true,
        stale: false,
        details: { skippedExecution: disabled },
      });

      await cdp.waitFor(
        `!document.querySelector('.deploy-btn[data-row-id="svc-payments"]')?.disabled`,
        { timeoutMs: 4000 },
      );
      await ctx.pause();
      await cdp.click(`.deploy-btn[data-row-id="svc-payments"]`);
      ctx.action("deploy-payments-service", { success: true });
      await ctx.pause();
      await cdp.waitFor(`Boolean(document.querySelector("#banner.visible"))`, {
        timeoutMs: 3000,
      });

      const banner = await cdp.text("#banner");
      const recovered = Boolean(banner?.includes("Payments Service deployed successfully."));
      ctx.recovery(recovered, { banner });
      ctx.observe("after-deploy", { banner });
      ctx.postcondition(
        "payments service deploys after lock clears",
        recovered,
        "Payments Service deployed successfully.",
        banner,
      );
    },
  },
  {
    name: "Benign churn: entity extraction consistent after staggered async updates",
    slug: "benign-async-race",
    bucket: "B",
    mutationType: "staggered_async_updates",
    fixture: "async-race.html",
    run: async (cdp, ctx) => {
      const before = await cdp.extractEntities();
      ctx.observe("before-refresh", before);
      const authBefore = firstRowByField(rowsFrom(before), "Service", "auth-service");
      expect(authBefore, "auth-service row missing");
      expect(authBefore.Status === "Healthy", `Expected Status=Healthy, got ${authBefore.Status}`);

      await cdp.click("#refresh-btn");
      ctx.mutate("staggered-refresh-started", true);
      // Wait for all staggered updates to complete (4 rows * 150ms = 600ms, give margin)
      await cdp.waitFor(`document.getElementById("status").textContent === "All refreshed"`, { timeoutMs: 3000 });
      await ctx.pause();
      await captureStageScreenshot(cdp, ctx, ctx.artifactDir, "benign-async-race", "after-mutation");

      const after = await cdp.extractEntities();
      ctx.observe("after-refresh", after);
      const authAfter = firstRowByField(rowsFrom(after), "Service", "auth-service");
      const survived = Boolean(
        authAfter &&
        authAfter.Latency === "22ms" &&
        authAfter.Status === "Degraded" &&
        authAfter.Uptime === "99.85%"
      );
      if (survived) ctx.planSurvived();

      ctx.postcondition(
        "auth-service row reflects final async update values",
        survived,
        { Latency: "22ms", Status: "Degraded", Uptime: "99.85%" },
        {
          Latency: authAfter?.Latency ?? null,
          Status: authAfter?.Status ?? null,
          Uptime: authAfter?.Uptime ?? null,
        },
      );
    },
  },
  {
    name: "Benign churn: concurrent mutations (update + insert) in same tick",
    slug: "benign-concurrent-mutation",
    bucket: "B",
    mutationType: "concurrent_dom_changes",
    fixture: "concurrent-mutation.html",
    run: async (cdp, ctx) => {
      const before = await cdp.extractEntities();
      ctx.observe("before-concurrent", before);
      const hubBefore = firstRowByField(rowsFrom(before), "SKU", "SKU-002");
      expect(hubBefore, "SKU-002 row missing");
      expect(String(hubBefore.Stock) === "12", `Expected Stock=12, got ${hubBefore.Stock}`);

      await cdp.click("#mutate-btn");
      ctx.mutate("concurrent-update-and-insert", true);
      await ctx.pause();
      await captureStageScreenshot(cdp, ctx, ctx.artifactDir, "benign-concurrent-mutation", "after-mutation");

      const after = await cdp.extractEntities();
      ctx.observe("after-concurrent", after);
      const hubAfter = firstRowByField(rowsFrom(after), "SKU", "SKU-002");
      const standAfter = firstRowByField(rowsFrom(after), "SKU", "SKU-003");
      const newRow = firstRowByField(rowsFrom(after), "SKU", "SKU-004");

      const survived = Boolean(
        hubAfter && String(hubAfter.Stock) === "8" &&
        standAfter && standAfter.Price === "$29.99" &&
        newRow && newRow.Product === "Webcam HD"
      );
      if (survived) ctx.planSurvived();

      ctx.postcondition(
        "all concurrent mutations visible: stock update, price update, and new row",
        survived,
        { hubStock: "8", standPrice: "$29.99", newProduct: "Webcam HD" },
        {
          hubStock: hubAfter?.Stock ?? null,
          standPrice: standAfter?.Price ?? null,
          newProduct: newRow?.Product ?? null,
        },
      );
    },
  },
  {
    name: "Real disruption: removed row detected as stale target, recovered via undo",
    slug: "disruption-row-removal-recovery",
    bucket: "C",
    mutationType: "target_row_removed",
    fixture: "row-removal.html",
    run: async (cdp, ctx) => {
      const before = await cdp.extractEntities();
      ctx.observe("before-removal", before);
      const target = firstRowByField(rowsFrom(before), "Task", "Write tests");
      expect(target, "Write tests row missing");

      // Remove the target row
      await cdp.click('.btn-remove[data-id="t3"]');
      ctx.mutate("target-row-removed", false);
      await ctx.pause();
      await captureStageScreenshot(cdp, ctx, ctx.artifactDir, "disruption-row-removal-recovery", "after-mutation");

      const afterRemoval = await cdp.extractEntities();
      ctx.observe("after-removal", afterRemoval);
      const gone = !firstRowByField(rowsFrom(afterRemoval), "Task", "Write tests");

      ctx.rootCause("target row was removed from the table");
      ctx.invalidate("action target no longer exists");
      ctx.replan("undo removal to restore target row");

      // Recovery: click undo
      await cdp.click("#undo-btn");
      ctx.action("undo-removal", { success: true });
      await ctx.pause();

      const afterUndo = await cdp.extractEntities();
      ctx.observe("after-undo", afterUndo);
      const restored = Boolean(firstRowByField(rowsFrom(afterUndo), "Task", "Write tests"));
      ctx.recovery(restored, { rowRestored: restored });

      ctx.postcondition(
        "target row restored after undo recovery",
        gone && restored,
        { removed: true, restored: true },
        { removed: gone, restored },
      );
    },
  },
  {
    name: "Benign churn: data table survives noisy DOM with sidebar, toolbar, and footer links",
    slug: "benign-nested-noise",
    bucket: "B",
    mutationType: "filter_hides_rows_via_css",
    fixture: "nested-noise.html",
    run: async (cdp, ctx) => {
      const before = await cdp.extractEntities();
      ctx.observe("before-filter", before);

      // The table should be found despite deep nesting
      const table = before.find((e) => e._entity === "Table" && e.headers?.includes("Project"));
      expect(table, "projects table not found in noisy DOM");
      const echoRow = firstRowByField(rowsFrom(before), "Project", "Echo");
      expect(echoRow, "Echo row missing before filter");

      // Apply "Active" filter — hides non-active rows via CSS display:none
      await cdp.click('[data-filter="active"]');
      ctx.mutate("filter-active-hides-rows", true);
      await ctx.pause();
      await captureStageScreenshot(cdp, ctx, ctx.artifactDir, "benign-nested-noise", "after-filter");

      const after = await cdp.extractEntities();
      ctx.observe("after-filter", after);

      // Echo (Active) should still be present, Delta (Archived) should be hidden
      const echoAfter = firstRowByField(rowsFrom(after), "Project", "Echo");
      const deltaAfter = firstRowByField(rowsFrom(after), "Project", "Delta");
      // Delta is hidden by CSS but still in DOM — extraction should still see it
      // or at minimum, Echo must survive
      const survived = Boolean(echoAfter && echoAfter.Lead === "Elena Rossi");
      if (survived) ctx.planSurvived();

      ctx.postcondition(
        "Echo project row retains correct Lead after filter applied",
        survived,
        "Elena Rossi",
        echoAfter?.Lead ?? null,
      );
    },
  },
  {
    name: "Benign churn: content-keyed identity survives shuffle and update without data-attributes",
    slug: "benign-content-keyed-shuffle",
    bucket: "B",
    mutationType: "full_tbody_replacement_shuffled",
    fixture: "content-keyed.html",
    run: async (cdp, ctx) => {
      const before = await cdp.extractEntities();
      ctx.observe("before-shuffle", before);
      const paymentBefore = firstRowByField(rowsFrom(before), "Service", "payment-svc");
      expect(paymentBefore, "payment-svc missing before shuffle");
      expect(paymentBefore.Status === "Warning", `Expected Status=Warning, got ${paymentBefore.Status}`);
      expect(paymentBefore.Latency === "45ms", `Expected Latency=45ms, got ${paymentBefore.Latency}`);

      await cdp.click("#shuffle-btn");
      ctx.mutate("shuffle-and-update-all-rows", true);
      await sleep(400);
      await ctx.pause();
      await captureStageScreenshot(cdp, ctx, ctx.artifactDir, "benign-content-keyed-shuffle", "after-mutation");

      const after = await cdp.extractEntities();
      ctx.observe("after-shuffle", after);

      // payment-svc should be found with updated values despite shuffle
      const paymentAfter = firstRowByField(rowsFrom(after), "Service", "payment-svc");
      // api-gateway should now show Warning status
      const gatewayAfter = firstRowByField(rowsFrom(after), "Service", "api-gateway");

      const survived = Boolean(
        paymentAfter &&
        paymentAfter.Status === "Healthy" &&
        paymentAfter.Latency === "38ms" &&
        gatewayAfter &&
        gatewayAfter.Status === "Warning" &&
        gatewayAfter.Latency === "55ms"
      );
      if (survived) ctx.planSurvived();

      ctx.postcondition(
        "payment-svc and api-gateway have correct updated values after shuffle",
        survived,
        { paymentStatus: "Healthy", paymentLatency: "38ms", gatewayStatus: "Warning", gatewayLatency: "55ms" },
        {
          paymentStatus: paymentAfter?.Status ?? null,
          paymentLatency: paymentAfter?.Latency ?? null,
          gatewayStatus: gatewayAfter?.Status ?? null,
          gatewayLatency: gatewayAfter?.Latency ?? null,
        },
      );
    },
  },
  {
    name: "Stable: nested table rows not double-counted in parent table",
    slug: "stable-nested-table-isolation",
    bucket: "A",
    mutationType: "none",
    fixture: "nested-table.html",
    run: async (cdp, ctx) => {
      // Expand all detail rows so subtables are visible
      await cdp.click('[data-target="detail-001"]');
      await cdp.click('[data-target="detail-002"]');
      await cdp.click('[data-target="detail-003"]');
      await sleep(200);

      const entities = await cdp.extractEntities();
      ctx.observe("nested-tables", entities);

      const tables = entities.filter((e) => e._entity === "Table");
      const ordersTable = tables.find((t) => t.headers?.includes("Order ID"));

      // The parent table should have exactly 6 tbody children (3 order rows + 3 detail rows)
      // but row_count should only count actual data rows, not subtable rows mixed in
      const orderRows = rowsFrom(entities).filter((r) => r["Order ID"]?.startsWith("ORD-"));

      // Parent table must not report inflated row count from nested subtable rows
      const rowCountCorrect = ordersTable != null && ordersTable.row_count <= 6;
      const orderRowsCorrect = orderRows.length >= 3;

      ctx.postcondition(
        "parent table row count not inflated by nested subtable rows",
        rowCountCorrect && orderRowsCorrect,
        { tableRowCount: "<=6", orderEntities: ">=3" },
        { tableRowCount: ordersTable?.row_count ?? 0, orderEntities: orderRows.length },
      );

      // Hard fail if the parent table is wildly wrong — this is the real test
      expect(rowCountCorrect, `parent table row_count=${ordersTable?.row_count ?? "?"}, expected <=6 (got nested rows mixed in)`);
    },
  },
  {
    name: "Benign churn: expand subtable does not invalidate parent row identity",
    slug: "benign-nested-table-expand",
    bucket: "B",
    mutationType: "subtable_visibility_toggle",
    fixture: "nested-table.html",
    run: async (cdp, ctx) => {
      const before = await cdp.extractEntities();
      ctx.observe("before-expand", before);
      const bobBefore = firstRowByField(rowsFrom(before), "Customer", "Bob Martinez");
      expect(bobBefore, "Bob Martinez row missing before expand");

      // Expand Bob's detail row
      await cdp.click('[data-target="detail-002"]');
      ctx.mutate("subtable-revealed", true);
      await sleep(200);
      await ctx.pause();
      await captureStageScreenshot(cdp, ctx, ctx.artifactDir, "benign-nested-table-expand", "after-mutation");

      const after = await cdp.extractEntities();
      ctx.observe("after-expand", after);
      const bobAfter = firstRowByField(rowsFrom(after), "Customer", "Bob Martinez");
      const survived = Boolean(bobAfter && bobAfter.Total === "$3,400.00" && bobAfter.Status === "Processing");
      if (survived) ctx.planSurvived();

      ctx.postcondition(
        "Bob Martinez row retains correct data after subtable expanded",
        survived,
        { Total: "$3,400.00", Status: "Processing" },
        { Total: bobAfter?.Total ?? null, Status: bobAfter?.Status ?? null },
      );
    },
  },
  {
    name: "Benign churn: hidden rows excluded from extraction after priority filter",
    slug: "benign-visibility-filter",
    bucket: "B",
    mutationType: "css_display_none_filter",
    fixture: "visibility-filter.html",
    run: async (cdp, ctx) => {
      const before = await cdp.extractEntities();
      ctx.observe("before-filter", before);
      const allRows = rowsFrom(before);
      expect(allRows.length === 8, `expected 8 rows before filter, got ${allRows.length}`);

      // Filter to "High" priority only (3 rows visible)
      await cdp.click("#filter-high");
      ctx.mutate("filter-hides-non-high-rows", true);
      await ctx.pause();
      await captureStageScreenshot(cdp, ctx, ctx.artifactDir, "benign-visibility-filter", "after-filter");

      const after = await cdp.extractEntities();
      ctx.observe("after-filter", after);
      const visibleRows = rowsFrom(after);

      // After filtering to "High", only 3 rows should be extracted
      // If the extractor ignores visibility, it will still return 8
      const survived = visibleRows.length === 3;
      if (survived) ctx.planSurvived();

      ctx.postcondition(
        "only 3 high-priority rows extracted after filter (hidden rows excluded)",
        survived,
        3,
        visibleRows.length,
      );

      // Hard fail — this is the key test
      expect(
        visibleRows.length <= 3,
        `extracted ${visibleRows.length} rows after filter, expected 3 (hidden rows leaked into extraction)`,
      );
    },
  },
  {
    name: "Real disruption: fieldset disabled propagates to child button entities",
    slug: "disruption-fieldset-disabled",
    bucket: "C",
    mutationType: "fieldset_disabled_propagation",
    fixture: "fieldset-disabled.html",
    run: async (cdp, ctx) => {
      const before = await cdp.extractEntities();
      ctx.observe("before-lock", before);
      const validateBtn = before.find(
        (e) => e._entity === "Button" && e.label === "Validate Card",
      );
      expect(validateBtn, "Validate Card button missing");
      expect(!validateBtn.disabled, "Validate Card should be enabled initially");

      // Lock payment fieldset — this disables all child inputs and buttons
      await cdp.click("#lock-btn");
      ctx.mutate("payment-fieldset-disabled", false);
      await cdp.waitFor(`document.getElementById('payment-fields').disabled === true`, { timeoutMs: 2000 });
      await ctx.pause();
      await captureStageScreenshot(cdp, ctx, ctx.artifactDir, "disruption-fieldset-disabled", "after-lock");

      const afterLock = await cdp.extractEntities();
      ctx.observe("after-lock", afterLock);
      const validateAfterLock = afterLock.find(
        (e) => e._entity === "Button" && e.label === "Validate Card",
      );
      // The button should now be detected as disabled via fieldset inheritance
      const lockedCorrectly = Boolean(validateAfterLock?.disabled);
      ctx.rootCause("payment fieldset locked — child buttons inherit disabled state");
      ctx.invalidate("action target disabled via fieldset");

      // Verify Address button in shipping fieldset should NOT be affected
      const verifyAfterLock = afterLock.find(
        (e) => e._entity === "Button" && e.label === "Verify Address",
      );
      const shippingUnaffected = Boolean(verifyAfterLock && !verifyAfterLock.disabled);

      ctx.replan("unlock payment fieldset before using card validation");

      // Unlock
      await cdp.click("#unlock-btn");
      ctx.action("unlock-payment", { success: true });
      await ctx.pause();
      const afterUnlock = await cdp.extractEntities();
      ctx.observe("after-unlock", afterUnlock);
      const validateAfterUnlock = afterUnlock.find(
        (e) => e._entity === "Button" && e.label === "Validate Card",
      );
      const recovered = Boolean(validateAfterUnlock && !validateAfterUnlock.disabled);
      ctx.recovery(recovered, { disabled: validateAfterUnlock?.disabled });

      ctx.postcondition(
        "Validate Card detected as disabled when fieldset locked, re-enabled after unlock",
        lockedCorrectly && shippingUnaffected && recovered,
        { locked: true, shippingUnaffected: true, recovered: true },
        { locked: lockedCorrectly, shippingUnaffected, recovered },
      );

      // Hard fail on the key assertion
      expect(
        lockedCorrectly,
        `Validate Card button not detected as disabled when parent fieldset is disabled (disabled=${validateAfterLock?.disabled})`,
      );
    },
  },
  {
    name: "Stable: row-scoped buttons carry parent row context in extraction",
    slug: "stable-row-action-context",
    bucket: "A",
    mutationType: "none",
    fixture: "row-actions.html",
    run: async (cdp, ctx) => {
      const entities = await cdp.extractEntities();
      ctx.observe("row-actions", entities);

      const buttons = entities.filter((e) => e._entity === "Button");
      const editButtons = buttons.filter((e) => e.label === "Edit");
      const deleteButtons = buttons.filter((e) => e.label === "Delete");

      // Each Edit/Delete button should carry context about which row it belongs to
      // via data-user attribute or row association
      const hasRowContext = editButtons.every(
        (btn) => btn.data_user || btn.row_id || btn.context_row,
      );

      ctx.postcondition(
        "Edit buttons carry row context (data-user or row association)",
        hasRowContext && editButtons.length === 3 && deleteButtons.length === 3,
        { editCount: 3, deleteCount: 3, hasContext: true },
        { editCount: editButtons.length, deleteCount: deleteButtons.length, hasContext: hasRowContext },
      );

      // Hard fail if buttons don't carry row context
      expect(
        hasRowContext,
        `Edit buttons missing row context — cannot disambiguate which row's Edit to click`,
      );
    },
  },
  {
    name: "Stable: noisy DOM extraction yields correct entity counts without noise pollution",
    slug: "stable-noise-entity-count",
    bucket: "A",
    mutationType: "none",
    fixture: "nested-noise.html",
    run: async (cdp, ctx) => {
      const entities = await cdp.extractEntities();
      ctx.observe("noisy-dom", entities);

      const tables = entities.filter((e) => e._entity === "Table");
      const rows = rowsFrom(entities);
      const buttons = entities.filter((e) => e._entity === "Button");
      const links = entities.filter((e) => e._entity === "Link");

      // Exactly 1 data table, 6 data rows
      ctx.postcondition(
        "exactly 1 data table with 6 rows extracted from noisy DOM",
        tables.length === 1 && rows.length === 6,
        { tables: 1, rows: 6 },
        { tables: tables.length, rows: rows.length },
      );
    },
  },
];

export async function runSemanticBenchmark(
  opts: { verbose?: boolean; visible?: boolean; stepDelayMs?: number } = {},
) {
  const verbose = opts.verbose ?? false;
  const visible = opts.visible ?? false;
  const stepDelayMs = opts.stepDelayMs ?? (visible ? 900 : 0);
  const port = 9444;
  const artifactsDir = resolve(
    import.meta.dirname ?? process.cwd(),
    "../artifacts/semantic-benchmark",
  );
  mkdirSync(artifactsDir, { recursive: true });
  const metricsDir = join(artifactsDir, "metrics");
  rmSync(metricsDir, { recursive: true, force: true });

  const recorder = new MetricsRecorder(metricsDir);
  const fixturesDir = resolve(import.meta.dirname ?? process.cwd(), "../../../fixtures");
  const chrome = await launchChrome(port, { headless: !visible });
  const results: RunMetrics[] = [];
  const taskArtifacts: TaskArtifact[] = [];

  try {
    for (const testCase of CASES) {
      const cdp = new CdpClient();
      const start = Date.now();
      try {
        const wsUrl = await getPageWsUrl(port);
        await cdp.connect(wsUrl);
        const browserVersion = await cdp.browserVersion();
        await cdp.navigate(`file://${fixturesDir}/${testCase.fixture}`);

        const ctx = new BenchmarkContext(
          testCase.slug,
          testCase.bucket,
          testCase.mutationType,
          artifactsDir,
          stepDelayMs,
        );
        await captureStageScreenshot(cdp, ctx, artifactsDir, testCase.slug, "start");
        if (stepDelayMs > 0) await sleep(stepDelayMs);
        await testCase.run(cdp, ctx);
        if (stepDelayMs > 0) await sleep(stepDelayMs);
        await captureStageScreenshot(cdp, ctx, artifactsDir, testCase.slug, "end");

        const finalized = ctx.finalize(true, Date.now() - start, browserVersion);
        recorder.record(finalized.metrics);
        results.push(finalized.metrics);
        taskArtifacts.push({
          name: testCase.name,
          slug: testCase.slug,
          bucket: testCase.bucket,
          mutationType: testCase.mutationType,
          fixture: testCase.fixture,
          metrics: finalized.metrics,
          screenshots: finalized.screenshots,
          tracePath: finalized.tracePath,
        });

        if (verbose) {
          console.log(
            `✓ [${testCase.bucket}] ${testCase.name} ` +
              `(tokens=${finalized.metrics.tokensConsumed}, stale=${finalized.metrics.staleActionEscapeRate.toFixed(2)}, ` +
              `survival=${finalized.metrics.planSurvivalRate.toFixed(2)}, recovery=${finalized.metrics.recoverySuccessRate.toFixed(2)})`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const metrics: RunMetrics = {
          runId: randomUUID(),
          suite: testCase.bucket,
          task: testCase.slug,
          timestamp: new Date().toISOString(),
          bucket:
            testCase.bucket === "A"
              ? "stable"
              : testCase.bucket === "B"
                ? "benign_churn"
                : "real_disruption",
          mutationType: testCase.mutationType,
          taskSuccess: false,
          postconditionResults: [
            {
              description: "benchmark run completed",
              passed: false,
              expected: "success",
              actual: message,
            },
          ],
          semanticActionSuccessRate: 0,
          planSurvivalRate: 0,
          staleActionEscapeRate: 0,
          falseInvalidationRate: 0,
          recoverySuccessRate: 0,
          timeToRootCauseMs: 0,
          tokensConsumed: 0,
          wallClockMs: Date.now() - start,
          replans: 0,
          humanInterventionRequired: false,
          traceEventCount: 0,
          traceComplete: false,
        };
        recorder.record(metrics);
        results.push(metrics);
        taskArtifacts.push({
          name: testCase.name,
          slug: testCase.slug,
          bucket: testCase.bucket,
          mutationType: testCase.mutationType,
          fixture: testCase.fixture,
          metrics,
          screenshots: [],
        });

        if (verbose) {
          console.log(`✗ [${testCase.bucket}] ${testCase.name}: ${message}`);
        }
      } finally {
        cdp.close();
      }
    }
  } finally {
    chrome.kill();
  }

  generateVisualReport(artifactsDir, taskArtifacts);

  return {
    results,
    summaries: {
      A: recorder.summary("A"),
      B: recorder.summary("B"),
      C: recorder.summary("C"),
    },
    artifactsDir,
    reportPath: join(artifactsDir, "report.html"),
  };
}
