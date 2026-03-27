import { describe, it, expect } from "vitest";
import { EntitySet, type Entity } from "../src/entity.js";

type TestEntity = Entity<{ name: string; amount: number; status: string }>;

function makeEntity(
  id: string,
  fields: { name: string; amount: number; status: string },
): TestEntity {
  return {
    id,
    _entity: "InvoiceRow",
    _source: `#row-${id}`,
    _confidence: 0.9,
    ...fields,
  };
}

describe("EntitySet", () => {
  it("wraps entities with count and type", () => {
    const set = new EntitySet([
      makeEntity("1", { name: "Acme", amount: 100, status: "Unpaid" }),
      makeEntity("2", { name: "Globex", amount: 200, status: "Paid" }),
    ]);

    expect(set.count).toBe(2);
    expect(set.entityType).toBe("InvoiceRow");
  });

  it("is iterable", () => {
    const set = new EntitySet([
      makeEntity("1", { name: "A", amount: 1, status: "x" }),
      makeEntity("2", { name: "B", amount: 2, status: "y" }),
    ]);

    const names = [...set].map((e) => e.name);
    expect(names).toEqual(["A", "B"]);
  });

  it("produces refs", () => {
    const set = new EntitySet([
      makeEntity("1", { name: "A", amount: 1, status: "x" }),
    ]);

    const refs = set.refs();
    expect(refs).toEqual([{ id: "1", _entity: "InvoiceRow" }]);
  });

  it("filters with where", () => {
    const set = new EntitySet([
      makeEntity("1", { name: "A", amount: 100, status: "Unpaid" }),
      makeEntity("2", { name: "B", amount: 5000, status: "Unpaid" }),
      makeEntity("3", { name: "C", amount: 200, status: "Paid" }),
    ]);

    const unpaid = set.where((e) => e.status === "Unpaid");
    expect(unpaid.count).toBe(2);

    const expensive = set.where((e) => e.amount > 1000);
    expect(expensive.count).toBe(1);
    expect(expensive.first()!.name).toBe("B");
  });

  it("returns undefined for first() on empty set", () => {
    const set = new EntitySet<TestEntity>([]);
    expect(set.first()).toBeUndefined();
    expect(set.entityType).toBe("unknown");
  });
});
