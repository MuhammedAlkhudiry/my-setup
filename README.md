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
