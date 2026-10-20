---
name: ai-agents-cli
description: Use for agent CLI calls and delegation fallbacks.
---

Prefer a Codex subagent for Codex work, including reviews. Check all available delegation providers and models, including cross-provider tools.
Use the Codex CLI only when none can create the requested subagent; correctable argument errors do not establish that.

Project `orchestrator_capabilities` to the needed `providerInstanceId` and model `id` fields (e.g. with `jq`); avoid reading the full result.

- Read the CLI's help before calling `codex exec` or `claude -p`; keep second opinions read-only.
- Set medium reasoning effort explicitly when supported, unless the user or task calls for another level.
- Split reviews only when the diff exceeds one context. For Codex `spawn_agent`, set `fork_turns: "none"` unless the user requests inherited context.
- Use one Claude call per task to conserve plan usage.
- Close `codex exec` stdin with `< /dev/null` unless piping the prompt; open stdin can leave it waiting.
- Run a long `codex exec` as the background command itself so its exit notifies you. Do not match processes by name: other sessions use it too.
- If `codex exec` reports "Computer Use was not approved to use <app>", ask the user to allow that app in Codex, then retry; the CLI cannot show it.
