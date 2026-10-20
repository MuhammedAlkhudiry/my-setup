---
name: dependency-upgrade
description: Use before upgrading, removing, or auditing project dependencies.
---

## Workflow

1. Scope dependencies from manifests and lockfiles; identify the package manager, workspaces, runtimes, and checks.
2. Use current package-manager help, project files, and official compatibility/release guidance. Apply $laravel or $react where relevant.
   Route Expo SDK upgrades through $upgrading-expo.
3. Upgrade patches/minors together, then each major separately, using the project's package manager. Apply straightforward compatibility fixes;
   ask before migrations, behavior changes, native rebuilds, or other work beyond compatibility.
4. Reference GitHub Actions by version tag, such as `actions/checkout@v5`; never pin them to commit SHAs.
5. Run project checks after each major and at the end. Account for every dependency: upgraded, removed, intentionally skipped, or blocked
   with a reason.

## Unused packages

Use the project's unused-dependency tool if available, then check indirect and runtime use. Remove only clearly unused packages; ask when
unclear. Record removed, retained, and unclear candidates with evidence.

## Patching

Never leave edits to vendor files, installed dependencies, generated package output, or lockfile internals. Remove diagnostic patches.
If an upgrade needs a custom patch, fork, alias, or runtime workaround, skip it and request approval with cleaner alternatives.

## Report

- Before version changes, create a $project-docs `tracker`, share its path, and update it after each dependency or batch.
- Read it on resume; link it in every final answer.
- Include unchanged dependencies: old/new versions, final status, reason, notable changes, and checks for every in-scope dependency.
