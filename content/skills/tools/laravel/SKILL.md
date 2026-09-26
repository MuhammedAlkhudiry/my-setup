---
name: laravel
description: Use when writing or reviewing Laravel code, for style, structure, HTTP, validation, authorization, configuration, Eloquent, and queued-job preferences.
---

When the project already uses a consistent pattern, follow it instead.

## Style

- Use read-only data objects with no logic instead of associative arrays for stable application data. Every boundary returns a data object:
  HTTP, AI tools, jobs, and services called from another layer. Never return `array<string, mixed>` across one.
- Use backed enums for constrained values instead of magic strings or integers.
- Use Carbon instead of date strings in application code, and `CarbonPeriod` to walk ranges of days.
- Use collections for lists, and Laravel helpers instead of hand-written code for the same job. Before writing a utility, check the framework
  and established packages.
- Replace a long argument list (five or more) with a data object.

## HTTP

Prefer: route → controller → Form Request → typed data object → service or invokable action → JSON Resource or resource collection. Skip layers a
small endpoint does not need.

- Keep controllers CRUD-only: `index`, `show`, `store`, `update`, `destroy`. Model any other verb as its own resource with its own controller. For
  example, archiving becomes `ArchiveController@store` and restoring becomes `ArchiveController@destroy`. Nest routes under the parent resource.
- Authorize through policies, in the Form Request's `authorize()` or the controller. Never trust a model ID from the request without checking
  that the user may access it.

## Configuration

Prefer, in order:

1. A class constant for values that change only with code.
2. A config value when a redeploy is an acceptable way to change it.
3. An environment variable for runtime-specific values. Call `env()` only in config files; use `config()` everywhere else.

## Eloquent

Write queries that read like a sentence.

- Name repeated conditions as local scopes, such as `Action::active()`, and query through relationships instead of manual foreign-key `where`
  clauses.
- Use `when()` instead of branching around query building, `lazyById()` or `chunkById()` for batches, and `firstOrFail()` or `sole()` for one
  row.
- Keep query logic in models: scopes, relationships, and small intention-revealing methods. Keep it out of commands and controllers.
- Link records with explicit foreign keys and unique constraints instead of derived identifiers, such as hashed or namespaced UUIDs.
- Do not add `$fillable` or `$guarded` when the app calls `Model::unguard()` globally.
- Query through the model instead of hardcoding table names. Migrations may hardcode them because they are frozen snapshots.
- Eager-load relations the code reads in loops. Keep `Model::preventLazyLoading()` on outside production.

## Jobs and Transactions

- Wrap operations that write more than once in `DB::transaction()`.
- Dispatch jobs and events after the transaction commits.
- Make queued jobs safe to run twice, because failed jobs are retried.
