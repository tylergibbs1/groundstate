/**
 * Base fields present on every entity extracted from the state graph.
 */
export interface EntityBase {
  readonly id: string;
  readonly _entity: string;
  readonly _source: string;
  readonly _confidence: number;
  readonly _ref?: string;
}

/**
 * A typed entity. The generic parameter provides compile-time safety
 * for known entity schemas while remaining flexible for dynamic extraction.
 *
 * @example
 * type InvoiceRow = Entity<{
 *   vendor: string;
 *   amount: number;
 *   status: "Paid" | "Unpaid" | "Overdue";
 * }>;
 */
export type Entity<
  TFields extends Record<string, unknown> = Record<string, unknown>,
> = EntityBase & Readonly<TFields>;

/**
 * A lightweight reference to an entity (ID + type, no data).
 */
export interface EntityRef {
  readonly id: string;
  readonly _entity: string;
}

/**
 * An iterable collection of entities with convenience methods.
 */
export class EntitySet<T extends Entity = Entity> implements Iterable<T> {
  readonly entities: readonly T[];
  readonly count: number;
  readonly entityType: string;

  constructor(entities: T[]) {
    this.entities = Object.freeze(entities);
    this.count = entities.length;
    this.entityType = entities[0]?._entity ?? "unknown";
  }

  [Symbol.iterator](): Iterator<T> {
    return this.entities[Symbol.iterator]();
  }

  /** Get entity references (lightweight IDs) for this set. */
  refs(): EntityRef[] {
    return this.entities.map((e) => ({ id: e.id, _entity: e._entity }));
  }

  /** Get the first entity, if any. */
  first(): T | undefined {
    return this.entities[0];
  }

  /** Filter entities with a predicate, returning a new EntitySet. */
  where(predicate: (entity: T) => boolean): EntitySet<T> {
    return new EntitySet(this.entities.filter(predicate));
  }

  /** Map entity IDs. */
  ids(): string[] {
    return this.entities.map((e) => e.id);
  }
}
