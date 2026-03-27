/**
 * Comparison operators for scalar values in where clauses.
 */
export interface ComparisonOperators<T> {
  eq?: T;
  neq?: T;
  gt?: T;
  gte?: T;
  lt?: T;
  lte?: T;
  in?: T[];
  notIn?: T[];
  contains?: T extends string ? string : never;
  startsWith?: T extends string ? string : never;
}

/**
 * Where clause: each field accepts a literal (shorthand for eq) or comparison operators.
 */
export type WhereClause<TFields extends Record<string, unknown>> = {
  [K in keyof TFields]?: TFields[K] | ComparisonOperators<TFields[K]>;
};

/**
 * Options for querying entities from a session.
 */
export interface QueryOptions<
  TFields extends Record<string, unknown> = Record<string, unknown>,
> {
  entity: string;
  where?: WhereClause<TFields>;
  limit?: number;
  orderBy?: { field: keyof TFields & string; direction: "asc" | "desc" };
}

/**
 * Wire format sent to the Rust core over the napi bridge.
 */
export interface QueryRequest {
  entity: string;
  where?: Record<string, unknown>;
  limit?: number;
  orderBy?: { field: string; direction: "asc" | "desc" };
}
