- **SCOPE** — Shared rules, skills, and configuration for Claude Code, Codex, and OpenCode.
- **PERSONAL-ONLY** — Personal infrastructure for the owner; do not design for sharing, multiple users, or configurable distribution.
- **SOURCE-OF-TRUTH** — Edit `content/`, `config/`, `src/`, and `shell/`, never installed copies under the home directory.

## Important Files

- `config/skills.ts` — Remote skills; local skills follow SKILL-STRUCTURE below.
- `config/{codex,opencode,claude,mcp}.ts` — Managed agent and MCP keys.
- `config/t3.ts`, `config/t3-theme.json` — T3 settings and theme applied on every device; providers stay per device.
- `config/devices.ts` — Profile-specific agents, skills, features, secrets, and allowlists. Each machine selects `personal` or `work` in untracked
  `~/.config/my-setup/device.json`.
- `config/permissions.ts` — Renders command and path allowlists for each agent.
- `src/cli.ts`, `src/commands/system-tools-cli.ts` — Installation and external-tool CLI entrypoints.
- `src/commands/install.ts` — Renders and syncs managed local state.
- `src/commands/doctor-checks.ts` — Health checks; extend when the installer owns a new surface.
- `shell/doctor.zsh` — Shell health checks.
- `shell/zsh-custom.zsh` — Synced shell configuration.
- `src/lib/system-tools.ts` — Tool inventory, ownership, update commands, and notes.

- **ACTIVE-PROJECTS** — `config/active-projects.ts` defines project defaults and canonical clones rendered into installed rules. Projects own their
  development services and commands; keep runtime state out of this repo.
- **MAIN-ONLY** — Work on `main`; create branches only when explicitly requested.
- **NO-COMMITS** — Leave changes uncommitted for owner review. Never commit, ask about committing, or list uncommitted changes as pending work.
- **INSTALL** — After changing content, config, or generator behavior, sync only with `mise run install`.
- **WINDOWS** — This repo also installs on Windows; keep changes working there.
- **THIN-ZSHRC** — Migrate custom `~/.zshrc` code into `shell/zsh-custom.zsh`, leave only its managed import in `~/.zshrc`, and rerun installation.
  Repair this directly if it blocks installation.
- **SYSTEM-TOOLS** — Keep `src/lib/system-tools.ts` and `doctor` aligned when workflows change a system-tool dependency.
- **SKILL-STRUCTURE** — Put skill instructions in `content/skills/<category>/<name>/SKILL.md`; `src/lib/skills.ts` validates frontmatter and names.
- **SKILL-OPENAI-YAML** — Never add `agents/openai.yaml` to a skill unless the user explicitly requests it.
- **SKILL-REFERENCES** — When editing or auditing a skill, inspect its referenced files and relevant nearby source, beyond `SKILL.md`.
- **SKILL-CROSS-REFERENCES** — Refer to other skills as `$skill-name` in prose; `src/lib/skills.ts` validates targets.
- **SKILL-PORTABLE** — Use skill-relative references in installed skill files; never source-only `content/skills/...` or local `my-setup` paths.
- **PROFILE-BLOCKS** — In `content/base-rules.md` and skill Markdown, wrap profile-specific content in `<!-- profile:<name> -->` and
  `<!-- /profile -->` lines. Inside lists, align markers with item text so formatting preserves them.
- **WORK-ONLY** — Wrap employer tooling, VPN requirements, and other work instructions in `<!-- profile:work -->` blocks. Before installation,
  verify they appear only in the `work` render. Never sync the device selector between machines.
- **SKILL-GLOBAL** — Keep skills project-independent; name no project, repo, product, client, or local workspace.
- **SKILL-INSTALL** — Never use `npx skills add`; use SKILL-STRUCTURE for local skills and `config/skills.ts` for remote imports.
- **MY-SETUP-CLI** — `my-setup` provides only `install` and help. Use `doctor` for health and `system-tools status` or `system-tools update-plan`
  for external tools.
- **WORDING-QUALITY** — Preserve user intent; rewrite rough wording clearly in the repo's voice.

## Project Glossaries

- **GLOSSARIES** — The Housekeeper runs here and discusses the active projects' product concepts (for example, an Awraq Node is a person
  in a family tree). Their glossaries load live from the canonical clones; Codex and OpenCode read the files at these paths.

@~/PhpstormProjects/awraq-project/docs/glossary.md
@~/PhpstormProjects/harium-project/docs/glossary.md
