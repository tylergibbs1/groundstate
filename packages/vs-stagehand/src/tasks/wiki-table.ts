import { z } from "zod";
import type { BenchTask } from "../types.js";

const BrowserTableSchema = z.array(
  z.object({
    browser: z.string(),
    engine: z.string().optional(),
    operatingSystem: z.string().optional(),
    cost: z.string().optional(),
  }),
);

export const wikiTable: BenchTask = {
  name: "Wikipedia Table Extraction",
  slug: "wiki-table",
  steps: [
    {
      type: "navigate",
      url: "https://en.wikipedia.org/wiki/Comparison_of_web_browsers",
    },
    { type: "wait", ms: 2000 },
    {
      type: "extract",
      instruction:
        "Extract data from the first comparison table on this page. For each row, get the browser name, layout engine, operating system support, and cost/license.",
      schema: BrowserTableSchema,
      label: "browsers",
    },
  ],
  postconditions: [
    {
      description: "extracted at least 5 browser rows",
      check: (data) => {
        const rows = data.get("browsers");
        return Array.isArray(rows) && rows.length >= 5;
      },
    },
    {
      description: "Chrome is in the results",
      check: (data) => {
        const rows = data.get("browsers") as Array<{ browser?: string }> | undefined;
        if (!Array.isArray(rows)) return false;
        return rows.some(
          (r) =>
            typeof r.browser === "string" &&
            r.browser.toLowerCase().includes("chrome"),
        );
      },
    },
    {
      description: "Firefox is in the results",
      check: (data) => {
        const rows = data.get("browsers") as Array<{ browser?: string }> | undefined;
        if (!Array.isArray(rows)) return false;
        return rows.some(
          (r) =>
            typeof r.browser === "string" &&
            r.browser.toLowerCase().includes("firefox"),
        );
      },
    },
  ],
};
