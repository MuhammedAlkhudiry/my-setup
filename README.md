# My Setup

Personal rules, skills, and shell helpers for Claude Code, Codex, and OpenCode. See [AGENTS.md](AGENTS.md) for editing rules,
[CHECKLIST.md](CHECKLIST.md) for checks, and `mise tasks` for commands.

## First install

Create `~/.config/my-setup/device.json` before installing: `{ "profile": "personal" }` on a Mac or `{ "profile": "work" }` on the work laptop.
Profile contents live in [config/devices.ts](config/devices.ts).

On Windows, run in PowerShell, not WSL:

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

Sign in to `claude` and `codex` with work accounts. Claude Code uses Git Bash from Git for Windows.

If VS Code Settings Sync is enabled, turn off keybindings sync to avoid conflicts with the installer. Edit shortcuts in
[config/vscode.ts](config/vscode.ts).

After pulling changes, rerun `mise run install` if the managed hooks failed. Use `doctor` to check local drift.

## Claude Pool on a New Mac

Sign in each Claude account separately:

```bash
cliproxyapi -config ~/.cli-proxy-api/config.yaml -claude-login
```

In T3 Code **Settings → Providers**, add a Claude instance named **Claude Pool**, set `CLAUDE_CONFIG_DIR` to `~/.claude_cliproxy`, and disable the
default Claude provider. Add `--chrome` to **Launch arguments** and install the Chrome extension when Claude Code prompts.

The [pool dashboard](http://127.0.0.1:8317/management.html) uses the key in `~/.cli-proxy-api/management-key`. Run `doctor` to check the pool and T3 connection.

## Remote Agent Mac

A spare Mac runs agents that the main Mac starts and watches over Tailscale. It uses the main Mac's pool for Claude and Codex instead of its
own sign-ins, so the main Mac must stay awake. Ask an agent on the main Mac to follow the `remote-agent-host` skill. It sets up the spare Mac over SSH
and asks you only for the steps that need you there: Tailscale sign-in, Remote Login, one setup command, sign-in approvals, and any setting
that asks for your password.
