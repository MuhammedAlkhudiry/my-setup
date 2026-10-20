# Development Ports

Check these ports independently: the Metro process, the native client's Metro configuration, reload/automation tooling, the device-reachable backend,
and any web proxy or tunnel. Metro reachability does not prove API reachability.

Trace the failing path through tracked configuration, native settings, scripts, automation, and running processes. Update affected surfaces together
in tracked source, not ignored generated files. Rebuild clients when compiled configuration changes; verify configuration, client loading, reload,
and API access for the changed paths.

## Local HTTPS

A fresh device may lack the local development certificate authority. Install it before signing in:

- Use the project's own task when it has one.
- For an iOS simulator on a host with Herd or Valet, run
  `xcrun simctl keychain <udid> add-root-cert "$HOME/Library/Application Support/Herd/config/valet/CA/LaravelValetCASelfSigned.pem"`.
- Restart the app to clear its earlier trust decision.
