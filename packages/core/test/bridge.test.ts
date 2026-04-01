import { describe, it, expect, vi } from "vitest";
import { NapiBridge, type NativeSessionLike } from "../src/bridge.js";

function createNative(overrides: Partial<NativeSessionLike> = {}): NativeSessionLike {
  return {
    query: vi.fn().mockResolvedValue("[]"),
    actionsFor: vi.fn().mockResolvedValue("[]"),
    execute: vi.fn().mockResolvedValue(JSON.stringify({
      stepId: "1",
      status: "success",
      postconditions: [],
      durationMs: 1,
    })),
    getTrace: vi.fn().mockResolvedValue(JSON.stringify({
      sessionId: "test",
      startedAt: new Date().toISOString(),
      entries: [],
      durationMs: 0,
    })),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("NapiBridge", () => {
  it("normalizes flattened reactive diffs from native subscribe", async () => {
    let subscribed: ((err: Error | null, diffJson: string) => void) | undefined;
    const native = createNative({
      subscribe: (callback) => {
        subscribed = callback;
      },
    });

    const bridge = new NapiBridge(native);
    const seen: unknown[] = [];
    bridge.onGraphChange((diff) => {
      seen.push(diff);
    });

    subscribed?.(
      null,
      JSON.stringify({
        graph: {
          graph_version: 7,
          upserted: [
            {
              id: "entity-1",
              kind: "Table",
              properties: { _source: "#invoices", _confidence: 0.9 },
              version: 1,
              session_entity_id: "session-1",
            },
          ],
          invalidated: ["entity-2"],
          removed: ["entity-3"],
        },
        actions: [{ id: "action-1", name: "Open" }],
      }),
    );

    expect(seen).toEqual([
      {
        graph_version: 7,
        upserted: [
          {
            id: "entity-1",
            kind: "Table",
            properties: { _source: "#invoices", _confidence: 0.9 },
            version: 1,
            session_entity_id: "session-1",
          },
        ],
        invalidated: ["entity-2"],
        removed: ["entity-3"],
        actions: [{ id: "action-1", name: "Open" }],
        resync: undefined,
      },
    ]);
  });
});
