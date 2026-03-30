import { z } from "zod";
import type { BenchTask } from "../types.js";

const HNStorySchema = z.array(
  z.object({
    rank: z.number(),
    title: z.string(),
    url: z.string().optional(),
    points: z.number().optional(),
    author: z.string().optional(),
    commentCount: z.number().optional(),
  }),
);

export const hnExtract: BenchTask = {
  name: "HN Front Page Extraction",
  slug: "hn-extract",
  steps: [
    { type: "navigate", url: "https://news.ycombinator.com" },
    { type: "wait", ms: 1500 },
    {
      type: "extract",
      instruction:
        "Extract all stories from the Hacker News front page. For each story, get the rank number, title, URL, points score, author username, and number of comments.",
      schema: HNStorySchema,
      label: "stories",
    },
  ],
  postconditions: [
    {
      description: "extracted at least 25 stories",
      check: (data) => {
        const stories = data.get("stories");
        return Array.isArray(stories) && stories.length >= 25;
      },
    },
    {
      description: "every story has a title",
      check: (data) => {
        const stories = data.get("stories") as Array<{ title?: string }> | undefined;
        if (!Array.isArray(stories) || stories.length === 0) return false;
        return stories.every((s) => typeof s.title === "string" && s.title.length > 0);
      },
    },
    {
      description: "points are numbers where present",
      check: (data) => {
        const stories = data.get("stories") as Array<{ points?: unknown }> | undefined;
        if (!Array.isArray(stories)) return false;
        return stories.every(
          (s) => s.points === undefined || s.points === null || typeof s.points === "number",
        );
      },
    },
  ],
};
