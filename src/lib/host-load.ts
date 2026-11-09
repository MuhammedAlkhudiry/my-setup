import { availableParallelism } from "node:os";

export type MemoryPressure = "normal" | "warning" | "critical" | "unknown";

export function parseMemoryPressure(
  level: string,
  report = "",
): MemoryPressure {
  const known = ({ "1": "normal", "2": "warning", "4": "critical" } as const)[
    level.trim() as "1" | "2" | "4"
  ];
  if (known) return known;
  const state = report
    .match(
      /(?:memory pressure(?: level| state)?|system-wide memory pressure)\s*[:=]\s*(normal|warn(?:ing)?|critical)\b/i,
    )?.[1]
    ?.toLowerCase();
  return state === "warn"
    ? "warning"
    : ((state as MemoryPressure | undefined) ?? "unknown");
}

/** CPU idle from the decayed per-process averages `ps -A -o %cpu=` reports. */
export function parseCpuIdle(report: string, cores = availableParallelism()): number {
  const busy = report.split("\n").reduce((total, line) => total + (Number(line.trim()) || 0), 0);
  return Math.max(0, 100 - busy / cores);
}
