---
name: exhaustive
description: Use when the owner asks for an exhaustive, every-item, or leave-no-stone pass over a defined set, such as a whole-codebase audit.
---

Done is computed, never claimed: a fixed inventory, a full item × dimension ledger with evidence, and checks by agents that did not do
the work. A partial pass that reads as complete is the failure this skill exists to prevent. It costs several times a normal run, so use it
only when asked; other skills, such as $code-quality-report, run their work through it when the owner wants it exhaustive.

## 1. Scope and dimensions

Name the set (files, routes, models, screens, strings) and the dimensions every item is judged on, each with a one-line check. Write
them down before reading any item; adding a dimension later restarts the run.

## 2. Inventory by command

Write a command whose output is the item list, one per line, such as `git ls-files` filtered by path and type or a framework route list.
Save it as `inventory.txt` in a fresh temporary directory. Never hand-pick items. Exclusions, such as generated files, are part of the
command and go in the report.

Size the run before starting: cells are items × dimensions, at about 20 items per slice agent. Above about 2,000 cells, narrow the
inventory to what the question needs, such as app code without tests, migrations or enums, or split it into batches tracked across runs.
Never start a sweep that cannot finish, and never fill slices yourself in place of slice agents.

## 3. Sweep

Invoking this skill is the opt-in for its Workflow. Run `Workflow` with `scriptPath` `<skill-dir>/assets/workflow.js`, where
`<skill-dir>` is the installed $exhaustive directory, and `args`
`{task, root, scope, items, dimensions: [{name, check}], sliceSize}`. It shuffles the items, gives each slice of about 20 to a fresh
agent, re-inventories blind, and spot-checks clean cells, weighted to the end of each slice, re-auditing a slice that fails. On hosts
without Workflow, spawn one subagent per slice and per check with the same prompts, and keep the ledger yourself.

## 4. Gate

Save the result's `rows` as `ledger.json`, then run
`bun <skill-dir>/scripts/validate-ledger.ts --inventory inventory.txt --dimensions <names> --ledger ledger.json --root <repo>`.
It fails missing cells, quotes absent from the cited line, bare `na` cells, pasted notes and quotes, and slices whose issue rate is far
below the rest. Rerun the sweep for the slices it reopens, with only their items, at most twice; anything still failing is unresolved.
Confirm each `unlisted` item from the blind re-inventory, add those in scope to the inventory, and sweep them too.

## 5. Synthesis and report

Build conclusions only from the ledger; never re-read code to summarize it. Report:

- coverage, such as `412 items × 6 dimensions, 2,472 cells, validator clean`;
- the spot-check miss rate and re-audited slices;
- the inventory command and its exclusions;
- findings grouped and ranked from the ledger;
- unresolved cells by name, never folded into a vague note;
- the ledger path. For work that spans sessions, keep it in a $project-docs `tracker`.
