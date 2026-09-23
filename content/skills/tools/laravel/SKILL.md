---
name: laravel
description: Use when writing or reviewing Laravel code, for style, HTTP, authorization, configuration, Eloquent, and queued-job preferences.
---

When the project already uses a consistent pattern, follow it instead.

## Style

- Use read-only data objects with no logic instead of associative arrays for stable application data.
- Use backed enums for constrained values instead of magic strings or integers.
- Use Carbon instead of date strings in application code.
- Use Laravel helpers and collections instead of hand-written code for the same job.

## HTTP

Prefer: route → controller → Form Request → typed data object → service or invokable action → JSON Resource or resource collection. Skip layers a
small endpoint does not need.

Authorize through policies, in the Form Request's `authorize()` or the controller. Never trust a model ID from the request without checking that the
user may access it.

## Configuration

Prefer, in order:

1. A class constant for values that change only with code.
2. A config value when a redeploy is an acceptable way to change it.
3. An environment variable for runtime-specific values. Call `env()` only in config files; use `config()` everywhere else.

## Eloquent

- Do not add `$fillable` or `$guarded` when the app calls `Model::unguard()` globally.
- Query through the model instead of hardcoding table names. Migrations may hardcode them because they are frozen snapshots.
- Eager-load relations the code reads in loops. Keep `Model::preventLazyLoading()` on outside production.

## Jobs and Transactions

- Wrap operations that write more than once in `DB::transaction()`.
- Dispatch jobs and events after the transaction commits.
- Make queued jobs safe to run twice, because failed jobs are retried.
