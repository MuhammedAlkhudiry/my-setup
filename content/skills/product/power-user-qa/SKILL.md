---
name: power-user-qa
description: Use only for requested power-user QA or thorough testing of a running product.
---

Use $verification for routine implementation checks and $ux-ui for design review.

## Workflow

1. Learn the requested scope's promises and reachable features; choose distinct, realistic personas under pressure. Get approval for costly or
   irreversible actions.
2. Use the real interface in an isolated environment with realistic data/accounts and read access to data/logs. Follow $browser-simulator-routing
   and the project's development commands.
3. Exercise every feature in scope through complete journeys, including repetition, interruption, abandonment, limits, bad input, account switching,
   poor network, locale, and accessibility. Focus on common usage; skip rare setups such as maximum text or extreme combined settings.
   For broad scopes, split areas across subagents with separate devices/accounts. For UI journeys, use $verification's screen/text coverage reference.
4. After meaningful actions, check stored data, side effects, logs, and hidden failed requests against expected results.
5. Reproduce issues twice, including broken/inert controls, confusing copy, dead ends, missing feedback/features, and hidden wrong results.
6. Report each issue's user-impact severity, location, steps, expected/actual result in user language, evidence, and recommended fix.
   List what held up and untested areas with reasons.
