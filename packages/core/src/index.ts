// Classes
export { Runtime } from "./runtime.js";
export type { RuntimeConfig, StartSessionOptions } from "./runtime.js";

export { Session } from "./session.js";
export type {
  ActionDiagnostics,
  BatchOperation,
  BatchResult,
  TraceSubscription,
  LocatorMatch,
  LocatorQuery,
  RawSessionAccess,
  SessionUpdateCursor,
  SessionUpdatePacket,
  WaitOptions,
  CustomActionContext,
  CustomActionDeriver,
  RecoveryContext,
  RecoveryPolicy,
  SessionPlugin,
} from "./session.js";

export { EntitySet } from "./entity.js";
export type { Entity, EntityBase, EntityRef } from "./entity.js";

export { ActionSet } from "./action.js";
export type {
  Action,
  ActionType,
  Condition,
  ConditionCheck,
} from "./action.js";

export type { QueryOptions, WhereClause, ComparisonOperators } from "./query.js";

export type {
  ExecutionStep,
  ExecutionResult,
  ExecutionPlan,
  PostconditionResult,
  ExecutionError,
} from "./postcondition.js";

export { TraceView } from "./trace.js";
export type {
  Trace,
  TraceEntry,
  TraceSummary,
  NavigationEntry,
  ExtractionEntry,
  QueryEntry,
  ExecutionEntry,
  StateChangeEntry,
  ErrorEntry,
  ObservationEntry,
  SnapshotEntry,
} from "./trace.js";

export {
  GroundstateError,
  SessionError,
  ConnectionError,
  QueryError,
  ExecutionFailedError,
  PostconditionError,
} from "./errors.js";

// Overlay
export { OverlayManager } from "./overlay/index.js";
export type {
  OverlayState,
  OverlayAction,
  OverlayEntityGroup,
  OverlayTraceEntry,
  HighlightEntity,
} from "./overlay/index.js";

// Logging
export { Logger } from "./logger.js";
export type { LoggerConfig } from "./logger.js";

// Reactive types
export type { GraphDiff, EntitySnapshot, Unsubscribe } from "./reactive.js";

// Bridge (for advanced usage / testing)
export { NapiBridge, type Bridge, type NativeSessionLike } from "./bridge.js";
