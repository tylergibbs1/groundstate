import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export interface TraceSnapshotEntry {
  type: string;
  entityType?: string;
  actionName?: string;
  postconditionsPassed?: boolean;
  stateChanges?: Record<string, unknown>;
}

export type TraceSnapshot = TraceSnapshotEntry[];

export interface TraceMismatch {
  index: number;
  expected: TraceSnapshotEntry;
  actual: TraceSnapshotEntry;
  fields: string[];
}

export interface TraceDiff {
  matches: number;
  mismatches: TraceMismatch[];
  missing: TraceSnapshot;
  extra: TraceSnapshot;
}

export function saveGoldenTrace(
  baseDir: string,
  taskName: string,
  trace: TraceSnapshot,
): string {
  const filePath = join(baseDir, `${taskName}.json`);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(trace, null, 2) + "\n", "utf-8");
  return filePath;
}

export function loadGoldenTrace(
  baseDir: string,
  taskName: string,
): TraceSnapshot {
  const filePath = join(baseDir, `${taskName}.json`);
  const content = readFileSync(filePath, "utf-8");
  return JSON.parse(content) as TraceSnapshot;
}

export function diffAgainstGolden(
  baseDir: string,
  taskName: string,
  actual: TraceSnapshot,
): TraceDiff {
  const golden = loadGoldenTrace(baseDir, taskName);
  return diffTraces(golden, actual);
}

export function diffTraces(
  expected: TraceSnapshot,
  actual: TraceSnapshot,
): TraceDiff {
  const compareLength = Math.min(expected.length, actual.length);
  let matches = 0;
  const mismatches: TraceMismatch[] = [];

  for (let i = 0; i < compareLength; i++) {
    const exp = expected[i]!;
    const act = actual[i]!;
    const diffFields = findDiffFields(exp, act);

    if (diffFields.length === 0) {
      matches++;
    } else {
      mismatches.push({
        index: i,
        expected: exp,
        actual: act,
        fields: diffFields,
      });
    }
  }

  const missing = expected.slice(actual.length);
  const extra = actual.slice(expected.length);

  return { matches, mismatches, missing, extra };
}

function findDiffFields(
  expected: TraceSnapshotEntry,
  actual: TraceSnapshotEntry,
): string[] {
  const allKeys = new Set([
    ...Object.keys(expected),
    ...Object.keys(actual),
  ]);
  const diffs: string[] = [];

  for (const key of allKeys) {
    const expVal = (expected as unknown as Record<string, unknown>)[key];
    const actVal = (actual as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(expVal) !== JSON.stringify(actVal)) {
      diffs.push(key);
    }
  }

  return diffs;
}
