# Merge policy

The only place that says who may merge a PR; other rules point here. A PR is **small** at 100 changed lines or fewer across 5 files or
fewer, excluding generated and lock files; above either, it is mid or large.

| PR                                                                                                                     | Who enqueues                     |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Mid or large, any type (owner, 2026-11-09)                                                                             | Owner                            |
| Feature, product change, or production refactor, even one the owner asked for                                          | Owner                            |
| DESIGN-APPROVAL commitment not yet approved; store build or release (STORE-RELEASES)                                   | Owner                            |
| Small, and changes no app or server behavior (docs, agent instructions, tests, tooling)                                | The PR's own thread              |
| Small, and only ad measurement (pixels, conversion events, UTMs)                                                       | The PR's own thread              |
| Small Sentry or bug fix that touches no payments, stored data, or AI prompts and adds no behavior                      | The PR's own thread              |
| Small feature or production change in `auto` mode                                                                      | The PR's own thread              |
| Ops enqueuing for another or vanished thread: only small fixes (bug, test, broken tooling or docs) (owner, 2026-10-29) | Ops                              |

- In the PR's own thread, a plain go, such as "go" or "merge", approves the PR or PRs that thread last asked about; never make the owner
  repeat it with a number (owner, 2026-11-13). Elsewhere, such as the Housekeeper, a blanket go like "merge what's waiting for me"
  covers only PRs named by number.
- Every enqueue needs green sign-off on the head, no conflicts, no open feedback, and no pending owner decision. A UI PR also needs
  checklist item 4's gate and a published demo page; prose such as "screenshots go to the Housekeeper" is not one.
- A PR whose work has its own thread, including spare-Mac threads, gets its merge approval in that thread; the Housekeeper and Ops never
  relay its ready report or ask for it (owner, 2026-11-05).
- Label PRs awaiting the owner `needs-approval`; drop it on approval. They never go on the Housekeeper status page.

Enqueue as PR-CHECKS describes; never merge directly.
