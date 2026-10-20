---
name: project-docs
description: Use before writing, changing, or deleting project knowledge.
---

Document only what code, tests, and git history cannot show. Give each fact one home and delete it when it stops being true.

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

- Only `AGENTS.md`, `CLAUDE.md`, and READMEs stay at the repository root. Link each runbook from `AGENTS.md` with its read trigger.
- $verification owns `docs/runbooks/checklist.md`; $service-access owns `docs/ads.md`.
- Formats: [decisions](references/decisions.md), [tech debt](references/tech-debt.md), [release](references/release.md),
  [product setup](references/product-setup.md), [plans](references/plans.md).

Use one file per decision, tech-debt entry, or release action with a short kebab-case slug to avoid parallel edits. Keep no index file.

## Writing

- Search before adding a fact; update its home and link to it elsewhere.
- Give each `AGENTS.md` rule a one-clause reason so cleanup can assess whether it still applies.
- Prevent agent mistakes with lint, tests, or hooks; add a written rule only when none can catch them.
- Follow $writing-md-files.

## In every change

Before a branch is ready, search docs for changed names, paths, commands, settings, and behavior; correct stale claims. Record decisions and
follow-ups on the same branch, never only in the pull request.

## Cleanup

1. Read every doc in the repository and in `~/plans/<project>/`.
2. Verify paths, commands, settings, and behavior against code and live sources. Fix wrong claims and replace duplicates with links.
3. Check against real sources, then delete completed tech-debt and release entries and decisions that constrain no change.
4. Extract and archive `done` plans as [plans](references/plans.md) describes.
5. Move open findings into tech debt, then delete repository reviews, audits, QA runs, and measurement reports; git history keeps them.
6. Report changes, moves, and unverified claims.
