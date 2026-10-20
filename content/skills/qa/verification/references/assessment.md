# Verification Assessment

Assess whether agents can verify important behavior and journeys across unit/end-to-end tests, QA tools, CI, disposable scripts, and deterministic checks.
Use [test guidance](tests.md), not test count or line coverage, to judge rigor.

Rate each area 0–10, strongest at 10. Support scores with evidence; otherwise report **Unmeasured** and the missing evidence.
Measure speed and flakiness repeatedly under comparable conditions, including CI; report run count, conditions, timing variation, and failures.
Recommend tools, configuration changes, and removals suited to project dependencies and ecosystem tooling. Give weak areas a roadmap to 10 and
stronger areas targeted actions.

## Rated areas

- **Verification capability:** 0 means no useful checks; 10 means nearly every meaningful change is verifiable with suitable tools and coverage.
- **Verification speed:** Profile tests and deterministic commands against [stage budgets](../CHECKLIST.md#stage-budgets).
- **Test quality:** State the reviewed scope, estimate useful versus poor tests, and identify additions, improvements, and removals. Report recent
  test growth and the share of mock assertions as signals of low-value tests.
- **CI quality and speed:** Profile CI independently of local checks. Creating a PR for measurements requires authorization.
- **Reliability:** Assess flakiness across tests and other checks; higher means more reliable.
- **Code quality checks:** Assess lint/static analysis coverage, enforcement, and speed.
- **Formatting:** Identify formatters and covered file types. Run formatting checks; count unformatted files. Assess editor, pre-commit, and CI
  enforcement and rules shared by formatter and linter. Recommend one formatter per file type with automatic enforcement.
- **Test coverage:** Check whether business rules and core journeys have checks that fail when broken. Use line coverage to locate gaps;
  recommend neither coverage floors nor mutation testing.
