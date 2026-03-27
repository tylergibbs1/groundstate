import { describe, it, expect } from "vitest";
import { TraceView, type Trace } from "../src/trace.js";

function makeTrace(entries: Trace["entries"] = []): Trace {
  return {
    sessionId: "test-session",
    startedAt: "2026-01-01T00:00:00Z",
    entries,
    durationMs: 1000,
  };
}

describe("TraceView", () => {
  it("provides summary of empty trace", () => {
    const view = new TraceView(makeTrace());
    const summary = view.summary();

    expect(summary.sessionId).toBe("test-session");
    expect(summary.totalEntries).toBe(0);
    expect(summary.executionsTotal).toBe(0);
    expect(summary.errorsTotal).toBe(0);
  });

  it("filters execution entries", () => {
    const view = new TraceView(
      makeTrace([
        {
          type: "navigation",
          url: "https://example.com",
          status: 200,
          timestamp: "2026-01-01T00:00:01Z",
          seq: 1,
        },
        {
          type: "execution",
          step: {
            id: "s1",
            action: {
              id: "a1",
              name: "Click",
              type: "click",
              targets: [],
              preconditions: [],
              postconditions: [],
              confidence: 1,
            },
            description: "Click something",
          },
          result: {
            stepId: "s1",
            status: "success",
            postconditions: [],
            durationMs: 50,
          },
          timestamp: "2026-01-01T00:00:02Z",
          seq: 2,
        },
        {
          type: "error",
          code: "TIMEOUT",
          message: "Page load timeout",
          timestamp: "2026-01-01T00:00:03Z",
          seq: 3,
        },
      ]),
    );

    expect(view.executions()).toHaveLength(1);
    expect(view.errors()).toHaveLength(1);
    expect(view.hasErrors()).toBe(true);

    const summary = view.summary();
    expect(summary.totalEntries).toBe(3);
    expect(summary.executionsSucceeded).toBe(1);
    expect(summary.executionsFailed).toBe(0);
    expect(summary.errorsTotal).toBe(1);
  });

  it("collects postcondition results across executions", () => {
    const view = new TraceView(
      makeTrace([
        {
          type: "execution",
          step: {
            id: "s1",
            action: {
              id: "a1",
              name: "Sort",
              type: "click",
              targets: [],
              preconditions: [],
              postconditions: [],
              confidence: 1,
            },
            description: "Sort table",
          },
          result: {
            stepId: "s1",
            status: "success",
            postconditions: [
              {
                condition: { description: "Table sorted", check: { type: "entity_state", entityRef: { id: "1", _entity: "Table" }, field: "sorted", expected: true } },
                passed: true,
              },
              {
                condition: { description: "Header highlighted", check: { type: "element_visible", selector: ".active" } },
                passed: false,
                message: "Element not found",
              },
            ],
            durationMs: 100,
          },
          timestamp: "2026-01-01T00:00:01Z",
          seq: 1,
        },
      ]),
    );

    const results = view.postconditionResults();
    expect(results).toHaveLength(2);
    expect(results.filter((r) => r.passed)).toHaveLength(1);
    expect(results.filter((r) => !r.passed)).toHaveLength(1);
  });

  it("filters snapshot entries", () => {
    const view = new TraceView(
      makeTrace([
        {
          type: "snapshot",
          label: "refresh",
          url: "https://example.com",
          snapshotHash: "abc123",
          previousSnapshotHash: "prev999",
          changed: true,
          addedCount: 2,
          removedCount: 1,
          entityCount: 14,
          timestamp: "2026-01-01T00:00:01Z",
          seq: 1,
        },
      ]),
    );

    expect(view.snapshots()).toHaveLength(1);
    expect(view.snapshots()[0]!.snapshotHash).toBe("abc123");
    expect(view.snapshots()[0]!.changed).toBe(true);
  });
});
