---
name: project-knowledge
description: Project feature knowledge, functionality documentation, glossary terms, and history.
---

Use project knowledge only for information whose loss would cause a future agent to make the wrong product decision. Run `knowledge --help` for the
live CLI.

## Workflow

1. Run `knowledge find "<query>"` and use its canonical glossary terms so the user and agent share one language. Read the complete glossary only when
   editing language or when the query is insufficient.
2. Read only the one to three returned packs, then inspect the relevant code directly.
3. Use code and runtime evidence to establish current behavior, and active product contracts to establish promised behavior. When they disagree,
   report the mismatch and preserve the promise unless the user changes it.
4. Do not update knowledge as a routine side effect of code work. Update it only when the user changes project language, a product contract, a
   boundary or reason that cannot be recovered elsewhere.

## Creating or Refreshing

1. Inspect local evidence first. Create a missing pack with `knowledge feature "<Feature Name>"`.
2. Put shared vocabulary only in the glossary. Feature packs have no language, glossary, code-map, or evidence section.
3. Give each promised behavior a stable contract ID and a Given/When/Then outcome. Describe what should happen, not how the code implements it.
4. Keep lasting ownership and compatibility rules, and reasons for decisions that might otherwise be revisited.
5. Do not list source files. Put the stable contract ID in an acceptance test when useful so agents can find executable coverage by search. Keep an
   external link only when a contract depends on an external constraint the agent cannot readily rediscover.
6. Move reproducible bug behavior into regression tests. Keep a written lesson only when it explains an important constraint that a test cannot.
7. Keep feature packs to Product Contracts, Boundaries, and optional Rationale. Run `knowledge lint` after editing knowledge; it checks structure, not
   factual accuracy or whether the information is current.
