---
name: improve-agent-setup
description: Use to audit the agent setup and recommend improvements.
---

Find where agents waste turns in recorded sessions, read those episodes, and recommend fixes that remove each root cause. Recommend
only; edit nothing.

## Workflow

1. Run the analyzer over Claude Code and Codex sessions (`<skill-dir>` is the installed $improve-agent-setup directory; add `--days`,
   `--cwd`, or `--harness` when the user narrows the scope; `--help` lists options):

   ```sh
   bun <skill-dir>/scripts/analyze-sessions.ts --limit 12 \
     --baseline ~/.local/state/improve-agent-setup/last.json --save ~/.local/state/improve-agent-setup/last.json
   ```

   It ranks friction causes by turns and tokens wasted (wall time second) with up to five episode refs each, and totals waiting on
   checks, builds, QA, and model responses apart. Skip causes that are the work itself and say so in one line.

2. For each of the top 6–8 causes, start one read-only Haiku subagent (`{{models.claudeSubagents.reader}}`), all in parallel. Brief it to print each
   episode with `bun <skill-dir>/scripts/analyze-sessions.ts --episode <ref>`, never open whole sessions, and return facts only per
   episode, each with a short transcript quote: what the agent wanted, what it tried, what failed, where the answer actually was, and
   why it was not found first. No fixes.
3. Synthesize yourself. A root cause counts only when it repeats across episodes, such as "3 of 5 agents looked for X in `docs/`; it
   lives in Y". Open the setup it points at (rules, skills, CLIs, project docs) to confirm it, then propose a concrete fix that cites
   episodes: the exact file and text, or CLI change. Choose the first type that works:
   1. Pointer or fact where agents look first (project `AGENTS.md`, skill, index).
   2. Clearer or more forgiving tool or CLI.
   3. `doctor` check.
   4. Lint rule or test.
   5. Rule text, last.

   Never propose a hook or guard that blocks agents.

4. Only when a recurring cause has no in-house fix, search GitHub for a maintained tool that removes it, and weigh its maintenance cost.

Never recommend GitHub branch protection or rulesets (up-to-date branches, removing admin bypass, merge queues, required checks).

## Report

One table, ranked by turns wasted, one row per cause with a letter so the owner can pick fixes by letter:

|     | Cause | Episodes read | Root cause | Concrete fix | Rating |
| --- | ----- | ------------- | ---------- | ------------ | ------ |

- **Cause** shows turns wasted, with before → after when the baseline has the cause, such as `240 → 60 turns`.
- **Root cause** states the repetition (n of m episodes) and cites one episode ref.
- **Concrete fix** names the fix type, the file, and the exact text or flag.
- **Rating** uses the RATINGS levels against the run's total friction turns, such as "🔴 12% of 5,700 turns".
- Below the table: one or two quoted episode findings for the top cause, then one line each for `gone:` causes, skipped causes,
  waiting totals worth a separate look, and the startup prompt size when it grew.
