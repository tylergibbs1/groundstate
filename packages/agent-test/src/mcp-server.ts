/**
 * Groundstate MCP Server for the Claude Agent SDK.
 *
 * Exposes the Groundstate runtime as MCP tools that a Claude agent can use:
 *   - groundstate_query:    Query entities from the browser state graph
 *   - groundstate_actions:  Get available actions for entities
 *   - groundstate_execute:  Execute an action step
 *   - groundstate_trace:    Get the execution trace
 *
 * Usage with Claude Agent SDK:
 *   const server = createGroundstateMcpServer(session);
 *   // Pass to agent options as mcp_servers: { browser: server }
 */

import { z } from "zod";
import type { Session } from "@groundstate/core";

// The tool definition shape expected by createSdkMcpServer
interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodType;
  handler: (args: any) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
}

/**
 * Create MCP tool definitions that wrap a Groundstate session.
 * These can be used with createSdkMcpServer from the Claude Agent SDK.
 */
export function createGroundstateTools(session: Session): ToolDef[] {
  return [
    {
      name: "groundstate_query",
      description:
        "Query semantic entities from the browser page. Returns structured data " +
        "extracted from the live DOM — tables, rows, forms, buttons, etc. " +
        'Use the "where" clause to filter by property values.',
      schema: z.object({
        entity: z
          .string()
          .describe(
            'Entity type to query, e.g. "Table", "TableRow", "Form", "Button"',
          ),
        where: z
          .record(z.unknown())
          .optional()
          .describe(
            "Filter conditions. Keys are property names, values are either " +
            'exact matches or operator objects like { gt: 10000 }',
          ),
        limit: z.number().optional().describe("Max entities to return"),
      }),
      handler: async (args: {
        entity: string;
        where?: Record<string, unknown>;
        limit?: number;
      }) => {
        const result = await session.query({
          entity: args.entity,
          where: args.where,
          limit: args.limit,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${result.count} ${args.entity} entities:\n${JSON.stringify(
                [...result],
                null,
                2,
              )}`,
            },
          ],
        };
      },
    },

    {
      name: "groundstate_actions",
      description:
        "Get available actions for entities. Returns clickable, fillable, or " +
        "navigable actions with preconditions and postconditions. " +
        "Pass entity IDs from a previous query result.",
      schema: z.object({
        entityIds: z
          .array(z.string())
          .describe("Entity IDs to get actions for"),
      }),
      handler: async (args: { entityIds: string[] }) => {
        // Build a minimal entity array from IDs
        const entities = args.entityIds.map((id) => ({
          id,
          _entity: "unknown",
          _source: "",
          _confidence: 1,
        }));

        const actionSet = await session.actions.for(entities);

        return {
          content: [
            {
              type: "text" as const,
              text: `${actionSet.count} actions available:\n${JSON.stringify(
                actionSet.actions,
                null,
                2,
              )}`,
            },
          ],
        };
      },
    },

    {
      name: "groundstate_execute",
      description:
        "Execute a browser action. Pass the full action object from groundstate_actions. " +
        "The runtime will validate preconditions, perform the action, wait for the page " +
        "to settle, re-extract state, and verify postconditions.",
      schema: z.object({
        action: z
          .record(z.unknown())
          .describe("The full action object from groundstate_actions"),
        description: z
          .string()
          .describe("Human-readable description of what this step does"),
      }),
      handler: async (args: { action: Record<string, unknown>; description: string }) => {
        const step = {
          id: `step-${Date.now()}`,
          action: args.action as any,
          description: args.description,
        };

        const result = await session.execute(step);

        const statusIcon =
          result.status === "success" ? "✓" : result.status === "failed" ? "✗" : "⊘";

        let text = `${statusIcon} ${result.status} (${result.durationMs}ms)`;
        if (result.error) {
          text += `\nError: ${result.error.message} (recoverable: ${result.error.recoverable})`;
        }
        for (const pc of result.postconditions) {
          text += `\n  ${pc.passed ? "✓" : "✗"} ${pc.condition.description}`;
        }

        return {
          content: [{ type: "text" as const, text }],
        };
      },
    },

    {
      name: "groundstate_trace",
      description:
        "Get the execution trace for this session. Shows all navigations, " +
        "extractions, queries, executions, and errors in chronological order.",
      schema: z.object({}),
      handler: async () => {
        const trace = await session.trace.current();
        const summary = trace.summary();

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Session trace (${summary.totalEntries} events, ${summary.durationMs}ms):\n` +
                `  Executions: ${summary.executionsSucceeded}/${summary.executionsTotal} succeeded\n` +
                `  Errors: ${summary.errorsTotal}\n\n` +
                JSON.stringify(trace.entries, null, 2),
            },
          ],
        };
      },
    },
  ];
}
