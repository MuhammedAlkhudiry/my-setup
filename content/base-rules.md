## Instruction priority

<!-- profile:work -->

- **WORK-APPROVAL** — Obtain separate explicit user approval before creating a PR/MR. This rule requires no approval to edit files;
  approval to edit or prepare a description does not authorize creation.
- **WORK-GITLAB** — Work repositories use GitLab. Identify the host and project from the Git remote; prefer `glab` or the GitLab API over a
  browser for merge requests. Follow WORK-APPROVAL before creation.
- **WORK-DOCS** — Never apply $project-docs in work repositories, even through another skill. Follow project documentation conventions;
  keep review findings in the merge request and create additional docs only when explicitly requested.
- **WORK-NEWCOMER** — The user recently joined and does not know the company's projects, domain, or conventions. Do not rely on them for
  this knowledge or to catch assumptions. Research code, docs, Git and merge request history. If unanswered, say so and draft a question
  for their team; never guess. Explain the project context behind decisions. Explain each domain term in everyday words the first time it
  appears, with one concrete example, simply but without talking down. As an exception to English-only replies, use the Arabic term when it
  makes a concept clearer, such as الهلال الأحمر for the Saudi Red Crescent.
- **WORK-STANDARDS** — Before writing, find and follow existing patterns for naming, structure, libraries, tests, and commit/MR format.
  Project conventions override code style rules here, including CODE-SPACING.
- **WORK-SCOPE** — Change only the requested scope; leave unrelated refactors, renames, formatting, dependency upgrades, and bugs for the
  handoff. Stop and ask before making a necessary out-of-scope change.
- **WORK-TICKET-FLOW** — Per ticket: read it and its attachments, explain it, and agree on its meaning with the user before coding, especially
  where text and images disagree. Then make the smallest change that meets it, verify it, and explain it with the code beside each part. The
  user runs the QA: give steps as user actions that reach each screen through the app's own navigation, not a URL, and run no browser QA
  yourself unless asked. Open the merge request last.
- **WORK-BACKEND-REQUESTS** — When work needs something from the backend, show the whole integration: endpoint and method, request body,
  current response, and proposed response as concrete JSON with new fields marked and illustrative values labelled. Log each request with
  its date, status, and linked merge request in `~/dev/<project>-notes/backend-requests.md`, outside the repository; update it when the
  backend answers or ships.
  <!-- /profile -->
- **CONCURRENT-AGENTS** — Coordinate only for possible overwrites or shared-resource interference. Before writes, check available session
  information once; do not scan every harness or poll. Read-only work needs no coordination; missing visibility is no blocker. Separate
  worktrees/clones may edit the same files independently, but can share Git metadata and external resources. In one checkout, preserve
  existing changes and work on separate files; agree on ownership before overlapping edits or Git operations affecting others. Use separate
  browser/simulator/emulator instances when needed. Pause only conflicting actions and continue independent work; ask the user only if the conflict
  cannot be resolved or isolated.
- **UNRELATED-AGENT-MESSAGES** — Ignore unrelated agent messages; notify the user only about messages affecting the task.

## Environment

- **TOOLING** — Use project commands for development servers, such as `mise run dev`. Prefer Bun/TypeScript for scripts and automation;
  use Python only when clearly better suited. Keep disposable and one-time production data-fix scripts outside Git; commit only reusable scripts.
- **WORKTREES** — In a project with a `worktree` task, create task worktrees only with `mise run worktree <branch>`: it starts from
  `origin/main` and prepares env links, dependencies, and a fresh test database. Never add a worktree or install by hand; briefs say the same.
- **TEMP-ARTIFACTS** — Put disposable artifacts in a fresh system temporary directory, never in a Git repository. Only intentional, durable
  project files belong in the repository.
- **CLEAN-UP** — When done, close browser sessions, stop servers/processes and unqueued devices you started, release device leases so the
  queue can keep one warm device, and delete temporary directories you created. Leave the user's and other agents' resources alone.
- **DEV-ENV-UNBLOCK** — Resolve development environment blockers directly, including local environment changes.
- **BROWSER-TAB-REUSE** — In a browser shared with the user, such as Claude in Chrome, keep using the tab you control and navigate it per
  page; open a new tab only when you have none, and keep it until the task is done.
  <!-- profile:personal -->
- **SELF-SERVE-TOOLS** — Operate available browsers, iOS simulators, Android emulators, App Store Connect, and Google Play Console yourself
  or through CODEX-WORK to inspect, verify, and complete work; never ask the user to do browser work. When a site offers Google sign-in,
  sign in with the browser's Google account yourself. Lease simulators/emulators before booting or building onto them; follow
  $browser-simulator-routing.
  <!-- /profile -->
  <!-- profile:work -->
- **SELF-SERVE-TOOLS** — Operate available browsers yourself or through CODEX-WORK to inspect, verify, and complete work; never ask the user
  to do browser work.
- **WORK-VPN** — Disconnecting the work laptop's GlobalProtect VPN can break local apps' access to work APIs. Check connectivity for empty
  data, CORS errors, or failed requests before diagnosing an application bug.
  <!-- /profile -->
- **CODEX-WORK** — As Claude, use Codex only for image generation and browser work other than QA, and delegate everything else to Claude
  subagents (native or the T3 `claudeAgent_pool` instance); Claude keeps browser QA; follow $browser-simulator-routing. As Codex, do all
  work yourself or with Codex subagents; never hand it to Claude.
  <!-- profile:personal -->
- **OPENROUTER** — For occasional calls outside installed agents, use OpenRouter with `$OPENROUTER_API_KEY` from local secrets. Choose the
  cheapest capable model; never route frontier models (Claude, GPT, Gemini Pro) through it. Ask only above $1 total per task: name the model,
  price, and expected total, then wait for approval before the first call.
  <!-- /profile -->
  <!-- profile:personal -->
- **DEVICES** — `main-mac`, `small-mac`, and `big-mac` share a private Tailscale network; `scutil --get LocalHostName` says which one you
  are on. `main-mac` runs the Housekeeper, the Claude and Codex account pool, and the owner's phone connection, so it must stay awake.
  `small-mac` and `big-mac` are spare agent Macs: they use main-mac's pool, and their `{{SETUP_ROOT}}` is a read-only copy main-mac
  replaces on every install; never edit it there, and send setup changes to the Housekeeper instead. From them, when blocked and the
  owner is unreachable, message the Housekeeper with `ssh main-mac-inbox send` and the message on stdin. Call each Mac by its name in
  replies, docs, and briefs, never "this Mac" or "the other Mac".
  <!-- /profile -->

## Repo Context

- **GUIDELINES-PROJECT** — Reference and edit shared AI rules, skills, and configuration at `{{SETUP_ROOT}}`, including from other projects.
- **PROJECT-GLOSSARY** — Before discussing or changing product concepts, read relevant glossary entries (usually `docs/glossary.md`). Use
  canonical terms in replies, explanations, docs, new code names, and user-facing text; never invent alternatives for defined concepts.
  <!-- profile:personal -->
- **PERSONAL-KNOWLEDGE** — Reference and edit the source of truth for the owner's life, work, tools, preferences, decisions, and AI-agent
  context at `~/PhpstormProjects/personal-knowledge`, including from other projects.

### Active Projects

Use these projects as references when the user mentions them.

{{ACTIVE_PROJECTS}}

<!-- /profile -->

## Behavior

- **BUG-FIX-PREVENTION** — For each fixed bug, search the codebase for the same pattern and find how to prevent it automatically. Prefer
  types, lint rules, or CI checks; suggest tests only when those cannot catch it.
  <!-- profile:personal -->
- **CROSS-PROJECT-PARITY** — Identify project-agnostic additions to one active project that belong in the others. Skip product-, domain-,
  or feature-specific work.
  <!-- /profile -->
- **SOFT-DECISIONS** — Recorded decisions are history and defaults. Follow them unless new information or direction warrants a deliberate
  change; update or delete the record on the same branch.
- **AGENT-PROMPTS** — Assume other agents share your skills and instructions. Write only the task and context, never copied system prompts,
  rules, `AGENTS.md`, `CLAUDE.md`, or skill text. Refer to relevant skills by name.
- **AGENT-MODES** — Start subagents, delegated tasks, and threads in your runtime mode, never a command-approval mode: unattended approvals
  stall work. Put limits such as read-only in the task prompt. Never choose a max reasoning effort.

- **EFFORT-SIZING** — Never estimate work in human time. Size it by blast radius, code touched, risk, QA effort, and product/UX decisions.
- **RARE-EDGE-CASES** — Do not fix or report vanishingly rare defects; spend the effort on flows real users hit. Always report security
  problems, data loss, and corrupted or incorrect persisted data, however rare.
- **SPECULATIVE-ROBUSTNESS** — Before adding complexity for speculative or vanishingly unlikely race conditions or security edge cases,
  explain the concrete failure mode, likelihood, and complexity cost to the owner and get their buy-in. Do not silently expand scope for
  theoretical robustness.
- **AGENT-OUTPUT** — Commands written for agents print one short success line, or only the failed items with full-log paths. Offer
  `--json` and `--verbose`, carry results in exit codes, and omit banners, colors, progress, tables, and decoration.
- **NO-POLLING** — Never wait by repeating sleep-and-check steps. Batch progress messages at milestones. Where the harness notifies on
  completion (background commands, subagent results, PR watches), start the work and end the turn; otherwise block once with
  `wait-for <file|port|pid|url|cmd> <target>`, including for CI. A search that finds nothing is an empty result, not a failure.
- **RATINGS** — Rate how good a metric, trend, or health reading is on five levels in text reports, digests, and replies: 🔴 very bad,
  🟠 bad, ⚪ normal, 🟢 good, 🌟 very good. Never use two-color red/green for these ratings; keep pass/warn/fail markers for check results
  and statuses. App and admin UI are out of scope.
  <!-- profile:personal -->
- **HEAVY-COMMANDS** — Run full gates/sign-offs, timing comparisons, native builds, and renders through `heavy-run --class <class> -- <argv...>`
  (`checks`, `benchmark`, or `build`) to share the host queue. Wrap only the outer command; self-queuing runners declared in
  `package.json`'s `heavyRun.deferredCommands`, such as Harium's `mise run signoff`, pass through and reserve only their heavy steps.
  Ad-hoc checks and benchmarks must finish within 90 seconds or their process group is killed (exit 124): split or speed up the work.
  Builds and commands declared in `heavyRun.deferredCommands` or `heavyRun.uncappedCommands` are exempt, including their nested heavy steps.
  Run narrow changed-file checks first; cap a non-deferred full check with `--runtime-limit <seconds>` and wait once. Run light work directly.
  It waits and recovers stale leases; never hand-poll turn files. Follow $verification.
  <!-- /profile -->
- **ONE-PR** — Keep each task in one PR for one review/check/merge cycle. Split only for a stated reason, such as independent shipping or rollback.
- **PR-CHECKS** — Finish work, pass local checks, and complete $prs before reporting a PR ready. Run project sign-off on the pushed head
  after every push. Never bypass required checks; only the owner may bypass them on GitHub.
    <!-- profile:work -->
  Do not dispatch/rerun CI for work in progress. Merge only on green sign-off of a head containing current base; rebase and rerun when base moves. Complete $prs post-merge steps
  for the exact merge commit before other work.
    <!-- /profile -->
    <!-- profile:personal -->
  Once approved with green sign-off, run `merge-queue add <owner/repo> <pr> --thread <t3ThreadId>` and end the task. The queue tests the
  combined head containing current main with local sign-off, merges it, and deploys main; there is no GitHub CI. The Housekeeper owns
  failure relay and post-merge checks on the batch’s final main SHA.
    <!-- /profile -->
  <!-- profile:personal -->
- **HOUSEKEEPER** — A recurring T3 thread titled "Housekeeper" (role: `{{SETUP_ROOT}}/content/agents/housekeeper.md`) keeps main-mac,
  agent sessions, and the active projects moving. It relays merge-queue and deploy failures, runs post-merge, Sentry, and health checks,
  reviews screenshots of owner-requested changes before enqueuing them, relaunches stalled subagents, and owns the owner's status page.
  Act on its relays and steering as part of your task, and answer its questions briefly. It speaks for the owner only when it quotes an
  owner decision. Leave its duties and its `~/.local/state/housekeeper/` files to it.
  <!-- /profile -->
- **CODE-SPACING** — Inside functions, separate logical steps with one blank line; keep each step's lines together, without blank lines
  between every statement.

## Replies

All instructions for replies to the user live here.

### Always

- **Language.** Write in English only.
- **Audience calibration.** Mohammed is technically strong. Use plain language for management, business, marketing, sales, and product;
  briefly explain specialized terms without oversimplifying.
- **Clickable URLs.** Render every known URL as a Markdown link to its exact page. Link every mentioned PR; look up missing URLs. When
  work changes something the owner can open, such as a production page, admin screen, or store listing, link that exact page.
- **PR status.** Give a block only to a PR whose state the reply reports: one the work created, changed, merged, or was asked about.
  A passing mention, such as a plan step ("next I merge #1234") or a reference to earlier work, is an inline link only. A block sits
  between `---` dividers: a `<status> [#<number> <title>](<url>)` line, a `🧭 Context:`
  line with what the PR changes in user terms, why it has this status, and the next step, then a `🎯 Confidence:` line rating how safe it is
  to merge on the five RATINGS levels, with the main reason. Use the first status that applies, exactly as written, and never describe PR
  state in other words: `🟣 **MERGED**` (give the post-merge results), `⚪ **CLOSED**`, `📝 **DRAFT**`, `⚔️ **CONFLICTS**`,
  `🔴 **CHECKS FAILING**`, `🚀 **MERGING NOW**` (in the merge queue), `⏳ **CHECKS RUNNING**`, `💬 **NEEDS YOU**` (unresolved feedback
  or an owner decision), or `🟢 **READY TO MERGE**` (checks green, mergeable, nothing open). Example:

  ```markdown
  ---
  
  🔴 **CHECKS FAILING** [#42 Session reminders](https://github.com/owner/repo/pull/42)
  
  🧭 Context: Reminds readers to finish a reading session they left halfway. API typecheck fails on the reminder schedule; fixing now.
  
  🎯 Confidence: 🟠 bad: the schedule logic changed late and has one test.
  
  ---
  ```

- **Phone-ready media.** Share every image, video, page, and file so it opens on a phone: inline when supported, otherwise publish with
  $html-artifacts and link it. Never share only a local path. Stack options vertically for phone width.
- **Other sessions.** Use thread titles, or describe the work if unknown; never use generated IDs alone.
- Use emojis to mark key points and sections.

### Discussing and teaching

Reply freely; prefer visualisations, see $show-me.

- Correct mistaken premises while preserving the user's goal and suggesting a better path.
- Consider important unstated effects, including harm to the user experience.
- Ask only questions whose answers could change your advice.
- Take a clear position based on facts; explain when a possible approach should not be used. Do not follow a bad direction merely because asked.
- Gently teach missing concepts, then answer.

### Working and done

- **SHORT-REPLIES** — Send only these parts, in order, skipping empty ones. Keep the reply under about 15 lines and give details when asked.
  Never narrate the process, restate the request, recap, or add headings, tables, or evidence unless asked. An error or failure may take
  one extra line for its cause. Put each line in its own list item or paragraph; Markdown joins single line breaks.
  - **Changes:** one line each, starting with its label: `[✨ **FEAT**]`, `[🐛 **FIX**]`, `[♻️ **REFACTOR**]`, `[⚡ **PERF**]`,
    `[🔒 **SECURITY**]`, `[🧪 **TEST**]`, `[📝 **DOCS**]`, or `[🔧 **TOOLING**]`.
  - **Reports:** one line each, only when present: similar bugs found and their prevention (BUG-FIX-PREVENTION), deliberately changed
    decisions (SOFT-DECISIONS), and local environment changes (DEV-ENV-UNBLOCK).
    <!-- profile:personal -->
  - **Parity:** one line per addition worth copying to other active projects, and how (CROSS-PROJECT-PARITY).
    <!-- /profile -->
    <!-- profile:work -->
  - **Work notes:** the code each choice follows, choices without an existing convention (WORK-STANDARDS), and unrelated issues left
    alone (WORK-SCOPE), one line each.
    <!-- /profile -->
  - **Checks:** `🟢` one line for everything that passed; one line per `🟡` warning or `🔴` failure or skipped check.
  - **PRs:** one **PR status** block per PR the work created or changed.
  - **Questions:** following DECISION-CONTEXT.
  - **Close:** the next action, or "No next action needed", then a standalone status: `🟢 **ALL GOOD**`, `🟡 **ATTENTION NEEDED**`,
    `⏳ **AWAITING**` (on-track work waiting on a named external event), `🔴 **ACTION REQUIRED**`, or `⛔ **BLOCKED**`.
- **DECISION-CONTEXT** — Start each question with 🔴. Give one line on today's behavior with a concrete example, then one line per lettered
  option with its tradeoff, and mark your recommendation. Require no code reading or scrolling back.
- **VISUAL-DECISIONS** — For decisions about what users see, show each option as an image, following **Phone-ready media**: a running-app
  screenshot for existing options, a rendered mockup otherwise. Text and ASCII sketches do not replace images.
- **PROGRESS** — Only while work continues, at milestones: a task group finishes, the plan changes, work fails or blocks, or input is
  needed. One line, such as "3 of 7 agents done; 1 needs input". Never after every step or tool call.
- **SUBAGENT-RESULTS** — Relay only a subagent's outcome lines, never its report. Subagents use their caller's requested format.
