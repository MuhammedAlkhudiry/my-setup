---
name: project-docs
description: Use before writing, changing, or deleting a project's knowledge, such as decisions, postponed work, release actions, setup facts, runbooks, plans, or reports.
---

Agents act on these docs, so a stale or duplicated line causes wrong work. Write down only what the code, tests, and git history cannot show,
give it one home, and delete it when it stops being true.

## Homes

| Knowledge                            | Home                              | Leaves when                           |
| ------------------------------------ | --------------------------------- | ------------------------------------- |
| Rules every session needs            | `AGENTS.md`                       | a lint rule, test, or hook takes over |
| Why the product works this way       | `docs/decisions/<area>/<slug>.md` | it constrains no change               |
| Postponed work and follow-ups        | `docs/tech-debt/<slug>.md`        | the work is done                      |
| Actions a deploy does not perform    | `docs/release/<slug>.md`          | every action is done                  |
| What the product is, how to reach it | `docs/product-setup.md`           | rewritten as facts change             |
| Product terms                        | `docs/glossary.md`                | the term is retired                   |
| How to do a task                     | `docs/runbooks/<task>.md`         | rewritten as the process changes      |
| Plans, research, reviews, reports    | `~/plans/<project>/<slug>.md`     | done: extract, then archive           |
| Evidence behind a change             | the pull request and commit       | never                                 |

- Only `AGENTS.md`, `CLAUDE.md`, and READMEs stay at the repository root. `AGENTS.md` links each runbook with its trigger, such as "read
  before production access".
- $verification owns `docs/runbooks/checklist.md`; $manage-ad-accounts owns `docs/ads.md`.
- Formats: [decisions](references/decisions.md), [tech debt](references/tech-debt.md), [release](references/release.md),
  [product setup](references/product-setup.md), [plans](references/plans.md).

Decisions, tech debt, and release actions get one file per entry, named with a short kebab-case slug, so parallel branches never edit the same
file. Keep no index file; the folder listing is the index.

## Writing

- Before adding a fact, search the docs for it. Update its existing home and link to it instead of repeating it.
- Give each `AGENTS.md` rule its reason in one clause, so a later cleanup can tell whether it still applies.
- After an agent mistake, prefer a lint rule, test, or hook that catches it; write a rule only when none can.
- Follow $writing-md-files.

## In every change

Before a branch is ready, search the docs for the names, paths, commands, settings, and behavior it changed, and fix what it made wrong. Record
on the same branch each decision it made and each follow-up it leaves, such as a known failing test; never only in the pull request.

## Cleanup

1. Read every doc in the repository and in `~/plans/<project>/`.
2. Check concrete claims, such as paths, commands, settings, and behavior, against the code and live sources. Fix wrong claims; replace
   duplicates with a link to the single home.
3. Delete finished tech-debt and release entries and decisions that constrain no change, after checking each against its real source.
4. For each `done` plan, move its decisions, postponed work, and rules into their homes, then archive it.
5. Delete point-in-time docs from the repository, such as reviews, audits, QA runs, and measurement reports, after moving open findings into
   tech debt. Git history keeps them.
6. Report what changed, what moved where, and each claim you could not verify.
