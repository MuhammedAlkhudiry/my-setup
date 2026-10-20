---
name: laravel
description: Use before editing or reviewing PHP in Laravel apps.
---

Follow consistent project patterns over these defaults.

## Style

- Use read-only, logic-free data objects for stable application data and returns across HTTP, AI tool, job, and service-layer boundaries;
  never return `array<string, mixed>` across them.
- Use backed enums for constrained values, Carbon for dates, and `CarbonPeriod` for day ranges.
- Use collections for lists. Check Laravel helpers and established packages before writing utilities.
- Replace five or more arguments with a data object.

## HTTP

Prefer route → controller → Form Request → typed data object → service/invokable action → JSON Resource/collection. Skip unneeded layers.

- Keep controllers CRUD-only: `index`, `show`, `store`, `update`, `destroy`. Model other verbs as resources: archive/restore becomes
  `ArchiveController@store`/`destroy`. Nest new routes under the parent resource. When splitting endpoints, preserve URI, method, name, and middleware.
- Authorize through policies in the Form Request's `authorize()` or controller; check access to requested model IDs.

## Configuration

Prefer class constants for code-bound values, then config values when redeploying is acceptable, then environment variables for runtime-specific
values. Call `env()` only in config files; use `config()` elsewhere.

Add feature flags or on/off environment variables only when agreed in the plan or defined by an installed package.

## Eloquent

- Keep query logic in models, using local scopes for repeated conditions and relationships instead of foreign-key `where` clauses.
- Use `when()` for conditional queries, `lazyById()` or `chunkById()` for batches, and `firstOrFail()` or `sole()` for one row.
- Link records with explicit foreign keys and unique constraints, not derived identifiers such as hashed UUIDs.
- Omit `$fillable` and `$guarded` when the app calls `Model::unguard()` globally.
- Query through models; hardcode table names only in migrations.
- Eager-load relations read in loops. Keep `Model::preventLazyLoading()` on outside production.

## Jobs and Transactions

Wrap multiple writes in `DB::transaction()`. Dispatch jobs and events after commit; make queued jobs safe to retry.
