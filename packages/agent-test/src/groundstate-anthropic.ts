/**
 * Anthropic + Groundstate SDK example.
 *
 * Usage:
 *   pnpm --dir packages/agent-test start:groundstate
 *   pnpm --dir packages/agent-test start:groundstate --visible
 *   pnpm --dir packages/agent-test start:groundstate --url=https://example.com --goal="..."
 *
 * Requires:
 *   ANTHROPIC_API_KEY
 *   pnpm build:native
 *   pnpm build:core
 */

import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import { Runtime, type Action, type Entity, type ExecutionStep, type Session } from "../../core/src/index.js";

type ToolResult = string;

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.split("=");
    return [key, rest.join("=")];
  }),
);

const VISIBLE = process.argv.includes("--visible");
const DEFAULT_URL = `file://${path.resolve(
  import.meta.dirname ?? process.cwd(),
  "../../../fixtures/invoices.html",
)}`;
const URL = args.get("--url") || DEFAULT_URL;
const GOAL =
  args.get("--goal") ||
  "Find unpaid invoices over 10000, sort the table by Amount, and summarize the matching vendors.";
const AUTH_PROFILE = args.get("--auth-profile");
const MODEL = args.get("--model") || "claude-sonnet-4-20250514";
const MAX_TURNS = Number(args.get("--max-turns") || 12);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY is required.");
}

const runtime = new Runtime({ headless: !VISIBLE });
const actionRegistry = new Map<string, Action>();
let session: Session | undefined;

const tools: Anthropic.Messages.Tool[] = [
  {
    name: "groundstate_query",
    description:
      "Query semantic entities from the current browser session. Use this instead of reasoning from raw DOM. Common generic entity types are SearchResult, Link, Button, List, ListItem, Table, TableRow, Form, and Modal.",
    input_schema: {
      type: "object",
      properties: {
        entity: { type: "string" },
        where: { type: "object" },
        limit: { type: "number" },
      },
      required: ["entity"],
    },
  },
  {
    name: "groundstate_actions",
    description:
      "Get candidate semantic actions for a list of entity ids. Returns action ids you can execute later.",
    input_schema: {
      type: "object",
      properties: {
        entity_ids: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["entity_ids"],
    },
  },
  {
    name: "groundstate_execute",
    description:
      "Execute a previously listed semantic action by id and return semantic result plus current URL.",
    input_schema: {
      type: "object",
      properties: {
        action_id: { type: "string" },
        description: { type: "string" },
      },
      required: ["action_id"],
    },
  },
  {
    name: "groundstate_trace",
    description: "Return the current execution trace summary and entries.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "groundstate_refresh",
    description:
      "Force a runtime refresh and return the latest entities plus current URL. Use when you think the page changed.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "groundstate_locate",
    description:
      "Find elements using semantic locators like role, text, label, title, placeholder, or selector. Use this as the fallback when semantic entities are too coarse.",
    input_schema: {
      type: "object",
      properties: {
        role: { type: "string" },
        text: { type: "string" },
        label: { type: "string" },
        title: { type: "string" },
        placeholder: { type: "string" },
        selector: { type: "string" },
        exact: { type: "boolean" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "groundstate_click",
    description:
      "Click the first element matching a semantic locator. Use for generic browsing when no semantic action fits.",
    input_schema: {
      type: "object",
      properties: {
        role: { type: "string" },
        text: { type: "string" },
        label: { type: "string" },
        title: { type: "string" },
        placeholder: { type: "string" },
        selector: { type: "string" },
        exact: { type: "boolean" },
      },
    },
  },
  {
    name: "groundstate_click_ref",
    description:
      "Click a previously discovered stable interactive ref such as @e:... from a queried entity. Prefer this over locators when a semantic entity already exists.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
      },
      required: ["ref"],
    },
  },
  {
    name: "groundstate_type",
    description:
      "Type text into the first element matching a semantic locator.",
    input_schema: {
      type: "object",
      properties: {
        text_to_type: { type: "string" },
        role: { type: "string" },
        text: { type: "string" },
        label: { type: "string" },
        title: { type: "string" },
        placeholder: { type: "string" },
        selector: { type: "string" },
        exact: { type: "boolean" },
      },
      required: ["text_to_type"],
    },
  },
  {
    name: "groundstate_type_ref",
    description:
      "Type text into a previously discovered stable interactive ref such as @e:.... Prefer this over locators when a semantic entity already exists.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        text_to_type: { type: "string" },
      },
      required: ["ref", "text_to_type"],
    },
  },
  {
    name: "groundstate_wait",
    description:
      "Wait for a URL pattern or visible text before continuing. Use after navigation or interaction.",
    input_schema: {
      type: "object",
      properties: {
        url_pattern: { type: "string" },
        text: { type: "string" },
        role: { type: "string" },
        selector: { type: "string" },
        timeout_ms: { type: "number" },
      },
    },
  },
  {
    name: "groundstate_batch",
    description:
      "Run a small deterministic batch of click/type/wait/refresh operations in sequence.",
    input_schema: {
      type: "object",
      properties: {
        operations: {
          type: "array",
          items: { type: "object" },
        },
      },
      required: ["operations"],
    },
  },
];

async function main() {
  console.log("══════════════════════════════════════════════════");
  console.log("  Anthropic + Groundstate SDK");
  console.log("══════════════════════════════════════════════════");
  console.log(`URL: ${URL}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Visible: ${VISIBLE ? "yes" : "no"}`);
  console.log(`Goal: ${GOAL}`);
  console.log();

  session = await runtime.start({
    url: URL,
    authProfile: AUTH_PROFILE,
    waitForStable: true,
    viewport: { width: 1440, height: 960 },
    overlay: VISIBLE,
  });

  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            "You are operating a live browser through Groundstate.",
            "Use semantic tools first: query entities, inspect actions, execute actions, and check trace if needed.",
            "If queried entities include _ref values like @e:..., prefer those stable refs for direct interaction before falling back to locators.",
            "If semantic entities are too coarse, use semantic locators, waits, and batch operations rather than guessing from raw DOM.",
            "For open-web pages, start by querying SearchResult, Link, Button, List, or ListItem before falling back to locators.",
            "When querying, use exact entity names like SearchResult or Link.",
            "Do not assume page state without querying it.",
            `Task: ${GOAL}`,
          ].join("\n"),
        },
      ],
    },
  ];

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1600,
        tools,
        messages,
      });

      const assistantContent = response.content;
      messages.push({ role: "assistant", content: assistantContent });

      let issuedTool = false;
      for (const block of assistantContent) {
        if (block.type === "text") {
          console.log(block.text.trim());
        }

        if (block.type === "tool_use") {
          issuedTool = true;
          let result: ToolResult;
          try {
            result = await handleTool(
              block.name,
              block.input as Record<string, unknown>,
            );
          } catch (err) {
            result = JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            });
          }
          console.log(`\n[tool:${block.name}]`);
          console.log(result);
          messages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: block.id,
                content: result,
              },
            ],
          });
        }
      }

      if (!issuedTool) break;
    }
  } finally {
    const trace = await session.trace.current();
    console.log("\n── Final Trace Summary ──");
    console.log(JSON.stringify(trace.summary(), null, 2));
    await session.close();
    await runtime.closeAll();
  }
}

async function handleTool(name: string, input: Record<string, unknown>): Promise<ToolResult> {
  if (!session) throw new Error("Session not initialized.");

  switch (name) {
    case "groundstate_query": {
      const entities = await session.query({
        entity: String(input.entity),
        where: (input.where as Record<string, unknown> | undefined) ?? undefined,
        limit: typeof input.limit === "number" ? input.limit : undefined,
      });
      return JSON.stringify(
        {
          count: entities.count,
          entities: entities.entities,
        },
        null,
        2,
      );
    }

    case "groundstate_actions": {
      const ids = Array.isArray(input.entity_ids)
        ? input.entity_ids.map(String)
        : [];
      const entities = await findEntitiesByIds(ids);
      const actions = await session.actions.for(entities);
      for (const action of actions.actions) actionRegistry.set(action.id, action);
      return JSON.stringify(
        {
          count: actions.count,
          actions: actions.actions,
        },
        null,
        2,
      );
    }

    case "groundstate_execute": {
      const actionId = String(input.action_id);
      const action = actionRegistry.get(actionId);
      if (!action) {
        return JSON.stringify({ error: `Unknown action_id: ${actionId}` }, null, 2);
      }

      const step: ExecutionStep = {
        id: `step-${Date.now()}`,
        action,
        description:
          typeof input.description === "string" ? input.description : action.name,
      };
      const result = await session.execute(step);
      const currentUrl = await session.raw.currentUrl();
      return JSON.stringify({ result, currentUrl }, null, 2);
    }

    case "groundstate_trace": {
      const trace = await session.trace.current();
      return JSON.stringify(
        {
          summary: trace.summary(),
          entries: trace.entries,
        },
        null,
        2,
      );
    }

    case "groundstate_refresh": {
      const update = await session.raw.sessionUpdates({ includeScreenshot: false });
      return JSON.stringify(
        {
          currentUrl: update.currentUrl,
          traceEvents: update.traceEvents,
          entityCount: update.entities.length,
          entities: update.entities,
        },
        null,
        2,
      );
    }

    case "groundstate_locate": {
      const matches = await session.locator.find(toLocatorQuery(input));
      return JSON.stringify({ count: matches.length, matches }, null, 2);
    }

    case "groundstate_click": {
      const match = await session.locator.click(toLocatorQuery(input));
      return JSON.stringify(
        { clicked: match, currentUrl: await session.raw.currentUrl() },
        null,
        2,
      );
    }

    case "groundstate_click_ref": {
      const ref = String(input.ref);
      const entity = await session.raw.clickRef(ref);
      return JSON.stringify(
        { clicked: { ref, entity }, currentUrl: await session.raw.currentUrl() },
        null,
        2,
      );
    }

    case "groundstate_type": {
      const textToType =
        typeof input.text_to_type === "string" ? input.text_to_type : "";
      const match = await session.locator.type(toLocatorQuery(input), textToType);
      return JSON.stringify({ typedInto: match, text: textToType }, null, 2);
    }

    case "groundstate_type_ref": {
      const ref = String(input.ref);
      const textToType =
        typeof input.text_to_type === "string" ? input.text_to_type : "";
      const entity = await session.raw.typeIntoRef(ref, textToType);
      return JSON.stringify(
        { typedInto: { ref, entity }, text: textToType },
        null,
        2,
      );
    }

    case "groundstate_wait": {
      const timeoutMs =
        typeof input.timeout_ms === "number" ? input.timeout_ms : undefined;
      if (typeof input.url_pattern === "string") {
        const url = await session.wait.forUrl(input.url_pattern, { timeoutMs });
        return JSON.stringify({ url }, null, 2);
      }
      if (typeof input.text === "string") {
        const matches = await session.wait.forText(
          input.text,
          toLocatorQuery(input),
          { timeoutMs },
        );
        return JSON.stringify({ count: matches.length, matches }, null, 2);
      }
      return JSON.stringify(
        { error: "groundstate_wait requires url_pattern or text" },
        null,
        2,
      );
    }

    case "groundstate_batch": {
      const operations = Array.isArray(input.operations)
        ? (input.operations as Parameters<typeof session.batch.run>[0])
        : [];
      const results = await session.batch.run(operations);
      return JSON.stringify({ count: results.length, results }, null, 2);
    }

    default:
      return JSON.stringify({ error: `Unhandled tool: ${name}` }, null, 2);
  }
}

async function findEntitiesByIds(ids: string[]): Promise<Entity[]> {
  if (!session || ids.length === 0) return [];

  const kinds = [
    "Table",
    "TableRow",
    "Link",
    "Form",
    "FormField",
    "Button",
    "Modal",
    "Dialog",
    "List",
    "ListItem",
    "SearchResult",
    "Pagination",
  ];

  const sets = await Promise.all(kinds.map((entity) => session!.query({ entity })));
  return sets
    .flatMap((set: Awaited<typeof sets>[number]) => set.entities)
    .filter((entity: Entity) => ids.includes(entity.id));
}

function toLocatorQuery(input: Record<string, unknown>) {
  const cleanSelector = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const unwrapped = trimmed.replace(/^['"`]+|['"`]+$/g, "");
    return unwrapped || undefined;
  };

  return {
    role: typeof input.role === "string" ? input.role : undefined,
    text: typeof input.text === "string" ? input.text : undefined,
    label: typeof input.label === "string" ? input.label : undefined,
    title: typeof input.title === "string" ? input.title : undefined,
    placeholder:
      typeof input.placeholder === "string" ? input.placeholder : undefined,
    selector: cleanSelector(input.selector),
    exact: typeof input.exact === "boolean" ? input.exact : undefined,
    limit: typeof input.limit === "number" ? input.limit : undefined,
  };
}

main().catch((error) => {
  console.error("Fatal:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
