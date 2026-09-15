---
name: dependency-upgrade
description: Dependency upgrades, freshness audits, and unused-package cleanup.
---

## Workflow

1. Decide which dependencies the task covers and create a saved report before changing versions.
2. Identify the package manager, relevant workspaces and runtimes, and project checks. List every in-scope dependency from manifests and lockfiles.
3. Use current package-manager help, project dependency files, and official compatibility and release guidance as sources of truth. Load
   $laravel or
   $react when applicable.
4. Upgrade with the project's package manager and apply straightforward compatibility fixes. Ask before broad migrations, architecture changes,
   many-file rewrites, unclear behavior changes, native rebuilds, or test-suite rewrites.
5. Verify risky batches and the final state. Finish only when every in-scope dependency is upgraded, removed, intentionally skipped, or blocked with a
   recorded reason.

## Unused packages

- Check how the project uses a package, including indirect and runtime use, before declaring it unused.
- Remove only clearly unused packages. Ask before removing a package whose use is unclear.
- Record removed, retained, and unclear candidates with evidence.

## Patching

- Do not permanently modify vendor files, installed dependencies, generated package output, or lockfile internals.
- Remove diagnostic patches before finishing. If an upgrade requires a custom patch, fork, alias, or runtime workaround, skip it and request approval
  with cleaner alternatives.

## Report

- Create the report outside source control. Share its path early and update it after every dependency or batch.
- On resume, read the report before continuing. Link it with the latest status in every final answer; a summary does not replace it.
- Include every in-scope dependency, even when unchanged: package, ecosystem, old and new versions, reason, scan marker, dependency type, sources,
  notable changes, code/config/test changes, checks, patch status, and final status.
