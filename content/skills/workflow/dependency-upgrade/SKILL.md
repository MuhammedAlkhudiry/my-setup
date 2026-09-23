---
name: dependency-upgrade
description: Use when upgrading project dependencies, auditing how current they are, or removing unused packages.
---

## Workflow

1. Decide which dependencies the task covers.
2. Identify the package manager, relevant workspaces and runtimes, and project checks. List every in-scope dependency from manifests and lockfiles.
3. Use current package-manager help, project dependency files, and official compatibility and release guidance as sources of truth. Load
   $laravel or $react when applicable.
4. Upgrade patch and minor versions together, then each major version on its own. Use the project's package manager and apply straightforward
   compatibility fixes. Ask before changes beyond compatibility fixes, such as migrations, behavior changes, or native rebuilds.
5. Run the project's checks after each major upgrade and at the end. Finish only when every in-scope dependency is upgraded, removed, intentionally
   skipped, or blocked with a recorded reason.

## Unused packages

- Run the project's unused-dependency tool when it has one.
- Check how the project uses a package, including indirect and runtime use, before declaring it unused.
- Remove only clearly unused packages. Ask before removing a package whose use is unclear.
- Record removed, retained, and unclear candidates with evidence.

## Patching

- Do not permanently modify vendor files, installed dependencies, generated package output, or lockfile internals.
- Remove diagnostic patches before finishing. If an upgrade requires a custom patch, fork, alias, or runtime workaround, skip it and request approval
  with cleaner alternatives.

## Report

- Before changing versions, create the report with $saved-work as type `tracker`. Share its path early and update it after every dependency or
  batch.
- On resume, read the report before continuing. Link it in every final answer.
- List every in-scope dependency, even when unchanged, with its old and new version, final status, reason, notable changes, and checks.
