# Deferred heavy-run reservations

A check runner can skip the outer reservation and reserve only its heavy steps, so cache hits and cheap steps never wait for the host slot.

- Declare the runner's argv prefixes in the project's `package.json`: `"heavyRun": {"deferredCommands": [["mise", "run", "signoff"]]}`.
  Matching invocations, including trailing arguments, start without a reservation; undeclared commands use history-based express admission or reserve eagerly.
- Deferred runners are uncapped and pass `HEAVY_RUN_UNCAPPED=1` to all nested heavy steps. Declare gates that are not deferred in
  `heavyRun.uncappedCommands`, using the same array format, for the same inherited exemption.
- Every matching runner must honor `HEAVY_RUN_DEFERRED=1`: check caches and run cheap steps directly, then wrap each heavy step with
  `bun --no-env-file "$HEAVY_RUN_CLI" --class checks --verbose -- <argv...>`. Each step releases its slot when done.
- The inner CLI inherits the outer owner and wait limit. Nesting inside an eager reservation is rejected. Exit 75 means that reservation's
  child never started.

Ad-hoc `checks` and `benchmark` commands must finish within 90 seconds; split or speed up slower work. At the deadline the entire process group
is killed with SIGKILL; exit 124 and status `timed-out` distinguish this from queue timeout (75). JSON reports `runtimeLimitSeconds`,
`elapsedSeconds`, and an error naming the command and saying "make it faster". Builds and declared non-deferred gates are uncapped by default;
pass `--runtime-limit 120` to bound a full gate. Deferred runners cap their own steps. The default queue wait remains 540 seconds.

`checks`, `build`, and `benchmark` share ten slots (`HEAVY_CAPACITY`). Benchmark timings can be noisy; compare repeated runs or medians. Requesters take turns on admission,
with FIFO within each requester. High CPU/RAM use alone needs no extra throttling: new jobs wait only for critical memory pressure or
1-minute load above six times the core count while CPU idle is under 10%; macOS load also counts I/O and idle waits. After five minutes, an overdue job may start once active jobs drain.

Undeclared `checks` commands use the express lane when their last 10 completed, non-deferred runs for the same exact argv and canonical
repository have a median under 10 seconds and a nearest-rank p90 under 30 seconds (the ninth sorted duration). Express runs start without
consuming one of the ten slots, but retain tracked leases and the legacy guard for load admission and process cleanup. `build` and `benchmark` never qualify; missing history or an unidentified repository reserves
normally. Later express durations feed the same rolling window, so slower commands lose eligibility automatically.

New history records include exact `argv`, `project` (the real shared Git directory, common to linked worktrees), and
`reservationMode: "express"`. Older history is usable for simple whitespace-free argv tokens shorter than the 300-character display limit;
its project is resolved from the recorded working directory. Removed worktrees without a saved project identity cannot contribute.
`status --json` version 2 retains `active` as an array, including legacy and express jobs; `express` reports its active count and thresholds.
Express entries have `reservationMode: "express"`; active count may exceed ten. Older loaded clients preserve these leases but conservatively
count them as slots until they exit. Already-loaded clients retain their admission code; queued clients using benchmark exclusivity need restarting to adopt shared admission.

Concurrent leases live in `heavy-concurrent.json`, under the existing device queue's `state.lock`. The legacy `state.json` retains its single-job
format. A running legacy job counts as one of the ten slots; new jobs can take the other nine immediately. Under the same flock,
new clients atomically replace its recognized symlink with an aggregate guard, which old recovery ignores and old release cannot unlink. The
last new release restores a still-running legacy holder's original lock. Unknown mkdir locks are never adopted. The borrowed guard uses a
separate v2 target so already-loaded concurrent-v1 cleanup cannot remove it. Without a serial holder, the aggregate uses the v1-compatible
target so all concurrent versions can acquire through their own polling.

An older head keeps one slot available for its polling while other requester heads fill the remaining slots. Between serial jobs,
backfill ends when the jobs active at the start of the wait finish. Only current clients can share a serial holder; older tickets remain
intact, including FIFO within their requester.

A singleton compatibility dispatcher updates turns and guard handoffs under the same flock every 250 ms, helping already-loaded clients use
this policy without restarting their jobs. It never grants, starts or stops another process's job. New invocations and status start it; it
exits after older clients drain, and the kernel releases its separate singleton lock on exit or crash.

`status --json` labels each active/waiting reservation with `protocol`: `legacy` means a ticket from `state.json`; `concurrent-v1` means an
unmarked ticket from `heavy-concurrent.json`; `concurrent-v2` means the previous strict-turn client; `concurrent-v3` means an older client with benchmark exclusivity; `concurrent-v4` means a current client with shared benchmark admission.
The CLI command path alone cannot identify loaded code. `holder.pid` identifies the reservation wrapper; an outer deferred runner owns the
whole sign-off. Restarting that runner migrates its queued descendants, but is unnecessary for ordinary backfill. If migrating, wait for its old
reservations/groups to exit before rerunning its original command in its original working directory.
Never restart other owners' jobs.

If all current clients exit before aggregate cleanup (including when only concurrent-v1 clients remain), run the new `heavy-run status` to
recover it. Do not roll back to serial-only code while an aggregate guard remains; first drain concurrent jobs and run the new status command.
