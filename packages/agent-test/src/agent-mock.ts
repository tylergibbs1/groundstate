/**
 * Groundstate + Claude Agent SDK test using mock browser data.
 *
 * This version doesn't require Chrome or the native addon — it creates
 * a mock Groundstate session and wires it into the Agent SDK. This is
 * the fastest way to test the integration.
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY set in environment
 *
 * Usage:
 *   npx tsx src/agent-mock.ts
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// ── Mock invoice data (simulates what Groundstate extracts) ──

const MOCK_TABLE = {
  id: "table-1",
  _entity: "Table",
  _source: "#invoices",
  _confidence: 0.9,
  headers: ["Vendor", "Amount", "Status", "Due Date"],
  row_count: 6,
};

const MOCK_ROWS = [
  { id: "row-1", _entity: "TableRow", _source: "#invoices tr:nth-child(1)", _confidence: 0.85, Vendor: "Acme Corp", Amount: "15000", Status: "Unpaid", "Due Date": "2026-04-15" },
  { id: "row-2", _entity: "TableRow", _source: "#invoices tr:nth-child(2)", _confidence: 0.85, Vendor: "Globex Inc", Amount: "8200", Status: "Paid", "Due Date": "2026-03-01" },
  { id: "row-3", _entity: "TableRow", _source: "#invoices tr:nth-child(3)", _confidence: 0.85, Vendor: "Initech", Amount: "42000", Status: "Unpaid", "Due Date": "2026-04-30" },
  { id: "row-4", _entity: "TableRow", _source: "#invoices tr:nth-child(4)", _confidence: 0.85, Vendor: "Umbrella Ltd", Amount: "3100", Status: "Overdue", "Due Date": "2026-02-28" },
  { id: "row-5", _entity: "TableRow", _source: "#invoices tr:nth-child(5)", _confidence: 0.85, Vendor: "Stark Industries", Amount: "97500", Status: "Unpaid", "Due Date": "2026-05-10" },
  { id: "row-6", _entity: "TableRow", _source: "#invoices tr:nth-child(6)", _confidence: 0.85, Vendor: "Wayne Enterprises", Amount: "5600", Status: "Paid", "Due Date": "2026-03-15" },
];

const MOCK_ACTIONS = [
  { id: "act-1", name: "Sort by Vendor", type: "click", targets: ["table-1"], preconditions: [], postconditions: [], confidence: 0.7 },
  { id: "act-2", name: "Sort by Amount", type: "click", targets: ["table-1"], preconditions: [], postconditions: [], confidence: 0.7 },
  { id: "act-3", name: "Sort by Status", type: "click", targets: ["table-1"], preconditions: [], postconditions: [], confidence: 0.7 },
  { id: "act-4", name: "Sort by Due Date", type: "click", targets: ["table-1"], preconditions: [], postconditions: [], confidence: 0.7 },
];

// ── Mock MCP tools ──

const groundstateServer = createSdkMcpServer({
  name: "groundstate-browser",
  version: "0.1.0",
  tools: [
    tool(
      "groundstate_query",
      "Query semantic entities from the browser. Returns tables, rows, forms, buttons, etc. Use 'where' to filter.",
      {
        entity: z.string().describe('Entity type: "Table", "TableRow", "Form", "Button"'),
        where: z.record(z.unknown()).optional().describe("Filter conditions"),
        limit: z.number().optional(),
      },
      async (args: { entity: string; where?: Record<string, unknown>; limit?: number }) => {
        let results: any[];

        if (args.entity === "Table") {
          results = [MOCK_TABLE];
        } else if (args.entity === "TableRow") {
          results = MOCK_ROWS;
          // Apply where clause
          if (args.where) {
            results = results.filter((row) => {
              for (const [key, value] of Object.entries(args.where!)) {
                if (typeof value === "object" && value !== null) {
                  const ops = value as Record<string, unknown>;
                  const actual = parseFloat(row[key]) || row[key];
                  if (ops.gt !== undefined && !(actual > (ops.gt as number))) return false;
                  if (ops.lt !== undefined && !(actual < (ops.lt as number))) return false;
                } else if (row[key] !== value) {
                  return false;
                }
              }
              return true;
            });
          }
          if (args.limit) results = results.slice(0, args.limit);
        } else {
          results = [];
        }

        return {
          content: [{
            type: "text" as const,
            text: `Found ${results.length} ${args.entity} entities:\n${JSON.stringify(results, null, 2)}`,
          }],
        };
      },
    ),

    tool(
      "groundstate_actions",
      "Get available actions for entities (sort, click, fill, etc).",
      {
        entityIds: z.array(z.string()).describe("Entity IDs from a query result"),
      },
      async (_args: { entityIds: string[] }) => ({
        content: [{
          type: "text" as const,
          text: `${MOCK_ACTIONS.length} actions available:\n${JSON.stringify(MOCK_ACTIONS, null, 2)}`,
        }],
      }),
    ),

    tool(
      "groundstate_execute",
      "Execute a browser action. The runtime validates preconditions, performs the action, and verifies postconditions.",
      {
        actionId: z.string().describe("The action ID to execute"),
        description: z.string().describe("What this step does"),
      },
      async (args: { actionId: string; description: string }) => {
        const action = MOCK_ACTIONS.find((a) => a.id === args.actionId);
        return {
          content: [{
            type: "text" as const,
            text: action
              ? `✓ Executed: ${action.name} (${args.description})\n  Status: success\n  Duration: 320ms`
              : `✗ Action not found: ${args.actionId}`,
          }],
        };
      },
    ),

    tool(
      "groundstate_trace",
      "Get the full execution trace for this session.",
      {},
      async () => ({
        content: [{
          type: "text" as const,
          text: "Session trace: 3 events (520ms)\n  1. Navigate → file://fixtures/invoices.html\n  2. Extract 7 entities\n  3. Execute: Sort by Amount → success",
        }],
      }),
    ),
  ],
});

// ── Run the agent ──

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("  Groundstate + Claude Agent SDK (Mock Browser)");
  console.log("═══════════════════════════════════════════════════\n");

  const goal = `
You have access to a browser automation runtime called Groundstate.
The browser is showing an invoice portal with a table of invoices.

Your task:
1. Use groundstate_query to find all TableRow entities
2. Use groundstate_query with a where clause to find unpaid invoices over $10,000
3. Use groundstate_actions to see what actions are available for the table
4. Use groundstate_execute to sort by Amount
5. Summarize what you found and what you did
  `.trim();

  console.log("→ Agent goal: Find unpaid invoices > $10k, sort by amount\n");

  for await (const message of query({
    prompt: goal,
    options: {
      maxTurns: 10,
      model: "sonnet",
      allowedTools: [
        "mcp__groundstate-browser__groundstate_query",
        "mcp__groundstate-browser__groundstate_actions",
        "mcp__groundstate-browser__groundstate_execute",
        "mcp__groundstate-browser__groundstate_trace",
      ],
      mcpServers: {
        "groundstate-browser": groundstateServer,
      },
    },
  })) {
    if (message.type === "assistant" && message.message?.content) {
      for (const block of message.message.content) {
        if ("text" in block && block.text) {
          console.log(block.text);
        } else if ("name" in block) {
          console.log(`\n🔧 ${block.name}(${JSON.stringify((block as any).input)})`);
        }
      }
    } else if (message.type === "result") {
      console.log(`\n✓ Done: ${message.subtype}`);
    }
  }
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
