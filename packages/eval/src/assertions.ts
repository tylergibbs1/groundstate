export interface AssertionResult {
  passed: boolean;
  message: string;
}

interface EntityLike {
  id: string;
  _entity: string;
  [key: string]: unknown;
}

interface TraceEntryLike {
  type: string;
  [key: string]: unknown;
}

interface ExecutionResultLike {
  postconditions: ReadonlyArray<{ passed: boolean; message?: string }>;
}

/**
 * Assert that at least one entity of the given type matches all `where` filters.
 */
export function assertEntityExists(
  entities: readonly EntityLike[],
  type: string,
  where: Record<string, unknown>,
): AssertionResult {
  const ofType = entities.filter((e) => e._entity === type);
  if (ofType.length === 0) {
    return { passed: false, message: `No entities of type "${type}" found` };
  }

  const match = ofType.find((entity) =>
    Object.entries(where).every(
      ([key, value]) => entity[key] === value,
    ),
  );

  if (match) {
    return {
      passed: true,
      message: `Found entity "${type}" matching ${JSON.stringify(where)}`,
    };
  }

  return {
    passed: false,
    message: `No "${type}" entity matches ${JSON.stringify(where)}. Found ${ofType.length} of type.`,
  };
}

/**
 * Assert that a specific field changed between before and after snapshots.
 */
export function assertFieldChanged(
  before: readonly EntityLike[],
  after: readonly EntityLike[],
  entityId: string,
  field: string,
): AssertionResult {
  const beforeEntity = before.find((e) => e.id === entityId);
  const afterEntity = after.find((e) => e.id === entityId);

  if (!beforeEntity) {
    return {
      passed: false,
      message: `Entity "${entityId}" not found in before snapshot`,
    };
  }
  if (!afterEntity) {
    return {
      passed: false,
      message: `Entity "${entityId}" not found in after snapshot`,
    };
  }

  const beforeVal = beforeEntity[field];
  const afterVal = afterEntity[field];

  if (JSON.stringify(beforeVal) === JSON.stringify(afterVal)) {
    return {
      passed: false,
      message: `Field "${field}" on "${entityId}" did not change (value: ${JSON.stringify(beforeVal)})`,
    };
  }

  return {
    passed: true,
    message: `Field "${field}" on "${entityId}" changed from ${JSON.stringify(beforeVal)} to ${JSON.stringify(afterVal)}`,
  };
}

/**
 * Assert that a navigation to a URL matching the pattern exists in the trace.
 */
export function assertUrlReached(
  trace: readonly TraceEntryLike[],
  pattern: RegExp | string,
): AssertionResult {
  const regex = typeof pattern === "string" ? new RegExp(pattern) : pattern;

  const navEntries = trace.filter((e) => e.type === "navigation");
  const match = navEntries.find(
    (e) => typeof e.url === "string" && regex.test(e.url),
  );

  if (match) {
    return {
      passed: true,
      message: `Navigation to URL matching ${regex} found: ${match.url as string}`,
    };
  }

  const visited = navEntries
    .map((e) => e.url as string)
    .filter(Boolean);
  return {
    passed: false,
    message: `No navigation matching ${regex}. Visited: ${visited.join(", ") || "(none)"}`,
  };
}

/**
 * Assert that the trace contains a specific event type matching the given predicate.
 */
export function assertTraceContains(
  trace: readonly TraceEntryLike[],
  eventType: string,
  matcher: (entry: TraceEntryLike) => boolean,
): AssertionResult {
  const ofType = trace.filter((e) => e.type === eventType);
  if (ofType.length === 0) {
    return {
      passed: false,
      message: `No trace entries of type "${eventType}" found`,
    };
  }

  const match = ofType.find(matcher);
  if (match) {
    return {
      passed: true,
      message: `Found "${eventType}" entry matching predicate`,
    };
  }

  return {
    passed: false,
    message: `Found ${ofType.length} "${eventType}" entries but none matched predicate`,
  };
}

/**
 * Assert that no execution entry operated on a stale entity.
 *
 * An execution is considered stale if a state_change entry with invalidations
 * occurred before it and the execution has no corresponding re-extraction.
 * We use a simplified heuristic: an execution following a state_change that
 * invalidated entities is stale if there is no extraction between them.
 */
export function assertNoStaleActions(
  trace: readonly TraceEntryLike[],
): AssertionResult {
  let pendingInvalidation = false;
  const staleExecutions: number[] = [];

  for (let i = 0; i < trace.length; i++) {
    const entry = trace[i]!;

    if (
      entry.type === "state_change" &&
      typeof entry.invalidatedCount === "number" &&
      entry.invalidatedCount > 0
    ) {
      pendingInvalidation = true;
    }

    if (entry.type === "extraction") {
      pendingInvalidation = false;
    }

    if (entry.type === "execution" && pendingInvalidation) {
      staleExecutions.push(i);
    }
  }

  if (staleExecutions.length === 0) {
    return { passed: true, message: "No stale action executions detected" };
  }

  return {
    passed: false,
    message: `Stale action executions at trace indices: ${staleExecutions.join(", ")}`,
  };
}

/**
 * Assert that all postconditions in an execution result passed.
 */
export function assertPostconditionsPassed(
  result: ExecutionResultLike,
): AssertionResult {
  const { postconditions } = result;

  if (postconditions.length === 0) {
    return { passed: true, message: "No postconditions to check" };
  }

  const failed = postconditions.filter((p) => !p.passed);
  if (failed.length === 0) {
    return {
      passed: true,
      message: `All ${postconditions.length} postconditions passed`,
    };
  }

  const failMessages = failed
    .map((p) => p.message ?? "(no message)")
    .join("; ");
  return {
    passed: false,
    message: `${failed.length}/${postconditions.length} postconditions failed: ${failMessages}`,
  };
}
