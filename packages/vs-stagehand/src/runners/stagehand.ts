/**
 * Stagehand runner — uses LLM-powered extraction via @browserbasehq/stagehand.
 * Requires OPENAI_API_KEY (or ANTHROPIC_API_KEY) in environment.
 */

import type { BenchTask, SystemResult, PostconditionResult } from "../types.js";

export function stagehandAvailable(): boolean {
  return Boolean(process.env["OPENAI_API_KEY"] || process.env["ANTHROPIC_API_KEY"]);
}

export async function runStagehand(task: BenchTask): Promise<SystemResult> {
  // Dynamic import so the benchmark doesn't fail if stagehand isn't installed
  const { Stagehand } = await import("@browserbasehq/stagehand");

  const model = process.env["OPENAI_API_KEY"]
    ? "openai/gpt-5.4"
    : "anthropic/claude-haiku-4-5-20251001";

  const stagehand = new Stagehand({
    env: "LOCAL",
    model,
    verbose: 0,
    localBrowserLaunchOptions: {
      headless: true,
    },
  });

  try {
    await stagehand.init();
    const page = stagehand.context.pages()[0]!;

    const extractions = new Map<string, unknown>();
    const start = performance.now();
    let tokensConsumed = 0;

    for (const step of task.steps) {
      switch (step.type) {
        case "navigate":
          await page.goto(step.url, { waitUntil: "networkidle" });
          break;
        case "wait":
          await page.waitForTimeout(step.ms);
          break;
        case "click":
          await stagehand.act(step.instruction);
          tokensConsumed += estimateTokens(step.instruction);
          break;
        case "extract": {
          const result = await stagehand.extract(step.instruction, step.schema);
          extractions.set(step.label, result);
          tokensConsumed += estimateTokens(step.instruction) + estimateTokens(result);
          break;
        }
      }
    }

    // Get page info if needed
    for (const step of task.steps) {
      if (step.type === "extract" && step.label === "page-info" && !extractions.has("page-info")) {
        const url = page.url();
        const title = await page.title();
        extractions.set("page-info", { title, url });
      }
    }

    const latencyMs = Math.round(performance.now() - start);

    const postconditions: PostconditionResult[] = task.postconditions.map((pc) => ({
      description: pc.description,
      passed: safeCheck(pc.check, extractions),
    }));

    return {
      system: "stagehand",
      task: task.name,
      extractions,
      postconditions,
      latencyMs,
      tokensConsumed,
    };
  } catch (error) {
    return {
      system: "stagehand",
      task: task.name,
      extractions: new Map(),
      postconditions: task.postconditions.map((pc) => ({
        description: pc.description,
        passed: false,
      })),
      latencyMs: 0,
      tokensConsumed: 0,
      error: String(error),
    };
  } finally {
    await stagehand.close().catch(() => {});
  }
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

function safeCheck(
  check: (data: Map<string, unknown>) => boolean,
  data: Map<string, unknown>,
): boolean {
  try {
    return check(data);
  } catch {
    return false;
  }
}
