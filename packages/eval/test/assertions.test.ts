import { describe, it, expect } from "vitest";
import {
  assertEntityExists,
  assertFieldChanged,
  assertUrlReached,
  assertTraceContains,
  assertNoStaleActions,
  assertPostconditionsPassed,
} from "../src/assertions.js";

describe("assertEntityExists", () => {
  const entities = [
    { id: "1", _entity: "invoice", vendor: "Acme", amount: 100 },
    { id: "2", _entity: "invoice", vendor: "Globex", amount: 200 },
    { id: "3", _entity: "contact", name: "Alice" },
  ];

  it("passes when entity matches", () => {
    const result = assertEntityExists(entities, "invoice", { vendor: "Acme" });
    expect(result.passed).toBe(true);
  });

  it("fails when no entity of type exists", () => {
    const result = assertEntityExists(entities, "order", { status: "open" });
    expect(result.passed).toBe(false);
    expect(result.message).toContain("No entities of type");
  });

  it("fails when type exists but filter does not match", () => {
    const result = assertEntityExists(entities, "invoice", { vendor: "Unknown" });
    expect(result.passed).toBe(false);
    expect(result.message).toContain("No \"invoice\" entity matches");
  });
});

describe("assertFieldChanged", () => {
  const before = [
    { id: "1", _entity: "invoice", status: "draft", amount: 100 },
  ];
  const after = [
    { id: "1", _entity: "invoice", status: "sent", amount: 100 },
  ];

  it("passes when field changed", () => {
    const result = assertFieldChanged(before, after, "1", "status");
    expect(result.passed).toBe(true);
    expect(result.message).toContain("changed from");
  });

  it("fails when field did not change", () => {
    const result = assertFieldChanged(before, after, "1", "amount");
    expect(result.passed).toBe(false);
    expect(result.message).toContain("did not change");
  });

  it("fails when entity not in before", () => {
    const result = assertFieldChanged([], after, "1", "status");
    expect(result.passed).toBe(false);
    expect(result.message).toContain("not found in before");
  });

  it("fails when entity not in after", () => {
    const result = assertFieldChanged(before, [], "1", "status");
    expect(result.passed).toBe(false);
    expect(result.message).toContain("not found in after");
  });
});

describe("assertUrlReached", () => {
  const trace = [
    { type: "navigation", url: "https://app.example.com/login" },
    { type: "navigation", url: "https://app.example.com/dashboard" },
    { type: "extraction", entityType: "user", count: 1 },
  ];

  it("passes with string pattern", () => {
    const result = assertUrlReached(trace, "dashboard");
    expect(result.passed).toBe(true);
  });

  it("passes with regex pattern", () => {
    const result = assertUrlReached(trace, /\/dashboard$/);
    expect(result.passed).toBe(true);
  });

  it("fails when no URL matches", () => {
    const result = assertUrlReached(trace, /\/settings$/);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("No navigation matching");
  });
});

describe("assertTraceContains", () => {
  const trace = [
    { type: "extraction", entityType: "invoice", count: 5, durationMs: 100 },
    { type: "execution", stepId: "s1", status: "success" },
  ];

  it("passes when matching entry found", () => {
    const result = assertTraceContains(trace, "extraction", (e) => e.count === 5);
    expect(result.passed).toBe(true);
  });

  it("fails when no entries of type", () => {
    const result = assertTraceContains(trace, "navigation", () => true);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("No trace entries of type");
  });

  it("fails when entries exist but none match", () => {
    const result = assertTraceContains(trace, "extraction", (e) => e.count === 99);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("none matched predicate");
  });
});

describe("assertNoStaleActions", () => {
  it("passes with clean trace", () => {
    const trace = [
      { type: "extraction", entityType: "invoice", count: 3 },
      { type: "execution", stepId: "s1" },
    ];
    expect(assertNoStaleActions(trace).passed).toBe(true);
  });

  it("passes when re-extraction occurs after invalidation", () => {
    const trace = [
      { type: "extraction", entityType: "invoice", count: 3 },
      { type: "state_change", invalidatedCount: 2 },
      { type: "extraction", entityType: "invoice", count: 3 },
      { type: "execution", stepId: "s1" },
    ];
    expect(assertNoStaleActions(trace).passed).toBe(true);
  });

  it("fails when execution follows invalidation without re-extraction", () => {
    const trace = [
      { type: "extraction", entityType: "invoice", count: 3 },
      { type: "state_change", invalidatedCount: 2 },
      { type: "execution", stepId: "s1" },
    ];
    const result = assertNoStaleActions(trace);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("Stale action executions");
  });
});

describe("assertPostconditionsPassed", () => {
  it("passes when all postconditions pass", () => {
    const result = assertPostconditionsPassed({
      postconditions: [
        { passed: true, message: "OK" },
        { passed: true, message: "Also OK" },
      ],
    });
    expect(result.passed).toBe(true);
    expect(result.message).toContain("All 2 postconditions passed");
  });

  it("passes with empty postconditions", () => {
    const result = assertPostconditionsPassed({ postconditions: [] });
    expect(result.passed).toBe(true);
  });

  it("fails when some postconditions fail", () => {
    const result = assertPostconditionsPassed({
      postconditions: [
        { passed: true, message: "OK" },
        { passed: false, message: "Expected redirect" },
      ],
    });
    expect(result.passed).toBe(false);
    expect(result.message).toContain("1/2 postconditions failed");
    expect(result.message).toContain("Expected redirect");
  });
});
