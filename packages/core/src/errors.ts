/** Base error for all Groundstate SDK errors. Check `code` for programmatic handling. */
export class GroundstateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GroundstateError";
    this.code = code;
  }
}

/** Thrown when a session operation fails (e.g. session closed, locator miss). */
export class SessionError extends GroundstateError {
  constructor(message: string) {
    super("SESSION_ERROR", message);
    this.name = "SessionError";
  }
}

/** Thrown when Chrome cannot be found or the native addon fails to load. */
export class ConnectionError extends GroundstateError {
  constructor(message: string) {
    super("CONNECTION_ERROR", message);
    this.name = "ConnectionError";
  }
}

/** Thrown when a state graph query fails. */
export class QueryError extends GroundstateError {
  constructor(message: string) {
    super("QUERY_ERROR", message);
    this.name = "QueryError";
  }
}

/** Thrown when an execution step fails. Check `recoverable` to decide retry strategy. */
export class ExecutionFailedError extends GroundstateError {
  readonly recoverable: boolean;
  constructor(message: string, recoverable: boolean) {
    super("EXECUTION_ERROR", message);
    this.name = "ExecutionFailedError";
    this.recoverable = recoverable;
  }
}

/** Thrown when postcondition verification fails after an execution step. */
export class PostconditionError extends GroundstateError {
  readonly results: PostconditionResult[];
  constructor(message: string, results: PostconditionResult[]) {
    super("POSTCONDITION_FAILED", message);
    this.name = "PostconditionError";
    this.results = results;
  }
}

// Re-import inline to avoid circular deps
interface PostconditionResult {
  condition: { description: string };
  passed: boolean;
  actual?: unknown;
  message?: string;
}
