# Deferred heavy-run reservations

A check runner can skip the outer reservation and reserve only its heavy steps, so cache hits and cheap steps never wait for the host slot.

- Declare the runner's argv prefixes in the project's `package.json`: `"heavyRun": {"deferredCommands": [["mise", "run", "signoff"]]}`.
  Matching invocations, including trailing arguments, start without a reservation; undeclared commands reserve eagerly.
- Every matching runner must honor `HEAVY_RUN_DEFERRED=1`: check caches and run cheap steps directly, then wrap each heavy step with
  `bun --no-env-file "$HEAVY_RUN_CLI" --class checks --verbose -- <argv...>`. Each step releases its slot when done.
- The inner CLI inherits the outer owner and wait limit. Nesting inside an eager reservation is rejected. Exit 75 means that reservation's
  child never started.

`checks` and `build` share three slots (`HEAVY_CAPACITY`); `benchmark` waits for all slots and runs alone. Requesters take turns on admission,
with FIFO within each requester. Active benchmarks always exclude other jobs. `status --json` version 2 returns `active` as an array,
including legacy jobs.

Concurrent leases live in `heavy-concurrent.json`, under the existing device queue's `state.lock`. The legacy `state.json` retains its single-job
format. A running legacy checks/build job counts as one of the three slots; new jobs can take the other two immediately. Under the same flock,
new clients atomically replace its recognized symlink with an aggregate guard, which old recovery ignores and old release cannot unlink. The
last new release restores a still-running legacy holder's original lock. Unknown mkdir locks are never adopted. The borrowed guard uses a
separate v2 target so already-loaded concurrent-v1 cleanup cannot remove it. Without a serial holder, the aggregate uses the v1-compatible
target so all concurrent versions can acquire through their own polling.

An older checks/build head keeps one slot available for its polling while other requester heads fill the remaining slots. An older benchmark
head allows checks/build backfill while any job active when it reached the head is still running; once those fixed anchors finish, refilling
stops and borrowers drain so the benchmark gets its exclusive turn. New arrivals never extend that window. The same bounded window applies
between serial jobs. Only current clients can share a serial holder; older tickets remain intact, including FIFO within their requester.

A singleton compatibility dispatcher updates turns and guard handoffs under the same flock every 250 ms, helping already-loaded clients use
this policy without restarting their jobs. It never grants, starts or stops another process's job. New invocations and status start it; it
exits after older clients drain, and the kernel releases its separate singleton lock on exit or crash.

`status --json` labels each active/waiting reservation with `protocol`: `legacy` means a ticket from `state.json`; `concurrent-v1` means an
unmarked ticket from `heavy-concurrent.json`; `concurrent-v2` means the previous strict-turn client; `concurrent-v3` means the current client.
The CLI command path alone cannot identify loaded code. `holder.pid` identifies the reservation wrapper; an outer deferred runner owns the
whole sign-off. Restarting that runner migrates its queued descendants, but is unnecessary for backfill. If migrating, wait for its old
reservations/groups to exit before rerunning its original command in its original working directory.
Never restart other owners' jobs.

If all current clients exit before aggregate cleanup (including when only concurrent-v1 clients remain), run the new `heavy-run status` to
recover it. Do not roll back to serial-only code while an aggregate guard remains; first drain concurrent jobs and run the new status command.
