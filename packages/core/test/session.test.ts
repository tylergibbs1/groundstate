import { describe, it, expect, vi } from "vitest";
import { Session } from "../src/session.js";
import type { Bridge } from "../src/bridge.js";
import type { Entity } from "../src/entity.js";
import type { Action } from "../src/action.js";
import type { Trace } from "../src/trace.js";

function createMockBridge(overrides: Partial<Bridge> = {}): Bridge {
  return {
    query: vi.fn().mockResolvedValue([]),
    actionsFor: vi.fn().mockResolvedValue([]),
    execute: vi.fn().mockResolvedValue({
      stepId: "1",
      status: "success",
      postconditions: [],
      durationMs: 50,
    }),
    plan: vi.fn().mockResolvedValue({
      goal: "",
      steps: [],
      estimatedDurationMs: 0,
      confidence: 1,
    }),
    getTrace: vi.fn().mockResolvedValue({
      sessionId: "test",
      startedAt: new Date().toISOString(),
      entries: [],
      durationMs: 0,
    } satisfies Trace),
    onGraphChange: vi.fn(),
    graphVersion: vi.fn().mockResolvedValue(0),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("Session", () => {
  it("queries entities from the bridge", async () => {
    const mockEntities: Entity[] = [
      {
        id: "1",
        _entity: "Table",
        _source: "#invoices",
        _confidence: 0.9,
        headers: ["Name", "Amount"],
      },
    ];

    const bridge = createMockBridge({
      query: vi.fn().mockResolvedValue(mockEntities),
    });

    const session = new Session(bridge);
    const result = await session.query({ entity: "Table" });

    expect(result.count).toBe(1);
    expect(result.first()!.id).toBe("1");
    expect(bridge.query).toHaveBeenCalledWith({
      entity: "Table",
      where: undefined,
      limit: undefined,
      orderBy: undefined,
    });
  });

  it("gets actions for entities", async () => {
    const mockActions: Action[] = [
      {
        id: "a1",
        name: "Sort by Name",
        type: "click",
        targets: ["1"],
        preconditions: [],
        postconditions: [],
        confidence: 0.7,
      },
    ];

    const bridge = createMockBridge({
      actionsFor: vi.fn().mockResolvedValue(mockActions),
    });

    const session = new Session(bridge);
    const actions = await session.actions.for([
      { id: "1", _entity: "Table", _source: "#t", _confidence: 1 },
    ]);

    expect(actions.count).toBe(1);
    expect(actions.named("Sort").length).toBe(1);
  });

  it("executes a step", async () => {
    const bridge = createMockBridge();
    const session = new Session(bridge);

    const result = await session.execute({
      id: "step-1",
      action: {
        id: "a1",
        name: "Click",
        type: "click",
        targets: [],
        preconditions: [],
        postconditions: [],
        confidence: 1,
      },
      description: "Click a thing",
    });

    expect(result.status).toBe("success");
    expect(bridge.execute).toHaveBeenCalledOnce();
  });

  it("gets trace", async () => {
    const bridge = createMockBridge();
    const session = new Session(bridge);

    const trace = await session.trace.current();
    expect(trace.sessionId).toBe("test");
    expect(trace.entries).toHaveLength(0);
  });

  it("throws on operations after close", async () => {
    const bridge = createMockBridge();
    const session = new Session(bridge);

    await session.close();

    await expect(session.query({ entity: "Table" })).rejects.toThrow(
      "Session is closed",
    );
  });

  it("builds a fallback plan from available semantic actions", async () => {
    const table: Entity = {
      id: "table-1",
      _entity: "Table",
      _source: "#invoices",
      _confidence: 0.9,
      title: "Invoices",
    };
    const button: Entity = {
      id: "button-1",
      _entity: "Button",
      _source: ".download",
      _confidence: 0.8,
      label: "Download invoices",
    };
    const bridge = createMockBridge({
      plan: vi.fn().mockResolvedValue({
        goal: "Download invoices",
        steps: [],
        estimatedDurationMs: 0,
        confidence: 0,
      }),
      query: vi.fn().mockImplementation(async (request) => {
        if (request.entity === "Table") return [table];
        if (request.entity === "Button") return [button];
        return [];
      }),
      actionsFor: vi.fn().mockImplementation(async (ids: string[]) => {
        if (ids.includes("button-1")) {
          return [
            {
              id: "download-1",
              name: "Download invoices",
              type: "click",
              targets: ["button-1"],
              preconditions: [],
              postconditions: [],
              confidence: 0.9,
            } satisfies Action,
          ];
        }
        return [];
      }),
    });

    const session = new Session(bridge);
    const plan = await session.plan({ goal: "Download invoices" });

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.action.name).toContain("Download");
    expect(plan.confidence).toBeGreaterThan(0);
  });

  it("inspects actions by resolving semantic targets", async () => {
    const button: Entity = {
      id: "button-1",
      _entity: "Button",
      _source: ".download",
      _confidence: 0.8,
      label: "Download",
    };
    const bridge = createMockBridge({
      query: vi.fn().mockImplementation(async (request) => {
        if (request.entity === "Button") return [button];
        return [];
      }),
    });

    const session = new Session(bridge);
    const diagnostics = await session.actions.inspect({
      id: "download-1",
      name: "Download report",
      type: "click",
      targets: ["button-1"],
      preconditions: [],
      postconditions: [],
      confidence: 0.8,
    });

    expect(diagnostics.targetCount).toBe(1);
    expect(diagnostics.likelyValid).toBe(true);
  });

  it("subscribes to trace updates", async () => {
    const traces: Trace[] = [
      {
        sessionId: "test",
        startedAt: new Date().toISOString(),
        entries: [],
        durationMs: 0,
      },
      {
        sessionId: "test",
        startedAt: new Date().toISOString(),
        entries: [
          {
            type: "navigation",
            url: "https://example.com",
            status: 200,
            timestamp: new Date().toISOString(),
            seq: 1,
          },
        ],
        durationMs: 10,
      },
    ];
    const bridge = createMockBridge({
      getTrace: vi
        .fn()
        .mockResolvedValueOnce(traces[0]!)
        .mockResolvedValueOnce(traces[1]!)
        .mockResolvedValue(traces[1]!),
    });

    const session = new Session(bridge);
    const seen: number[] = [];

    const subscription = session.trace.subscribe(
      (trace) => {
        seen.push(trace.entries.length);
      },
      { intervalMs: 10 },
    );

    await new Promise((resolve) => setTimeout(resolve, 35));
    subscription.unsubscribe();

    expect(seen).toContain(0);
    expect(seen).toContain(1);
  });

  it("merges custom action derivers through plugins", async () => {
    const button: Entity = {
      id: "button-1",
      _entity: "Button",
      _source: ".download",
      _confidence: 0.8,
      label: "Download",
    };
    const bridge = createMockBridge({
      actionsFor: vi.fn().mockResolvedValue([]),
    });

    const session = new Session(bridge).use({
      name: "download-plugin",
      actionDerivers: [
        {
          name: "custom-download",
          derive: ({ entities }) =>
            entities.some((entity) => entity.id === "button-1")
              ? [
                  {
                    id: "custom-download",
                    name: "Download via plugin",
                    type: "click",
                    targets: ["button-1"],
                    preconditions: [],
                    postconditions: [],
                    confidence: 1,
                  } satisfies Action,
                ]
              : [],
        },
      ],
    });

    const actions = await session.actions.for([button]);
    expect(actions.count).toBe(1);
    expect(actions.first()!.name).toBe("Download via plugin");
  });

  it("applies registered recovery policies on failed execution", async () => {
    const bridge = createMockBridge({
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          stepId: "step-1",
          status: "failed",
          postconditions: [],
          durationMs: 20,
          error: {
            code: "MODAL_INTERRUPTION",
            message: "Modal blocked action",
            recoverable: true,
          },
        })
        .mockResolvedValue({
          stepId: "step-1",
          status: "success",
          postconditions: [],
          durationMs: 25,
        }),
    });

    const session = new Session(bridge);
    session.recovery.register({
      name: "retry-on-modal",
      matches: ({ result }) => result.error?.code === "MODAL_INTERRUPTION",
      recover: async ({ step }) => ({
        stepId: step.id,
        status: "success",
        postconditions: [],
        durationMs: 25,
      }),
    });

    const result = await session.execute({
      id: "step-1",
      action: {
        id: "a1",
        name: "Click submit",
        type: "click",
        targets: [],
        preconditions: [],
        postconditions: [],
        confidence: 1,
      },
      description: "Click submit",
    });

    expect(result.status).toBe("success");
    expect(bridge.execute).toHaveBeenCalledTimes(1);
  });

  it("exposes raw session escape hatches", async () => {
    const bridge = createMockBridge({
      evaluateJs: vi.fn().mockResolvedValue({ ok: true }),
      screenshot: vi.fn().mockResolvedValue("base64png"),
      currentUrl: vi.fn().mockResolvedValue("https://example.com"),
      clickSelector: vi.fn().mockResolvedValue(undefined),
      typeIntoSelector: vi.fn().mockResolvedValue(undefined),
    });

    const session = new Session(bridge);
    expect(await session.raw.evaluate("1 + 1")).toEqual({ ok: true });
    expect(await session.raw.screenshot()).toBe("base64png");
    expect(await session.raw.currentUrl()).toBe("https://example.com");
    await session.raw.clickSelector(".submit");
    await session.raw.typeIntoSelector("#email", "user@example.com");

    expect(bridge.clickSelector).toHaveBeenCalledWith(".submit");
    expect(bridge.typeIntoSelector).toHaveBeenCalledWith(
      "#email",
      "user@example.com",
    );
  });

  it("resolves interactive refs for raw click/type", async () => {
    const bridge = createMockBridge({
      query: vi.fn().mockImplementation(async (request) => {
        if (request.entity === "SearchResult") {
          return [
            {
              id: "story-1",
              _ref: "@e:story-1",
              _entity: "SearchResult",
              _source: 'a[href="/story"]',
              _confidence: 0.9,
              href: "/story",
              title: "Open story",
            },
          ];
        }
        return [];
      }),
      clickSelector: vi.fn().mockResolvedValue(undefined),
      typeIntoSelector: vi.fn().mockResolvedValue(undefined),
    });

    const session = new Session(bridge);
    const clicked = await session.raw.clickRef("@e:story-1");
    const typed = await session.raw.typeIntoRef("@e:story-1", "hello");

    expect(clicked.id).toBe("story-1");
    expect(typed.id).toBe("story-1");
    expect(bridge.clickSelector).toHaveBeenCalledWith('a[href="/story"]');
    expect(bridge.typeIntoSelector).toHaveBeenCalledWith('a[href="/story"]', "hello");
  });

  it("registers and lists native plugins", async () => {
    const bridge = createMockBridge({
      registerPlugin: vi.fn().mockResolvedValue(undefined),
      listPlugins: vi.fn().mockResolvedValue([{ type: "action", name: "native-download" }]),
    });

    const session = new Session(bridge);
    await session.plugins.registerNative({ type: "action", name: "native-download" });
    const plugins = await session.plugins.listNative();

    expect(bridge.registerPlugin).toHaveBeenCalledWith({
      type: "action",
      name: "native-download",
    });
    expect(plugins).toHaveLength(1);
  });

  it("returns native-backed session updates", async () => {
    const bridge = createMockBridge({
      getTraceSince: vi.fn().mockResolvedValue([{ seq: 2, type: "execution" }]),
      currentUrl: vi.fn().mockResolvedValue("https://example.com/dashboard"),
      screenshot: vi.fn().mockResolvedValue("base64png"),
    });

    const session = new Session(bridge);
    const update = await session.raw.sessionUpdates({
      traceSeq: 1,
      includeScreenshot: true,
    });

    expect(update.traceEvents).toHaveLength(1);
    expect(update.currentUrl).toContain("dashboard");
    expect(update.screenshotBase64).toBe("base64png");
  });

  it("locates and clicks elements via semantic locators", async () => {
    const bridge = createMockBridge({
      evaluateJs: vi.fn().mockResolvedValue([
        {
          selector: 'a[href="/story"]',
          text: "Open story",
          role: "link",
        },
      ]),
      clickSelector: vi.fn().mockResolvedValue(undefined),
    });

    const session = new Session(bridge);
    const match = await session.locator.click({ role: "link", text: "Open story" });

    expect(match.selector).toBe('a[href="/story"]');
    expect(bridge.clickSelector).toHaveBeenCalledWith('a[href="/story"]');
  });

  it("fails when no locator match is found", async () => {
    const bridge = createMockBridge({
      evaluateJs: vi.fn().mockResolvedValue([]),
    });

    const session = new Session(bridge);

    await expect(
      session.locator.click({ role: "button", text: "Missing action" }),
    ).rejects.toThrow("No element matched locator");
  });

  it("waits for URL matches", async () => {
    const bridge = createMockBridge({
      currentUrl: vi
        .fn()
        .mockResolvedValueOnce("https://example.com/loading")
        .mockResolvedValueOnce("https://example.com/dashboard"),
    });

    const session = new Session(bridge);
    const url = await session.wait.forUrl("/dashboard", {
      timeoutMs: 1000,
      pollMs: 10,
    });

    expect(url).toContain("/dashboard");
  });

  it("waits for load state to settle after graph version stabilizes", async () => {
    const bridge = createMockBridge({
      // Graph version changes on first two polls, then stabilizes
      graphVersion: vi
        .fn()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(3)
        .mockResolvedValue(3),
      query: vi.fn().mockResolvedValue([
        {
          id: "1",
          _entity: "Button",
          _source: ".save",
          _confidence: 0.8,
          label: "Save",
        },
        {
          id: "2",
          _entity: "Button",
          _source: ".cancel",
          _confidence: 0.8,
          label: "Cancel",
        },
      ]),
    });

    const session = new Session(bridge);
    const entities = await session.wait.forLoadState({
      timeoutMs: 1000,
      pollMs: 10,
    });

    // forLoadState resolves when graph version stabilizes
    expect(entities).toBeDefined();
  });

  it("runs deterministic batch operations", async () => {
    const bridge = createMockBridge({
      evaluateJs: vi.fn().mockResolvedValue([
        {
          selector: 'input[name="email"]',
          text: "",
          role: "textbox",
          label: "Email",
        },
      ]),
      typeIntoSelector: vi.fn().mockResolvedValue(undefined),
    });

    const session = new Session(bridge);
    const results = await session.batch.run([
      {
        type: "type",
        locator: { label: "Email" },
        text: "tyler@example.com",
      },
      {
        type: "refresh",
      },
    ]);

    expect(results).toHaveLength(2);
    expect(bridge.typeIntoSelector).toHaveBeenCalledWith(
      'input[name="email"]',
      "tyler@example.com",
    );
  });

  it("stops batch execution when an operation fails", async () => {
    const bridge = createMockBridge({
      evaluateJs: vi.fn().mockResolvedValue([]),
      typeIntoSelector: vi.fn().mockResolvedValue(undefined),
    });

    const session = new Session(bridge);

    await expect(
      session.batch.run([
        {
          type: "click",
          locator: { role: "button", text: "Missing" },
        },
        {
          type: "type",
          locator: { label: "Email" },
          text: "tyler@example.com",
        },
      ]),
    ).rejects.toThrow("No element matched locator");

    expect(bridge.typeIntoSelector).not.toHaveBeenCalled();
  });

  it("throws when interactive ref cannot be resolved", async () => {
    const bridge = createMockBridge({
      query: vi.fn().mockResolvedValue([]),
      clickSelector: vi.fn().mockResolvedValue(undefined),
    });

    const session = new Session(bridge);

    await expect(session.raw.clickRef("@e:missing")).rejects.toThrow(
      "No entity matched interactive ref",
    );
    expect(bridge.clickSelector).not.toHaveBeenCalled();
  });
});
