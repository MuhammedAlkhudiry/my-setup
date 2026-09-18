---
name: verification-report
description: Use to rate how well a project can be verified — coverage, quality, speed, reliability, lint, CI; to run its checks use $verification.
---

## Scope

Assess how effectively agents can verify changes in the project. Include unit and end-to-end tests, QA tools, CI, disposable verification scripts, and
other deterministic checks that establish whether behavior works as expected.

Use $verification and $test-writing for their workflows and quality criteria. Gather additional project context as needed.

Aim for mission-critical rigor. Treat AI-assisted implementation as a reason to pursue comprehensive verification; do not accept 80% coverage as
sufficient by default.

## Assessment and recommendations

Rate each area from 0 to 10, with 10 representing the strongest result. Explain each score using evidence. When evidence is insufficient, report
**Unmeasured** and identify the missing evidence instead of assigning a score.

Base speed and flakiness assessments on repeated measurements under comparable conditions, including CI runs. Report the run count, conditions, timing
variation, and observed failures. A single passing run does not establish reliability.

For recommendations, account for project dependencies and ecosystem tooling, including tools to install, configuration changes, and anything to
remove.

## Rated areas

- **Verification capability:** A score of 0 means the project has no useful checks and changes are difficult to verify. A score of 10 means nearly
  every meaningful change can be verified with suitable tools and coverage. Provide a roadmap to 10 for weak setups, or targeted actions for stronger
  ones.
- **Verification speed:** Profile and benchmark automated tests and other deterministic commands. Recommend actions to reduce feedback time.
- **Test quality:** Apply $test-writing. Estimate the proportion of useful versus poor tests, state the reviewed scope, and identify tests to add,
  improve, or remove.
- **CI quality and speed:** Assess CI independently of local verification. Profile and benchmark it, then recommend improvements. Creating a PR to
  obtain CI measurements is permitted when needed.
- **Reliability:** Assess flakiness across tests and other checks; a higher score means more reliable verification. Recommend corrective actions.
- **Code quality checks:** Assess the coverage, enforcement, and speed of linting and static analysis. Provide a roadmap or targeted actions to
  reach 10.
- **Formatting:** Identify the formatter and every file type it covers, including code, Markdown, styles, and configuration. Run its check command and
  report the number of unformatted files. Assess enforcement in the editor, in pre-commit hooks, and in CI, and report any rule that the formatter and
  the linter both own. Recommend a single formatter per file type and automatic enforcement over manual review.
- **Test coverage:** If coverage measurement is missing, recommend adding it. Otherwise, recommend actions to reach at least 95% coverage and justify
  exclusions for code that does not need testing.
