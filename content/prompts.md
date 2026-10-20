# Prompts

## Perspective shifts

**Invisible work**

```text
What must users do by hand, remember, or leave the app for that the product could handle?
```

**Angry exit**

```text
Write our most frustrated power user's cancellation email. Ground every complaint in a real flow in the code.
```

**Price shift**

```text
What would justify a 10x price increase? What would we remove if it were free?
```

**Names that lie**

```text
Find names, comments, and types that no longer match what the code does.
```

**First break at 100x**

```text
At 100x users, data, or team size, what breaks? Rank failures by which hits first.
```

**Misplaced complexity**

```text
Where do we spend complexity on things users don't value, or underserve things they do?
```

**Contrarian take**

```text
Argue for your strongest opinion about this product or codebase that I would probably disagree with.
```

**Missing question**

```text
What important question about this product have I never asked? Answer it.
```

## Insights

**Manual work sweep**

```text
Walk every user flow for manual work, re-entry, things to remember, and trips outside the app.
Cite files, estimate frequency from production data, and rank by total user effort.
```

**Struggle map**

```text
Find active users' retries, abandoned flows, errors, and quickly exited screens in production data.
Trace each to code and rank by affected active users.
```

**Feature value triage**

```text
For every feature, pull production user counts, frequency, and retention compared with non-users.
Classify as core, niche, or dead; recommend investment, simplification, or deletion.
```

**Promise audit**

```text
Check every promise in UI copy, emails, docs, and marketing against code and production behavior.
Rank broken or partly kept promises by users exposed.
```

**Complexity versus value**

```text
Compare each domain's code size and git churn with production usage. Flag mismatches in either direction, with numbers.
```

**Total wait time**

```text
Multiply each endpoint's and screen's production latency by call volume.
Rank by total user wait time; trace the top 10 to code with a fix for each.
```

**Wasted work**

```text
Find unseen fetched data, unused computations, unread job output, and identical queries repeated per request.
Measure production cost and rank findings.
```

## Product and UX

**Domain improvements**

```text
Map features or domains. Use one parallel subagent per domain to propose 3–5 medium or large UX or product improvements.
Group by domain, one line per improvement; no small tweaks.
```

**Divergent ideas**

```text
Use 6 subagents blind to each other's work, one per lens: user friction, removal or automation, broken assumptions, compounding benefits,
other industries, 10x constraints. Drop generic ideas. Merge, deduplicate, and rank the top 10 by impact over effort.
```

**Journey map**

```text
Draw the 5 key user journeys from routes, models, and tests as step-by-step flows in one HTML page.
Mark extra steps, dead ends, confusion, weak feedback, and missing recovery.
Propose medium or large changes for the worst friction, one line each.
```

## Growth and revenue

**Time to value**

```text
Find the product's "aha" moment in code and the shortest path from signup to it.
List every step before first value; recommend which to cut, defer, or automate.
```

**Offer audit**

```text
As a skeptical buyer, assess pain, objections, proof, pricing, and competitors. Recommend the 5 changes most likely to raise conversion.
```

**Buyer patterns**

```text
Compare paying customers with similar non-paying signups using read-only production data: acquisition source, first actions,
time to first value, features used, and days to purchase. Back every pattern with counts.
Propose medium or large changes that move users onto the buyer path, one line each.
```

## Architecture and code quality

**Weakest parts**

```text
Name the 3 parts most fragile, confusing, or likely to block next year's features. Explain why and how to improve each.
```

## Performance and cost

**Running cost**

```text
Audit infrastructure, third-party and usage-priced APIs including AI, and CI minutes. Rank the top 5 savings by estimated monthly impact.
```

## Tests and verification

**Mutation check**

```text
Use one cheap-model subagent per critical module. Mutate key logic, conditionals, and operators one change at a time, running the suite after each.
Report every surviving mutation as a test gap, grouped by module.
```

## Reliability, accessibility, and copy

**Observability blind spots**

```text
Would we detect broken auth, payments, destructive actions, or background jobs within minutes?
List blind spots, duplicate error logs, and logged secrets or personal data.
```
