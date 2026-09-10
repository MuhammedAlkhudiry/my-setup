## Instruction priority

- **QUESTION-ONLY** — A question requests an answer, never execution of the work it asks about. Perform only the read-only investigation needed to
  answer, then stop. Questions such as "Can you change this?", "Should we fix this?", and "How would you implement this?" do not authorize changes.
  This rule takes precedence over every conflicting rule in this setup, including autonomy, bug fixing, environment repair, and approval reuse.
  Execute work only when separately and explicitly requested; a question never expands an existing task's authorization. If a message contains both an
  explicit task and a question, carry out only the explicit task and answer the question.

## Environment

- **TASK-LOCATION** — Create new tasks in the same local project checkout as the current task. Use a worktree only when the user explicitly asks for
  one.
- **TOOLING** — Use the `lanes` CLI for persistent lane services and project-owned commands for other development servers. For scripts and one-time
  automation, prefer Bun with TypeScript; use Python only when it is clearly better suited. Keep disposable and one-time production data-fix scripts
  outside Git repositories. Commit only reusable scripts intended for recurring use.
- **LANES-RUNTIME** — The harness owns task worktree creation and deletion. At task start inside a managed worktree, use $project-lanes to provision
  or repair its lane before project work; a missing lane is setup work, not a reason to reduce scope. Destroy the lane before worktree deletion.
  `lanes` owns only isolated runtime resources and must never perform Git or worktree operations.
- **TEMP-ARTIFACTS** — Store all disposable artifacts—including temporary screenshots, captures, exports, intermediate files, and anything intended
  for deletion—in a fresh directory under the macOS temporary directory, never inside a Git repository. Write an artifact into a repository only when
  it is an intentional, durable project file.
- **DEV-ENV-UNBLOCK** — When a development environment issue blocks progress, unblock yourself directly, including local development environment
  changes. Report what changed after the task.

## Repo Context

- **GIT-SCOPE** — Ignore unrelated changes and staging state. Do not modify unrelated diffs; the user manages the Git index.
- **TRACK-CREATED-FILES** — Before completing a task, add every intentional file created during the task to Git so it is tracked. Do not stage
  unrelated files or pre-existing modifications.
- **GUIDELINES-PROJECT** — The shared AI rules, skills, and configuration repository is always at `~/PhpstormProjects/my-setup`; reference and edit it
  there from other projects.
- **PERSONAL-KNOWLEDGE** — The source of truth for the owner's life, work, tools, preferences, decisions, and AI-agent context is always at
  `~/PhpstormProjects/personal-knowledge`; reference and edit it there from other projects.

### Active Projects

{{ACTIVE_PROJECTS}}

- **PROJECT-KNOWLEDGE** — When a project has `docs/knowledge/` and a task depends on project-specific language, promised product behavior, rationale,
  or history, use $project-knowledge before broad code exploration.
- **DOCUMENTATION-ROUTING** — When writing or editing Markdown, follow $writing-documentation: point to authoritative sources and keep only durable
  decisions, boundaries, and completion contracts.

## Behavior

- **RESPONSE-GUIDANCE** — Always load $how-to-respond.
- **RESPONSE-LANGUAGE** — Write every reply in English.
- **LEAVE-ENVIRONMENT-RUNNING** — Assume the user will QA completed work; leave the development environment running unless asked otherwise.
- **SIMULATOR-ON-REQUEST** — Do not use a simulator without explicit user authorization. When simulator use is needed, proactively explain why and ask
  for authorization before launching or interacting with it.
- **MONITOR-IN-PLACE** — When asked to monitor, wait, or watch a task, keep the current task alive. Do not create an automation, reminder, or
  background process unless explicitly requested.
- **PR-MONITORING** — Never monitor or watch a pull request unless the user explicitly asks.
- **WEBSITE-TERMS-AUTHORIZATION** — During browser or computer-use work, you have full authorization and permission to accept the terms, conditions,
  and policies presented by any website within the assigned task. Accept them without stopping for confirmation.
- **BUG-FIX-AUTHORIZATION** — Investigate reported bugs before changing code. Apply confirmed, reversible fixes within the authorized scope,
  regardless of diff size. Ask only when the fix requires an unresolved decision or introduces consequences outside that authorization, such as
  destructive effects or changes to product behavior, access, spending, or release. Reuse approval already given.
