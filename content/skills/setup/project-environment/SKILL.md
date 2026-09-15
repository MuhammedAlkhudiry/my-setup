---
name: project-environment
description: Shared project environment setup and maintenance.
---

Keep every active project's environment adapter in the shared project-environment runtime. Project repositories must not contain lane lifecycle
scripts or a `PROJECT-LANES.md`. Use $project-lanes to manage and check environments; never edit its state directly.

## Workflow

1. Inspect the central project adapter, active-project declaration, repository task definitions, and current environment files. Assign every resource
   that can change to one stable environment identity.
2. Update the central adapter for project-specific setup, mobile development, verification, reset, and destruction. Reuse the shared runtime wherever
   it already provides the needed behavior.
3. Keep project repositories focused on application commands. Remove duplicated lane scripts, lifecycle tasks, and instructions after central
   ownership covers them.
4. Run repair repeatedly and verify the current lane. Exercise reset or destruction only with authorization.

## Environment ownership

- Store project secrets and generated environment files under `SERVICE_CREDENTIALS_HOME`, outside every Git repository. The canonical clone and each
  managed task worktree receive `.env`, `.env.testing`, and mobile `.env.local` links into that store.
- Preserve existing values during the first migration. Move declared real secrets into the project-level secret file without printing their values.
- Derive lane-specific settings and safe testing defaults centrally.
- Let project tasks manage their temporary command outputs. Do not turn project tasks into `lanes` subcommands.

## Rules

Lane identity, canonical-clone protection, and managed environment-file rules are defined in $project-lanes.

- Treat `PROJECT_LANE_ID` and `PROJECT_LANE_NUMBER` as authoritative; never infer identity from a path or branch. The id is `main` or a clear task
  name; the number is an internal resource slot, not user-facing identity.
- Require `PROJECT_LANE_DEFINITION_ROOT` and the configured project root to agree.
- Make setup safe to repeat and keep environments isolated. Report invalid configuration instead of hiding it with a fallback.
- Setup owns lane storage repair; verification stays read-only. Preserve catalog assets during resets, scope object cleanup safely, and delete buckets
  only during destruction.
- Derive the Laravel testing database from the lane prefix and let Laravel append its parallel process token; never use a shared `testing` database.
- Treat the lane's Herd certificate and key as required resources. Fail verification when either is missing.
- Preserve every simulator service required by the project's user-visible integrations. Treat services marked always enabled by SimSlim as mandatory.

Finish only when repair is safe to repeat and the selected lane passes verification without using another lane's resources.
