Review this developer Mac's resource snapshot and open threshold alerts on demand. Diagnose causes and name fixes at the source.
This review is read-only: do not run commands, change files, or kill processes; use only the supplied data.

memcap cleans leaked and idle processes every minute. After a parent exits, the CPU guard stops leftover agent tooling that stays above 80% CPU
for 10 minutes. Scheduled passes prune disk and raise threshold alerts.

- Report actionable issues: recurring process leaks, dev servers repeatedly reaped, devices shut down during use, critical memory pressure or allocated swap at least 90% full with elevated pressure,
  low disk, memcap stopped or refusing to enforce.
- Ignore isolated spikes already handled by memcap, its "MEASUREMENT IS FAULTY" or mixed-measurement notes from processes starting during sampling,
  and cleanup held while mobile tooling or a live agent session is active; those holds are intentional.
- Report `cpu.sustained` processes without obvious active work, including devices busy for hours, stuck helpers, or tools pinning a core.
  Name the process, busy duration, and fix, such as shutting down a device after QA, slimming it, or repairing the spinning tool.
- High CPU, load, RAM use, or swap use alone means busy, not unresponsive. Report repeated stops of the same tool in `cpu.guardStops`; fix that tool.
- Report large processes outside memcap's control that remain near the top of `topProcesses` with critical memory pressure, such as browsers, IDEs, or apps.
- Always report `diskFreeGib` below 10; name the biggest entries in `largestDiskUsers` or known caches.
- Order issues by importance under kebab-case `key` values. Explain the causes of open threshold alerts instead of repeating them.
- `evidence` quotes snapshot numbers or log lines; `fix` names a concrete source change; `runNote` describes the snapshot in one sentence.
