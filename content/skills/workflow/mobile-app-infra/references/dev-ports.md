# Development Ports

Treat these as independent contracts:

- The Metro process port.
- The Metro port compiled or configured into the native client.
- The port used by reload or automation tooling.
- The backend API host and port reachable from the device.
- Any web, proxy, or tunnel port.

## Workflow

1. Identify whether bundle loading, reload, API access, deep linking, or web access is failing.
2. Inventory every declared port in tracked source, native configuration, scripts, and automation.
3. Confirm the running process separately from the native-client and automation configuration.
4. Keep API reachability separate from Metro reachability; the correct hosts and ports may differ.
5. Make durable changes in tracked configuration rather than ignored generated native files.
6. Update every affected surface together. Rebuild installed clients when compiled native configuration changes.
7. Verify machine-readable configuration, the running process, client loading, automation reload, and API access that changed.

## Local HTTPS

A new simulator or emulator trusts no local certificate, so HTTPS requests to local domains fail during the handshake and the app looks broken.
Install the local development certificate authority before signing in:

- Use the project's own task when it has one.
- For an iOS simulator on a host with Herd or Valet, run
  `xcrun simctl keychain <udid> add-root-cert "$HOME/Library/Application Support/Herd/config/valet/CA/LaravelValetCASelfSigned.pem"`.
- Restart the app afterwards, because a running app keeps its earlier trust decision.
