# My Setup

Personal source of truth for my Claude Code, Codex, and OpenCode rules, skills, and shell helpers.

## Workflow

Use `mise tasks` as the authority for current project commands. The normal maintenance loop is:

```bash
mise run install
mise run check
doctor
```

After pulling changes, rerun `mise run install` if the managed hooks did not complete successfully. Use `doctor` to identify any remaining local
drift.

## Source Layout

- `content/` — shared agent rules and local skills.
- `config/` — Codex, OpenCode, Claude Code, MCP, permission, active-project, remote-skill, model, and secret-template configuration.
- `src/` — generator, installer, doctor support, project and personal knowledge commands, and tool-status logic.
- `shell/` — synced Zsh configuration and installed helper commands.
- `src/lib/system-tools.ts` — authoritative host-tool inventory and update metadata.

Make durable changes in the source directories, then use `mise run install` to render and sync the installed state.

## Claude Pool on a New Mac

`mise run install` installs the pinned CLIProxyAPI release, creates private local keys and Claude settings, and starts a localhost-only LaunchAgent. It
preserves existing keys and account sign-ins on later runs. Run `doctor` to check the service and T3 Code connection.

Sign in each Claude account separately on the new Mac:

```bash
cliproxyapi -config ~/.cli-proxy-api/config.yaml -claude-login
```

In T3 Code **Settings → Providers**, add a Claude instance named **Claude Pool** with `CLAUDE_CONFIG_DIR` set to `~/.claude_cliproxy`. The default
Claude provider uses `--chrome` in **Launch arguments** for [Claude in Chrome](https://code.claude.com/docs/en/chrome). Install its Chrome extension
when Claude Code prompts for it. The pool dashboard is at [localhost](http://127.0.0.1:8317/management.html); its management key stays in
`~/.cli-proxy-api/management-key`.
