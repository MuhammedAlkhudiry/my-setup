---
name: power-user-qa
description: Use a product or feature as a demanding real user and collect UX issues and bugs.
---

## Workflow

1. Use the requested scope. Learn what it promises and what users can reach, then choose distinct, realistic personas under real pressure. Get
   approval before costly or irreversible actions.
2. Use the running product through its real interface in an isolated environment with realistic data, accounts, and read access to its data and
   logs. Use $browser-simulator-routing for tools and $project-lanes for the environment.
3. Use every feature in scope heavily through complete journeys, then try to break it as a real user could: repetition, interruption, abandoned
   flows, limits, bad input, account switching, poor network, locale, and accessibility. For a large scope, split areas across subagents that share
   no devices or accounts.
4. After each meaningful action, check stored data, side effects, and logs against the intended result, even when the interface looks correct.
5. Record UX issues and bugs: broken behavior, confusing copy, dead ends, missing feedback, missing expected features, and hidden wrong results.
   Reproduce each issue twice.
6. For each issue, report severity by user impact, where it happens, steps, expected and actual result in plain user language, evidence, and a
   recommended fix. Also list what held up and what could not be tested and why.
