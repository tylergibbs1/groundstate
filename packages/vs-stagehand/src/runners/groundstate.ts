/**
 * Groundstate runner — uses the CDP-based extraction pipeline.
 * Reuses the CdpClient from suite-b (same extraction logic as the Rust core).
 */

import { CdpClient, getPageWsUrl, launchChrome, sleep } from "../../../suite-b/src/cdp.js";
import type { BenchTask, SystemResult, PostconditionResult } from "../types.js";

export async function runGroundstate(task: BenchTask): Promise<SystemResult> {
  const chrome = await launchChrome(9555);
  const cdp = new CdpClient();

  try {
    const wsUrl = await getPageWsUrl(9555);
    await cdp.connect(wsUrl);

    const extractions = new Map<string, unknown>();
    const start = performance.now();

    for (const step of task.steps) {
      switch (step.type) {
        case "navigate":
          await cdp.navigate(step.url);
          break;
        case "wait":
          await sleep(step.ms);
          break;
        case "click":
          await cdp.click(step.selector);
          break;
        case "extract": {
          if (step.label === "page-info") {
            // Special case: page info is metadata, not entity extraction
            const url = await cdp.evalJS<string>("window.location.href");
            const title = await cdp.evalJS<string>("document.title");
            extractions.set(step.label, { title, url });
          } else {
            const entities = await cdp.extractEntities();
            extractions.set(step.label, entities);
          }
          break;
        }
      }
    }

    const latencyMs = Math.round(performance.now() - start);

    // Transform entity extractions into task-appropriate format
    transformExtractions(task.slug, extractions);

    // Evaluate postconditions
    const postconditions: PostconditionResult[] = task.postconditions.map((pc) => ({
      description: pc.description,
      passed: safeCheck(pc.check, extractions),
    }));

    return {
      system: "groundstate",
      task: task.name,
      extractions,
      postconditions,
      latencyMs,
      tokensConsumed: 0,
    };
  } catch (error) {
    return {
      system: "groundstate",
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
    cdp.close();
    chrome.kill();
    await sleep(500);
  }
}

/**
 * Transform raw Groundstate entities into the shape the postconditions expect.
 * Groundstate extracts generic entities (Table, TableRow, Link, Button, etc.),
 * while postconditions expect task-specific shapes.
 */
function transformExtractions(slug: string, extractions: Map<string, unknown>) {
  if (slug === "hn-extract") {
    const entities = extractions.get("stories") as any[] | undefined;
    if (!Array.isArray(entities)) return;

    // HN stories appear as Link entities (the story titles are links)
    const links = entities.filter((e: any) => e._entity === "Link" || e._entity === "SearchResult");
    const rows = entities.filter((e: any) => e._entity === "TableRow");

    // HN uses a table layout — stories are in table rows
    // Try to extract story data from rows and links
    const stories = extractHNStories(entities);
    extractions.set("stories", stories);
  }

  if (slug === "hn-navigate") {
    const entities = extractions.get("past-stories") as any[] | undefined;
    if (Array.isArray(entities)) {
      const stories = extractHNStories(entities);
      extractions.set("past-stories", stories);
    }
  }

  if (slug === "wiki-table") {
    const entities = extractions.get("browsers") as any[] | undefined;
    if (!Array.isArray(entities)) return;

    const rows = entities.filter((e: any) => e._entity === "TableRow");
    const browsers = rows.map((row: any) => {
      // Wikipedia tables: first column is usually the browser name
      const cells = row._cells || [];
      const props = Object.entries(row).filter(
        ([k]) => !k.startsWith("_") && k !== "id",
      );
      return {
        browser: cells[0] || props[0]?.[1] || "",
        engine: cells[1] || props[1]?.[1] || undefined,
        operatingSystem: cells[2] || props[2]?.[1] || undefined,
        cost: cells[3] || props[3]?.[1] || undefined,
      };
    });
    extractions.set("browsers", browsers);
  }
}

function extractHNStories(entities: any[]): any[] {
  // HN has Link and SearchResult entities from the story titles
  const links = entities.filter(
    (e: any) =>
      (e._entity === "Link" || e._entity === "SearchResult") &&
      e.text &&
      e.href &&
      !e.href.includes("ycombinator.com") &&
      !e.href.startsWith("javascript:") &&
      e.text.length > 5,
  );

  // Also try TableRow entities (HN uses tables)
  const rows = entities.filter((e: any) => e._entity === "TableRow");

  // If we have meaningful links, use those as stories
  if (links.length >= 10) {
    return links.map((link: any, i: number) => ({
      rank: i + 1,
      title: link.text || link.title || "",
      url: link.href,
      points: undefined,
      author: undefined,
      commentCount: undefined,
    }));
  }

  // Fall back to rows if links didn't work
  if (rows.length >= 10) {
    return rows.map((row: any, i: number) => ({
      rank: i + 1,
      title: row._cells?.[0] || Object.values(row).find((v: any) => typeof v === "string" && v.length > 10) || "",
      url: undefined,
      points: undefined,
      author: undefined,
    }));
  }

  // Last resort: return whatever entities we found as "stories"
  return entities
    .filter((e: any) => e._entity !== "Table" && e._entity !== "Form")
    .slice(0, 30)
    .map((e: any, i: number) => ({
      rank: i + 1,
      title: e.text || e.label || e.title || e._cells?.[0] || "unknown",
      url: e.href || undefined,
    }));
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
