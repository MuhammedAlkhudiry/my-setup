# Prompts

Occasional, high-leverage prompts that work on any product or codebase. Replace `[brackets]` before sending.

## Perspective shifts

**Invisible work**

```text
What does the user still do by hand, remember, or do outside the app that the product could do for them?
```

**Angry exit**

```text
Write the cancellation email our most frustrated power user would send. Ground every complaint in a real flow in the code.
```

**Price shift**

```text
If the price went up 10x, what would the product need to justify it? If it were free, what would we remove?
```

**Names that lie**

```text
Find names, comments, and types that no longer match what the code does.
```

**First break at 100x**

```text
At 100x users, data, or team size, what breaks first? Order the failures by which one hits first.
```

**Misplaced complexity**

```text
Where do we spend complexity on things users don't value, and where is it missing on things they do?
```

**Contrarian take**

```text
What is your strongest opinion about this product or codebase that I would probably disagree with? Argue for it.
```

**Missing question**

```text
What important question about this product have I never asked? Answer it.
```

## Insights

Unusual angles backed by a sweep of the codebase or production data, with evidence for every finding and a ranked result.

**Manual work sweep**

```text
Walk every user-facing flow and list each place the user must do something by hand, re-enter data, remember something, or leave the app.
Cite the file for each. Estimate how often it happens from production data and rank by total user effort.
```

**Struggle map**

```text
Use production data to find where active users struggle: repeated retries, abandoned flows, errors, screens opened and quickly left.
Trace each to the code and rank by how many active users hit it.
```

**Feature value triage**

```text
List every feature and pull its production usage: users, frequency, and retention of users who use it compared with users who don't.
Classify each as core, niche, or dead. Say what to invest in, simplify, or delete.
```

**Promise audit**

```text
Collect every promise in UI copy, emails, docs, and marketing pages. Check each against the code and production behavior.
Rank broken or partly kept promises by how many users see them.
```

**Complexity versus value**

```text
For each domain, measure code size and git churn, then production usage.
Flag domains where effort and value are badly out of line in either direction, with numbers.
```

**Deliberate breakage**

```text
Break key logic one change at a time and run the suite after each. List every break the tests miss, grouped by module.
```

**Total wait time**

```text
Pull production latency for every endpoint and screen and multiply by call volume.
Rank by total user wait time, then trace the top 10 to the code with a fix for each.
```

**Wasted work**

```text
Find data fetched but not shown, values computed but unused, jobs whose output nobody reads, and repeated identical queries per request.
Measure each in production and rank by cost.
```

## Product and UX

**Domain improvements**

```text
Map this app into its features or domains. Use one parallel subagent per domain to propose 3–5 medium or large UX or product improvements.
No small tweaks. Return them grouped by domain, one line per improvement.
```

**Divergent ideas**

```text
Spawn 6 subagents that cannot see each other's work. Each brainstorms improvements from one lens: user friction, remove or automate,
broken assumptions, compounding leverage, ideas from other industries, 10x constraints. Drop any idea a generic listicle could contain.
Merge, dedupe, and rank the top 10 by impact over effort.
```

**Journey map**

```text
Map the 5 most important user journeys from the routes, models, and tests, and draw each as a step-by-step flow in one HTML page.
Mark the friction on each flow: extra steps, dead ends, confusing moments, weak feedback, and no way to recover.
Then propose medium or large changes that remove the worst friction, one line each.
```

## Growth and revenue

**Time to value**

```text
Find this product's "aha" moment in the code and map the shortest path from signup to it.
List every step before first value and say which ones we can cut, defer, or automate.
```

**Offer audit**

```text
Read this product as a skeptical buyer: pain, objections, proof, pricing, and competitors.
Return the 5 changes most likely to raise conversion.
```

**Buyer patterns**

```text
Using read-only production data, compare customers who paid with similar signups who never did.
Look at acquisition source, first actions, time to first value, features used, and days to purchase. Back every pattern with counts.
Then propose medium or large changes that move more users onto the buyer path, one line each.
```

## Architecture and code quality

**Weakest parts**

```text
Name the 3 weakest parts of this system: the most fragile, confusing, or likely to block the next year of features.
Explain why and what you would do about each.
```

## Performance and cost

**Running cost**

```text
Audit what this product costs to run: infrastructure, third-party and usage-priced APIs including AI, and CI minutes.
Return the top 5 savings with estimated monthly impact.
```

## Tests and verification

**Mutation check**

```text
launch swarm of cheap model agents that mutate key conditionals and operators in the critical modules and run the tests.
Report every mutant that survives as a test gap.
subagent per module.
```

## Reliability, accessibility, and copy

**Observability blind spots**

```text
For auth, payments, destructive actions, and background jobs: would we know within minutes if each broke?
List blind spots, errors logged twice, and secrets or personal data in logs.
```
