/**
 * Structured logging for the Groundstate SDK.
 *
 * Disabled by default. Enable via `RuntimeConfig.verbose` or by calling
 * `Logger.enable()` on a logger instance. All output goes through
 * `console.debug` with a `[groundstate]` namespace prefix.
 */

/** Configuration for SDK logging. */
export interface LoggerConfig {
  /** Whether debug logging is enabled (default: false). */
  readonly verbose?: boolean;
}

/**
 * Lightweight opt-in logger. Zero overhead when disabled -- the hot path
 * is a single boolean check.
 */
export class Logger {
  private enabled: boolean;

  constructor(config: LoggerConfig = {}) {
    this.enabled = config.verbose ?? false;
  }

  /** Turn logging on. */
  enable(): void {
    this.enabled = true;
  }

  /** Turn logging off. */
  disable(): void {
    this.enabled = false;
  }

  /** Whether logging is currently active. */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Log a bridge operation with its duration. */
  bridgeOp(operation: string, durationMs: number, detail?: Record<string, unknown>): void {
    if (!this.enabled) return;
    const msg = `[groundstate] bridge.${operation} (${durationMs.toFixed(1)}ms)`;
    if (detail) {
      console.debug(msg, detail);
    } else {
      console.debug(msg);
    }
  }

  /** Log entity extraction results. */
  extraction(entityType: string, count: number, durationMs: number): void {
    if (!this.enabled) return;
    console.debug(
      `[groundstate] extracted ${count} ${entityType} entities (${durationMs.toFixed(1)}ms)`,
    );
  }

  /** Log action derivation results. */
  actions(entityCount: number, actionCount: number, customCount: number): void {
    if (!this.enabled) return;
    console.debug(
      `[groundstate] derived ${actionCount} actions (${customCount} custom) for ${entityCount} entities`,
    );
  }

  /** Log a warning. Always emits regardless of enabled state. */
  warn(message: string, detail?: Record<string, unknown>): void {
    const msg = `[groundstate] WARN: ${message}`;
    if (detail) {
      console.warn(msg, detail);
    } else {
      console.warn(msg);
    }
  }

  /** Log a generic debug message. */
  debug(message: string, detail?: Record<string, unknown>): void {
    if (!this.enabled) return;
    const msg = `[groundstate] ${message}`;
    if (detail) {
      console.debug(msg, detail);
    } else {
      console.debug(msg);
    }
  }
}

/** Shared singleton for code that doesn't have access to a configured logger. */
let _defaultLogger = new Logger();

/** Get the default SDK logger. */
export function getDefaultLogger(): Logger {
  return _defaultLogger;
}

/** Replace the default SDK logger (used by Runtime to propagate config). */
export function setDefaultLogger(logger: Logger): void {
  _defaultLogger = logger;
}
