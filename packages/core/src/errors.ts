export class GroundstateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GroundstateError";
    this.code = code;
  }
}

export class SessionError extends GroundstateError {
  constructor(message: string) {
    super("SESSION_ERROR", message);
    this.name = "SessionError";
  }
}

export class ConnectionError extends GroundstateError {
  constructor(message: string) {
    super("CONNECTION_ERROR", message);
    this.name = "ConnectionError";
  }
}

export class QueryError extends GroundstateError {
  constructor(message: string) {
    super("QUERY_ERROR", message);
    this.name = "QueryError";
  }
}

export class ExecutionFailedError extends GroundstateError {
  readonly recoverable: boolean;
  constructor(message: string, recoverable: boolean) {
    super("EXECUTION_ERROR", message);
    this.name = "ExecutionFailedError";
    this.recoverable = recoverable;
  }
}

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
