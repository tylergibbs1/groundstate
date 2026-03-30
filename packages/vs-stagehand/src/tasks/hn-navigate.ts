import { z } from "zod";
import type { BenchTask } from "../types.js";

const HNStorySchema = z.array(
  z.object({
    title: z.string(),
    points: z.number().optional(),
  }),
);

const PageInfoSchema = z.object({
  title: z.string(),
  url: z.string(),
});

export const hnNavigate: BenchTask = {
  name: "HN Navigate + Click-through",
  slug: "hn-navigate",
  steps: [
    { type: "navigate", url: "https://news.ycombinator.com" },
    { type: "wait", ms: 1000 },
    {
      type: "click",
      selector: 'a[href="front"]',
      instruction: "Click the 'past' link in the top navigation to view older stories",
    },
    { type: "wait", ms: 1500 },
    {
      type: "extract",
      instruction: "Extract all story titles and point counts from this page.",
      schema: HNStorySchema,
      label: "past-stories",
    },
    {
      type: "extract",
      instruction: "Extract the current page title and URL.",
      schema: PageInfoSchema,
      label: "page-info",
    },
  ],
  postconditions: [
    {
      description: "navigated to past page",
      check: (data) => {
        const info = data.get("page-info") as { url?: string } | undefined;
        return typeof info?.url === "string" && info.url.includes("front");
      },
    },
    {
      description: "extracted stories from past page",
      check: (data) => {
        const stories = data.get("past-stories");
        return Array.isArray(stories) && stories.length >= 5;
      },
    },
    {
      description: "past stories have titles",
      check: (data) => {
        const stories = data.get("past-stories") as Array<{ title?: string }> | undefined;
        if (!Array.isArray(stories) || stories.length === 0) return false;
        return stories.every((s) => typeof s.title === "string" && s.title.length > 0);
      },
    },
  ],
};
