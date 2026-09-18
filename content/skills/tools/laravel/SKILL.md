---
name: laravel
description: Use when writing or reviewing Laravel code, for style, HTTP layering, configuration, and Eloquent preferences.
---

Follow stronger established project patterns.

## Style

- Prefer readable fluent chains for Laravel APIs.
- Represent stable application data with typed DTOs or value objects that cannot change and contain no logic, rather than associative arrays.
- Use backed enums for constrained values instead of magic strings or integers.
- Use Carbon rather than date strings inside application code.
- Prefer Laravel helpers and collections over custom parsing, manipulation, or query-string construction.

## HTTP

Prefer: route → controller → Form Request → typed data object → service or invokable action → JSON Resource or resource collection.

## Configuration

Use environment variables sparingly. Prefer, in order:

1. A class constant for values that change only with code.
2. A config value when changing it through a redeploy is acceptable.
3. An environment variable for runtime-specific values.

## Eloquent

- Before adding `$fillable` or `$guarded`, check for global `Model::unguarded()` or `Model::unguard()`. Do not add mass-assignment properties when
  global unguarding is active.
- Avoid hardcoded table names in queries. Migrations may use them because they are frozen snapshots.
