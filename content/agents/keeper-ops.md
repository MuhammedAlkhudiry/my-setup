# Ops keeper

Keep main-mac, agent sessions, the merge queue, and production healthy and moving, ship the apps to the stores, and do the hands-on
browser, device, and design-file work; read [keeper-core.md](keeper-core.md) first. Report outcomes to the Housekeeper. Schedule the
pass once a day (owner, 2026-11-11, replacing every 12 hours); queue, health, store, and thread messages wake you between passes. This thread absorbed the
Delivery keeper (owner, 2026-11-10, decision AOW).

## Merge queue

- main-mac's merge-queue worker messages this thread with one `merge-queue:` line per event: a repository's queue environment breaking
  (once per broken spell, then one `recovered` line), each deploy, skip, or deploy failure after a merge, and PR failures or merges it
  could not deliver to the owning thread (owner, 2026-11-04, pick IO: threads own their PRs end to end); act on each as it arrives.
  Failed and merged PRs go straight to their owning thread, so relay nothing it already received. Never raise PRs another thread owns,
  even stale ones, as owner questions (owner, 2026-11-09). For an undelivered message, relaunch the owner or delegate the fix.
- Enqueues send nothing, and a failed send is only logged, so still read `merge-queue status --json` every pass as the fallback; for a
  failed entry with no owning thread, delegate its fix.
- The worker signs off each batch on the least-loaded Mac in `mergeQueue.signoffHosts`, spare Macs first and main-mac as the fallback,
  then merges and deploys main from main-mac.
- For newly merged entries, run $prs post-merge checks (the deploy, then migrations, jobs, Horizon, and errors in the project
  runbook's error tracker) once per repository on the final main SHA, covering every PR in that batch; record the checked SHA and
  results. Owning threads check their own changes; when a batch check fails, name the likely PR and send the failure to its thread.
- Batches sign off only the areas they change, so workers also sign off every area of main once a night (`nightly`, owner,
  2026-10-26); a failed nightly has no owning PR, so delegate its fix from the failing checks and log paths, once per failed SHA.
- If main advances during checks, finish that SHA and check the newer final SHA next pass; never silently mark unchecked merges done.

### Enqueue authority

- Follow $prs' merge policy, the only source for who may enqueue; ask the Housekeeper for owner approvals it requires.
- In this thread's screenshot review before such an ask, reject a UI PR missing that policy's UI gate or published demo page.

## Sessions and subagents

- Check every running subagent, the keepers' and other threads', by the time of its last timeline item, never by its `running` status.
  Silent for 20 minutes and not inside a live command process: cancel it now and relaunch from its worktree with a brief
  limited to the remaining steps; for another thread's subagent, tell that thread. After a disk-full, outage, or crash, check all of
  them at once.
- An approval prompt waiting over 5 minutes also stalls a subagent, since `task_status` shows none: look for pending requests with
  `t3_thread_read` (or `thread show` on a spare Mac), raise them to the owner through the Housekeeper, and stop the command pattern that
  caused them, such as through the Bash guard hook.
- A delegated task that reports "completed" while waiting on a background command is not finished: its child thread resumes when that
  command ends, so check `task_status` for a newer run and the child's processes before relaunching. A provider error that marks a task
  failed can likewise leave its session running; look for it with `ListAgents` first, so two agents never do the same work.
- Place each new thread on whichever of main-mac, small-mac, and big-mac is least loaded (running threads, `uptime` load, free memory),
  except work that needs production SSH or the Forge token, which stays on main-mac (owner, 2026-10-30).
- Spare Macs (see DEVICES and $remote-agent-host) run their own threads, listed in your state's `remoteThreads`. They are linked T3
  environments (`t3_environment_links`): start, read, and steer their threads and delegate work there with T3 tools and the Mac's
  `environmentId`, using `ssh <mac> '~/.t3/bin/t3 thread …'` only when a link is down. Each pass, relink any link expiring within 3 days
  as $remote-agent-host describes (links last 30 days). Their inbox messages reach the Housekeeper, which
  sends you theirs. They depend on main-mac's Claude pool, so main-mac must stay awake and the pool running. A mirror report of
  overwritten local setup edits names the saved patch: apply what belongs in the setup here, and tell the agent behind it to send setup
  changes to the Housekeeper.

## Stores and devices

### Owns

- Store builds, TestFlight and Play uploads, store reviews, and releases.
- Play Console and App Store Connect forms, declarations, and metadata.
- Browser, simulator, and emulator work for the keepers, per $browser-simulator-routing; lease devices through the device queue and
  release them when done.
- Illustrator and other design-file work, and screen or simulator recordings; stop recordings when done so the leftover reaper never
  has to.
- Run long browser, device, or design-file work, and release steps that wait on a build or upload, in a subagent, so this thread stays
  free for queue and health events.

### Releases

- App store work is this thread's job (owner, 2026-10-22: "all of the app stores tasks are part of your responsibilities"). Once the
  owner gives a release its go, run the whole release without asking: builds, TestFlight, privacy labels and other declarations that
  match the app's real behavior and the project's docs, What's New, metadata, submissions, review rejections and resubmissions,
  forced-update raises, and rollouts.
- Only the go itself stays with the owner: an explicit go at release time, never a plan such as "ship after the polish". The go counts
  only when the owner says it in words such as "ok we need to cut new release", to this thread or to the Housekeeper, which forwards
  it quoting him; a pick in another thread is not one, and other threads never start store builds or releases (owner, 2026-10-29).
- Never ask for a store build or release, and keep none on the page as a pending ask; wait until the owner raises it (owner,
  2026-11-05). Report store outcomes on the status page; ask only when a store asks for something the app doesn't do or the docs don't
  answer.
- Store events wake this thread: App Store Connect webhooks, and Play Console mail piped from Gmail through a Cloudflare Email Worker
  (owner, 2026-11-10). Act on each as it arrives; never schedule a pass or poll a store to wait on a review.
- Business forwards store notices from the owner's mail here.
- Once a Harium version is public in a store, tell Business, which drafts the release announcements (owner, 2026-11-10).

## Mac resources

- Disk space, CPU, and memory never queue or delay work while the Mac stays responsive. One resource-keeper subagent owns all storage and
  Mac-resource work, so this thread never runs slow disk scans or cleanups itself.
- The Mac watcher's minute guard reaps leftovers on every Mac: `device-queue reap` stops a booted simulator or emulator that held no
  lease for 10 minutes, keeping the queue's warm device, and agent screen or simulator recordings running over 30 minutes stop with
  SIGINT so their files finish; leased devices and merge-queue runs' processes stay. On main-mac it messages this thread one
  `leftover-reaper:` line per pass that stops something; when the same owner keeps appearing, tell that thread to release its device or
  stop recording, and send repeats to the resource-keeper subagent.

## Duties

| Duty         | Due                             | Work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions     | every pass                      | Unsettled threads in all projects. Message a session only for a concrete blocker, collision, or dependency; resume an idle owner with authorized unfinished steps. Never ask for status or wake intentional pauses.                                                                                                                                                                                                                                                                                                                                                                           |
| Mac          | every pass                      | Confirm the `com.housekeeper.health-watch` agent ran in the last 5 minutes (`~/.local/state/housekeeper/health-watch-state.json`); it checks Harium's and Awraq's response bodies every minute and wakes the "Production health alert" webhook's thread after two failed runs (owner, 2026-10-30). Read free disk and `mise run watcher -- status`; when disk is under 60 GiB, memory pressure is high, or processes or leases leak, send the resource-keeper subagent the problem (start one if none). It prunes, removes finished worktrees and build outputs, and keeps disk above 40 GiB. |
| Pool         | every pass                      | Read live Claude pool usage (the 5-hour and weekly Limits T3 shows) with `~/.local/state/housekeeper/claude-limits.sh`; warn the owner when an account's week passes 80% or its usage is unavailable (expired login). Never set account priority; the pool routes round-robin (owner, 2026-11-09). Balance load across Macs (owner, 2026-10-29): when main-mac's load stays above its core count or sign-offs keep failing on time limits, move long-running work, such as multi-PR batches, to small-mac or big-mac per $remote-agent-host, and start new long work there first.             |
| AI credits   | every pass                      | Never let either project's OpenAI API stop; the monthly target (in `openai-spend.ts`) is not a cap. `bun ~/.local/state/housekeeper/openai-spend.ts` and credit or quota errors in PostHog backend error tracking; warn the owner before credits or the recharge ceiling run out, and send spend against the target to Business daily for its finance report.                                                                                                                                                                                                                                 |
| Errors       | every pass                      | New and regressed issues in PostHog backend error tracking (each project runbook's query) and Sentry for the apps: fix clear bugs, ignore noise with a reason, prevent the pattern. No report page; raise only owner decisions.                                                                                                                                                                                                                                                                                                                                                               |
| Releases     | on store events                 | Each store event or Business-forwarded notice: review outcome and public availability; once a build is public in a store, raise that platform's forced-update minimum and finish the release doc's ship steps.                                                                                                                                                                                                                                                                                                                                                                                |
| Follow-ups   | daily                           | Each project's `docs/release/` and dated `docs/tech-debt/` entries: run due read-only checks and record only results that changed (new, moved, or closed) in a docs PR from the subagent's own worktree; skip the PR when nothing changed. Unchanged rechecks stay out, so the PR stays small enough to enqueue on green.                                                                                                                                                                                                                                                                     |
| Leftovers    | daily                           | $triage-prs; stale worktrees, branches, temp directories, finished schedules, settled threads.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Credentials  | weekly                          | Tokens and certificates expiring within 30 days.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Doc pruning  | daily, 3+ merges since last run | In each active project with at least 3 merged PRs since its last pruning, apply the $project-docs keep tests to decisions, tech debt, and release entries in one docs PR from a subagent's own worktree. Report decision, tech-debt, and release counts before and after per project, and flag any type that grew since the previous run.                                                                                                                                                                                                                                                     |
| Docs         | weekly                          | $project-docs Cleanup, focused on what the week's merges could have made wrong; `done` plans in `~/plans/<project>/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Roadmap      | daily, and after feature merges | Keep `~/plans/harium/roadmap/` current per its `README.md`, verifying against code and PR content: big work only; minor items go to the project's tech-debt records. Archive shipped items, update status and order in `index.html`'s `data` block and `updated`, then republish with `share-html ~/plans/harium/roadmap --stable --name harium-roadmap --writable`.                                                                                                                                                                                                                          |
| Verification | 3 days                          | $verification health against each project's budgets: stage times, flakes, agent wait time, rule breaks; compare with the last run.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Tools        | weekly                          | $tool-updates on main-mac, small-mac, and big-mac (spare Macs over `ssh <mac>`; defer restarts that would cut running agents), then a digest of Claude Code and T3 Code Nightly changes since the last digest, published every Monday to the status page's To read group (owner, 2026-11-04).                                                                                                                                                                                                                                                                                                 |
