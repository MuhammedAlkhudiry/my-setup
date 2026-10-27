---
name: remote-agent-host
description: Use to set up a spare Mac that agents run on remotely, or to move work onto one.
---

The main Mac's agent sets up the spare Mac over SSH. The owner only does what needs their hands or password: sign-ins, system prompts, and
settings that ask for the Mac password. Batch those into one short list with exact clicks. Commands and pitfalls are in
[details](references/details.md).

## Steps

1. **Owner first steps:** install the standalone [Tailscale app](https://tailscale.com/download/mac) and sign in with the other devices'
   account; turn on Remote Login and Screen Sharing; run one setup command for the main Mac's SSH key, key-only SSH, and, if approved,
   passwordless `sudo`. Copy and paste doesn't work between Macs, so serve the command over the tailnet.
2. **Identity:** a short, distinct name through `scutil` and `tailscale set --hostname`. Restart T3 and redo Tailscale Serve afterwards.
3. **Never offline:** no sleep at all, no automatic macOS updates, and Tailscale and T3 starting at login. To come back after a power
   cut without anyone there, it needs FileVault off and automatic login. Ask the owner first, because the disk then holds readable
   project secrets.
4. **Tools and projects:** match the main Mac's Homebrew packages and agent CLIs, install this setup with the `personal` profile, and
   clear `doctor` failures. Skip what its role doesn't need. Clone and prepare its projects.
5. **Accounts:** Claude and Codex go through the main Mac's pool (`claudePoolUrl` in `device.json`), so the main Mac must stay awake.
   Other services, such as `gh` and `cf`, sign in on the spare Mac itself; never copy a sign-in that renews itself.
6. **T3:** pair the main Mac's app with it through a single-use link minted over SSH, and the phone separately: apps connect to each Mac
   directly. Add the Claude Pool provider and the projects.
7. **Setup sync:** list the Mac under `"mirrors"` in the main Mac's `device.json`, so every install there copies this setup to it.
8. **Talking between Macs:** the main Mac drives threads there with `t3 thread` over SSH. Agents there reach the main Mac only through a
   message-only key that posts to the Housekeeper.
9. **Moving work:** push the old thread's unpushed work right before the move, copy notes kept outside the repo, retire the old thread,
   and start the new one with a self-contained brief.

## Done when

- The spare Mac shows in the main Mac's T3 and runs a thread; `tailscale ping <name>` replies; `doctor` has no unexpected failures;
  Claude and Codex answer through the pool.
- The $personal-knowledge devices note records its name, role, and owner decisions such as FileVault.
