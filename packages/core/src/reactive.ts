/**
 * A snapshot of a single entity at a point in time.
 */
export interface EntitySnapshot {
  id: string;
  kind: string;
  properties: Record<string, unknown>;
  version: number;
  session_entity_id: string;
}

/**
 * A diff describing what changed in the state graph, including
 * derived actions for the changed entities.
 *
 * Pushed from the Rust reactive observation loop whenever DOM
 * mutations cause re-extraction.
 */
export interface GraphDiff {
  graph_version: number;
  upserted: EntitySnapshot[];
  invalidated: string[];
  removed: string[];
  /** Actions derived for the changed entities. */
  actions: unknown[];
  /** True when the subscriber lagged behind and needs to re-query. */
  resync?: boolean;
}

/**
 * Function to unsubscribe from a reactive subscription.
 */
export type Unsubscribe = () => void;
