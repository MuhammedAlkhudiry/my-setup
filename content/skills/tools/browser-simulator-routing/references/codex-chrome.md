# Codex Chrome

Outside the ChatGPT desktop app, `cua_repl` browser calls fail with "The browser access host is unavailable". Drive the owner's Chrome
through the `node_repl` `js` tool instead; keep `agent`, `browser`, and tabs across calls:

```js
const { setupBrowserRuntime } = await import("<home>/.codex/plugins/cache/openai-bundled/chrome/latest/scripts/browser-client.mjs"); // absolute path; no `process`
globalThis.agent = await setupBrowserRuntime();
globalThis.browser = await agent.browsers.getForUrl(url);
nodeRepl.write(await browser.documentation()); // the full API
const tab = await browser.tabs.new();
await tab.goto(url);
```

`Cannot read properties of undefined (reading 'timeoutMs')` on navigation means the ChatGPT app's bundled Chrome plugin is older than the
ChatGPT Chrome extension: run `brew upgrade --cask chatgpt` and open the app once.

`node_repl` hanging at startup, while a copy of it run elsewhere works, means a stuck Gatekeeper evaluation holds every binary in the
ChatGPT bundle, the app included; `doctor` reports it as "ChatGPT bundle launch" with the fix. Never reinstall or reset the app for it.
