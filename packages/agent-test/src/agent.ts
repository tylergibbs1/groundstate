/**
 * Groundstate + Anthropic SDK — Real Browser Agent Test
 *
 * Launches Chrome, connects via CDP, gives Claude tools that operate
 * on the live browser through Groundstate-style extraction, and runs
 * an agentic tool-use loop.
 *
 * Usage:
 *   npx tsx src/agent.ts              # headless
 *   npx tsx src/agent.ts --visible    # see the browser
 *
 * Requires: ANTHROPIC_API_KEY
 */

import Anthropic from "@anthropic-ai/sdk";
import WebSocket from "ws";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

// ── Config ──

const VISIBLE = process.argv.includes("--visible");
const DEBUG_PORT = 9222;
const FIXTURE = path.resolve(
  import.meta.dirname ?? process.cwd(),
  "../../../fixtures/invoices.html",
);
const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
];

// ── Chrome launcher ──

function findChrome(): string {
  const found = CHROME_PATHS.find((p) => fs.existsSync(p));
  if (!found) throw new Error("Chrome not found");
  return found;
}

async function launchChrome() {
  const chrome = findChrome();
  const args = [
    ...(VISIBLE ? [] : ["--headless=new", "--disable-gpu"]),
    `--remote-debugging-port=${DEBUG_PORT}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    `--user-data-dir=/tmp/gs-agent-${process.pid}`,
    ...(VISIBLE ? ["--window-size=1280,900"] : []),
  ];

  const proc = spawn(chrome, args, { stdio: "ignore", detached: false });
  await sleep(VISIBLE ? 3000 : 2000);
  return proc;
}

async function getPageWsUrl(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    try {
      const resp = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const targets = (await resp.json()) as any[];
      const page = targets.find((t: any) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  const resp = await fetch(
    `http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`,
    { method: "PUT" },
  );
  const target = (await resp.json()) as any;
  if (target.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
  throw new Error("Could not get page WS URL");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Minimal CDP client ──

class CdpSession {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();

  async connect(wsUrl: string) {
    this.ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    this.ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    });
    await this.send("Page.enable", {});
    await this.send("DOM.enable", {});
    await this.send("Runtime.enable", {});
  }

  send(method: string, params: any = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout: ${method}`));
        }
      }, 30000);
    });
  }

  async navigate(url: string) {
    await this.send("Page.navigate", { url });
    await sleep(1500);
  }

  async evalJS(expression: string): Promise<any> {
    const { result } = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return result?.value;
  }

  async click(selector: string) {
    await this.evalJS(
      `document.querySelector(${JSON.stringify(selector)})?.click()`,
    );
    await sleep(300);
  }

  close() {
    this.ws.close();
  }
}

// ── Extract entities from live DOM ──

async function extractEntities(cdp: CdpSession): Promise<any[]> {
  return await cdp.evalJS(`
    (() => {
      const entities = [];
      document.querySelectorAll('table').forEach((table, ti) => {
        const id = table.id || 'table-' + ti;
        const headers = [...table.querySelectorAll('th')].map(th => th.textContent.trim());
        const sortedTh = [...table.querySelectorAll('th')].find(
          th => th.classList.contains('sorted-asc') || th.classList.contains('sorted-desc')
        );
        entities.push({
          id, _entity: 'Table', _source: '#' + id, _confidence: 0.9,
          headers, row_count: table.querySelectorAll('tbody tr').length,
          sorted_by: sortedTh ? sortedTh.textContent.trim() : null,
          sort_direction: sortedTh ? (sortedTh.classList.contains('sorted-asc') ? 'asc' : 'desc') : null,
        });
        table.querySelectorAll('tbody tr').forEach((tr, ri) => {
          const cells = [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
          const row = { id: id+'-row-'+ri, _entity: 'TableRow', _source: '#'+id+' tr:nth-child('+(ri+1)+')', _confidence: 0.85, _cells: cells };
          headers.forEach((h, i) => { row[h] = cells[i] || ''; });
          entities.push(row);
        });
      });
      return entities;
    })()
  `);
}

async function getActions(cdp: CdpSession): Promise<any[]> {
  return await cdp.evalJS(`
    (() => {
      const actions = [];
      document.querySelectorAll('table').forEach(table => {
        const id = table.id || 'table';
        [...table.querySelectorAll('th')].forEach((th, i) => {
          actions.push({
            id: 'sort-'+id+'-'+i, name: 'Sort by '+th.textContent.trim(),
            type: 'click', selector: '#'+id+' th:nth-child('+(i+1)+')', confidence: 0.7,
          });
        });
      });
      return actions;
    })()
  `);
}

// ── Tool definitions for the Anthropic API ──

const TOOLS: Anthropic.Tool[] = [
  {
    name: "groundstate_query",
    description:
      "Query semantic entities from the live browser page. Returns tables, rows, etc. " +
      'Use "where" to filter by property values (exact match or operators like {gt: N}).',
    input_schema: {
      type: "object" as const,
      properties: {
        entity: {
          type: "string",
          description: 'Entity type: "Table" or "TableRow"',
        },
        where: {
          type: "object",
          description:
            'Filter conditions. Example: {"Status": "Unpaid", "Amount": {"gt": 10000}}',
        },
      },
      required: ["entity"],
    },
  },
  {
    name: "groundstate_actions",
    description:
      "Get available actions (sort, click, etc) for entities on the page.",
    input_schema: {
      type: "object" as const,
      properties: {
        entity_ids: {
          type: "array",
          items: { type: "string" },
          description: "Entity IDs from a previous query",
        },
      },
      required: ["entity_ids"],
    },
  },
  {
    name: "groundstate_execute",
    description:
      "Execute a browser action by clicking its CSS selector. The runtime clicks, " +
      "waits for the page to settle, re-extracts state, and reports the outcome.",
    input_schema: {
      type: "object" as const,
      properties: {
        action_id: { type: "string", description: "Action ID" },
        selector: { type: "string", description: "CSS selector to click" },
        description: {
          type: "string",
          description: "What this action does",
        },
      },
      required: ["action_id", "selector", "description"],
    },
  },
];

// ── Tool handler ──

const traceLog: string[] = [];

async function handleTool(
  cdp: CdpSession,
  name: string,
  input: any,
): Promise<string> {
  switch (name) {
    case "groundstate_query": {
      let results = await extractEntities(cdp);
      results = results.filter((e) => e._entity === input.entity);

      if (input.where) {
        results = results.filter((row) => {
          for (const [key, val] of Object.entries(input.where)) {
            const actual = row[key];
            if (typeof val === "object" && val !== null) {
              const ops = val as Record<string, number>;
              const num = parseFloat(String(actual));
              if (ops.gt !== undefined && !(num > ops.gt)) return false;
              if (ops.lt !== undefined && !(num < ops.lt)) return false;
            } else if (actual !== val) {
              return false;
            }
          }
          return true;
        });
      }

      traceLog.push(
        `Query ${input.entity}${input.where ? " (filtered)" : ""} → ${results.length} results`,
      );
      return JSON.stringify(results, null, 2);
    }

    case "groundstate_actions": {
      const actions = await getActions(cdp);
      traceLog.push(`Actions → ${actions.length} available`);
      return JSON.stringify(actions, null, 2);
    }

    case "groundstate_execute": {
      const start = Date.now();
      await cdp.click(input.selector);
      const entities = await extractEntities(cdp);
      const table = entities.find((e) => e._entity === "Table");
      const elapsed = Date.now() - start;
      const sorted = table?.sorted_by;

      traceLog.push(
        `Execute "${input.description}" → ${sorted ? `sorted by ${sorted}` : "done"} (${elapsed}ms)`,
      );

      return [
        `${sorted ? "✓" : "⚡"} Executed: ${input.description} (${elapsed}ms)`,
        sorted
          ? `✓ Table now sorted by: ${sorted} (${table.sort_direction})`
          : "ℹ No sort indicator detected",
        `Entities after re-extraction: ${entities.length}`,
      ].join("\n");
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// ── Agentic loop ──

async function runAgent(cdp: CdpSession) {
  const client = new Anthropic();

  const systemPrompt = `You are operating a live web browser through the Groundstate runtime.
The browser is showing an invoice portal with a table of invoices.
You have tools to query entities, get available actions, and execute actions on the REAL browser.
Be concise in your reasoning. Use the tools to accomplish your goal.`;

  const userGoal = `Find all invoices in the table, identify which ones are unpaid and over $10,000, get the available sort actions, sort the table by Amount, then verify the sort worked by querying the rows again. Summarize your findings.`;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userGoal },
  ];

  let turns = 0;
  const maxTurns = 10;

  while (turns < maxTurns) {
    turns++;

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    });

    // Process response blocks
    const assistantContent: Anthropic.ContentBlock[] = [];
    const toolUses: Anthropic.ToolUseBlock[] = [];

    for (const block of response.content) {
      assistantContent.push(block);
      if (block.type === "text") {
        console.log(block.text);
      } else if (block.type === "tool_use") {
        console.log(`\n🔧 ${block.name}(${JSON.stringify(block.input)})`);
        toolUses.push(block);
      }
    }

    messages.push({ role: "assistant", content: assistantContent });

    // If no tool calls, we're done
    if (response.stop_reason === "end_turn" || toolUses.length === 0) {
      break;
    }

    // Execute all tool calls
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      const result = await handleTool(cdp, tu.name, tu.input);
      console.log(`  → ${result.split("\n")[0]}`);
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: result,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  return turns;
}

// ── Main ──

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Groundstate + Claude — Real Browser Agent Test");
  console.log(
    `  Mode: ${VISIBLE ? "VISIBLE (watch the browser)" : "headless"}`,
  );
  console.log("═══════════════════════════════════════════════════════════\n");

  // 1. Launch Chrome
  console.log("→ Launching Chrome...");
  const chromeProc = await launchChrome();

  try {
    // 2. Connect CDP
    const wsUrl = await getPageWsUrl();
    console.log(`→ CDP: ${wsUrl}`);
    const cdp = new CdpSession();
    await cdp.connect(wsUrl);

    // 3. Navigate
    const fileUrl = `file://${FIXTURE}`;
    await cdp.navigate(fileUrl);
    console.log(`→ Navigated to invoice portal`);

    // 4. Verify extraction
    const initial = await extractEntities(cdp);
    console.log(`→ Extracted ${initial.length} entities from live DOM\n`);
    traceLog.push(`Navigate → ${fileUrl}`);
    traceLog.push(`Extract → ${initial.length} entities`);

    // 5. Run the agent
    console.log("── Agent Loop ──\n");
    const turns = await runAgent(cdp);

    // 6. Print trace
    console.log("\n── Execution Trace ──");
    for (const [i, entry] of traceLog.entries()) {
      console.log(`  [${i + 1}] ${entry}`);
    }
    console.log(`\n  Agent turns: ${turns}`);

    cdp.close();
  } finally {
    chromeProc.kill();
    try {
      fs.rmSync(`/tmp/gs-agent-${process.pid}`, { recursive: true });
    } catch {}
  }

  console.log("\n══════════════════════════════════════════════════════════");
  console.log("  Done. Full vertical slice with live Claude agent.");
  console.log("══════════════════════════════════════════════════════════");
}

main().catch((e) => {
  console.error("\nFatal:", e.message || e);
  process.exit(1);
});
