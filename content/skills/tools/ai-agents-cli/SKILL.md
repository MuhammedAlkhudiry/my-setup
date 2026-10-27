---
name: ai-agents-cli
description: Use for agent CLI calls and delegation fallbacks.
---

Delegate to subagents of the provider CODEX-WORK names. Check all delegation providers and models, including cross-provider tools.
Use that agent's CLI only if none can create the requested subagent; fix argument errors first. A disabled instance is not unavailability:
use another instance of that provider that supports child tasks, such as Claude Pool. CLI runs are invisible to the delegating thread;
never fall back to one just to keep working in the background.

Project `orchestrator_capabilities` to needed `providerInstanceId` and model `id` fields (e.g. with `jq`); do not read the full result.

- Read the CLI's help before calling `codex exec`, `claude -p`, or `opencode run`; keep second opinions read-only.
- Set unattended permissions explicitly: `codex -a never exec`, `claude -p --permission-mode bypassPermissions`, or `opencode run --auto`;
  defaults may wait for approval. Stay within task authorization.
- Isolate edits in a separate worktree: Codex/Claude `--worktree`, or OpenCode's working directory; uncommitted parent edits are not copied.
- Set medium reasoning explicitly when supported, unless the user or task requires otherwise.
- Split reviews only beyond one context. For Codex `spawn_agent`, set `fork_turns: "none"` unless the user requests inherited context.
- Use one Claude call per task to conserve plan usage.
- Close `codex exec` stdin with `< /dev/null` unless piping the prompt; open stdin may hang.
- Background long `codex exec` commands directly for exit notifications. Never match processes by name: other sessions use it too.
- If `codex exec` reports "Computer Use was not approved to use <app>", ask the user to allow that app in Codex, then retry; the CLI cannot show it.
