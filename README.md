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
- `src/` — generator, installer, doctor support, personal knowledge commands, and tool-status logic.
- `shell/` — synced Zsh configuration and installed helper commands.
- `src/lib/system-tools.ts` — authoritative host-tool inventory and update metadata.

Make durable changes in the source directories, then use `mise run install` to render and sync the installed state.

## Device Profiles

Each machine installs one profile from `config/devices.ts`, chosen in the untracked `~/.config/my-setup/device.json`. The installer stops if the file
is missing, so a new machine never installs the wrong profile by default.

```json
{ "profile": "personal" }
```

- `personal` — this Mac: Claude Code through the Claude Pool, Codex, OpenCode, every skill, the zsh layer, and the Mac watcher.
- `work` — the Windows work laptop: Claude Code with direct sign-in and Codex, only rules and skills that fit work, PhpStorm shortcuts in VS Code,
  and no zsh layer, Pool, Mac watcher, MCP servers, or personal secrets.

Keep `device.json` local to each machine; do not sync it. Work-specific rules and skill instructions belong inside `<!-- profile:work -->` and
`<!-- /profile -->` blocks. The installer injects them only for the work laptop's `work` profile and removes them from the `personal` profile,
including the GlobalProtect VPN rule.

## PhpStorm Shortcuts in VS Code

Profiles with `vscodeKeymap` install the IntelliJ IDEA Keybindings extension for PhpStorm's default Windows keymap, then replace VS Code's user
`keybindings.json` with my PhpStorm customizations from `config/vscode.ts`. Change shortcuts there, not in VS Code; the installer saves a replaced file
that differs as `keybindings.json.bak`. If VS Code Settings Sync is on, turn off its keybindings sync so it does not fight the installer. The
extension is skipped with a warning when the `code` CLI is not on PATH.

The same profile merges the minimal editor layout and disables built-in AI through `VSCODE_SETTINGS` in `config/vscode.ts`, preserving other user
settings. VS Code 1.104 or newer is required for the AI-disable switch.

## Work Laptop on Windows

Run these in PowerShell, not WSL:

```powershell
winget install --id Git.Git
winget install --id Oven-sh.Bun
winget install --id jdx.mise
git clone https://github.com/MuhammedAlkhudiry/my-setup.git $HOME\dev\my-setup
New-Item -ItemType Directory -Force $HOME\.config\my-setup
Set-Content $HOME\.config\my-setup\device.json '{ "profile": "work" }'
cd $HOME\dev\my-setup
bun install
mise run install
```

Then sign in to Claude Code (`claude`) and Codex (`codex`) with the work accounts. Claude Code on Windows runs its shell commands through Git Bash from
Git for Windows. RTK is optional on this profile; the installer skips its hooks when RTK is missing.

## Claude Pool on a New Mac

Claude Code runs only through the Claude Pool. `~/.claude_cliproxy` is the only managed Claude config: rules, skills, settings, and MCP servers are
installed there, and the installer removes the old managed `~/.claude/CLAUDE.md` and `~/.claude/skills`. Session history and other files in `~/.claude`
stay untouched.

`mise run install` installs the pinned CLIProxyAPI release, creates private local keys and Claude settings, and starts a localhost-only LaunchAgent. It
preserves existing keys and account sign-ins on later runs. Run `doctor` to check the service and T3 Code connection.

Sign in each Claude account separately on the new Mac:

```bash
cliproxyapi -config ~/.cli-proxy-api/config.yaml -claude-login
```

In T3 Code **Settings → Providers**, add a Claude instance named **Claude Pool** with `CLAUDE_CONFIG_DIR` set to `~/.claude_cliproxy`, and disable the
default Claude provider. Claude Pool uses `--chrome` in **Launch arguments** for [Claude in Chrome](https://code.claude.com/docs/en/chrome). Install its Chrome extension
when Claude Code prompts for it. The pool dashboard is at [localhost](http://127.0.0.1:8317/management.html); its management key stays in
`~/.cli-proxy-api/management-key`.

## Remote Agent Mac

A spare Mac can run T3 Code as an always-on environment that the main Mac and the phone reach over Tailscale.

1. Finish macOS setup. If a Remote Management screen appears, the Mac is still enrolled by its former owner; get it released first.
2. Install Homebrew, clone this repo, set the profile to `personal`, and run `mise run install`.
3. Install T3 Code Nightly, complete [Claude Pool on a New Mac](#claude-pool-on-a-new-mac), and sign in to Codex and `gh`.
4. Ask an agent in T3 Code to set up this Mac as a remote agent host. The `remote-agent-host` skill covers Tailscale, naming, sleep, and pairing.
