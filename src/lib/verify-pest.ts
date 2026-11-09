import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One Pest test's time in one run. */
export interface TestTime {
  file: string;
  name: string;
  seconds: number;
}

/** What a run keeps of its Pest check: the suite's size and only its slowest tests, so months of runs stay small. */
export interface PestRecord {
  tests: number;
  /** Test time summed across parallel workers. */
  seconds: number;
  slowest: TestTime[];
}

export const KEPT_TESTS = 50;

export const testKey = (test: TestTime) => `${test.file}::${test.name}`;

/**
 * Reads the timing gate's JSON lines (Awraq's and Harium's RecordsTestTiming), keeping each test's first entry: the
 * gate writes solo re-runs of slow tests to other files, but a test listed twice keeps the suite-run time.
 */
export function parseTimingLines(text: string): TestTime[] {
  const seen = new Map<string, TestTime>();

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as { id: string; file: string; name: string; seconds: number };
    if (!seen.has(entry.id))
      seen.set(entry.id, {
        file: entry.file,
        name: entry.name,
        seconds: Math.round(entry.seconds * 1000) / 1000,
      });
  }

  return [...seen.values()];
}

/** The Pest check's times from a check run's log folder, where check.ts points TEST_TIMING_DIR; null when it did not run. */
export function readPestTimings(logs: string | undefined): PestRecord | null {
  const file = logs && join(logs, "test-timings", "timings.jsonl");
  if (!file || !existsSync(file)) return null;

  try {
    const tests = parseTimingLines(readFileSync(file, "utf8"));
    if (!tests.length) return null;

    return {
      tests: tests.length,
      seconds: Math.round(tests.reduce((total, test) => total + test.seconds, 0) * 10) / 10,
      slowest: tests.sort((a, b) => b.seconds - a.seconds).slice(0, KEPT_TESTS),
    };
  } catch {
    return null;
  }
}
