/*
 * Saves the user's answers on an HTML artifact so the agent can read them back.
 *
 * On a page published with `share-html --writable`, answers autosave to the page's feedback file and the agent reads
 * them with `share-html feedback`. Anywhere else (a local file, an expired link), answers stay in this browser and a
 * Copy button hands the summary over instead.
 *
 * Two ways to use it, after `<script src="feedback.js"></script>`:
 *
 *   Feedback.auto()  Tracks every input, textarea, and select inside elements with `data-item="ID"` (title from
 *                    `data-title`), restores them on load, and writes the summary itself.
 *
 *   const saved = await Feedback.init()       For custom pages: returns the last saved state, or null.
 *   Feedback.save(state, markdown)            Call after every change with the full state and the summary to send.
 *
 * The status and the Copy fallback render into `[data-feedback]`, or a corner badge when the page has none.
 */
(() => {
  const STORE = 'feedback:' + location.pathname;
  const DEBOUNCE_MS = 800;
  let endpoint = null;
  let last = null;
  let timer;
  let ui;

  async function fetchJson(path) {
    try {
      const response = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  }

  function mount() {
    let host = document.querySelector('[data-feedback]');
    if (!host) {
      host = document.createElement('div');
      host.className = 'fixed bottom-4 end-4 z-20 rounded-lg border border-line bg-surface px-3 py-2 shadow-card';
      document.body.append(host);
    }
    host.innerHTML = `<span class="flex items-center gap-2">
      <span data-fb-status class="text-xs text-muted"></span>
      <button type="button" data-fb-copy class="btn btn-primary" hidden>Copy feedback for AI</button></span>`;
    ui = { status: host.querySelector('[data-fb-status]'), copy: host.querySelector('[data-fb-copy]') };
    ui.copy.addEventListener('click', copy);
  }

  function show(text, tone = 'muted', withCopy = false) {
    ui.status.textContent = text;
    ui.status.className = `text-xs text-${tone}`;
    ui.copy.hidden = !withCopy;
  }

  async function init() {
    mount();

    const config = location.protocol.startsWith('http') ? await fetchJson('./feedback-endpoint.json') : null;
    const expired = config && new Date(config.expires) <= new Date();
    if (config && !expired) endpoint = config.put;

    const remote = endpoint ? await fetchJson('./feedback.json') : null;
    const local = JSON.parse(localStorage.getItem(STORE) || 'null');
    last = [remote, local].filter(Boolean).sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''))[0] || null;

    if (endpoint) show(last ? 'Saved · say "see" in chat' : 'Answers save automatically');
    else if (expired) show('Saving expired · ask the AI to republish', 'warn', true);
    else show('', 'muted', true);

    return last?.state ?? null;
  }

  function save(state, markdown) {
    last = { state, markdown, savedAt: new Date().toISOString() };
    localStorage.setItem(STORE, JSON.stringify(last));
    if (!endpoint) return;

    show('Saving…');
    clearTimeout(timer);
    timer = setTimeout(push, DEBOUNCE_MS);
  }

  async function push() {
    try {
      const response = await fetch(endpoint, { method: 'PUT', body: JSON.stringify(last) });
      if (!response.ok) throw new Error(String(response.status));
      show('Saved · say "see" in chat', 'ok');
    } catch {
      show('Not saved', 'bad', true);
    }
  }

  async function copy() {
    const text = last?.markdown || 'No feedback yet.';
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = Object.assign(document.createElement('textarea'), { value: text });
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    ui.copy.textContent = 'Copied: paste it in chat';
    setTimeout(() => (ui.copy.textContent = 'Copy feedback for AI'), 2500);
  }

  async function auto() {
    const items = [...document.querySelectorAll('[data-item]')];
    const fields = (item) => [...item.querySelectorAll('input, textarea, select')];
    const nameOf = (field) => field.name || field.dataset.field || field.type;
    const titleOf = (item) => item.dataset.title || item.querySelector('h1, h2, h3, h4')?.textContent.trim() || '';

    const read = () =>
      Object.fromEntries(
        items.map((item) => [
          item.dataset.item,
          Object.fromEntries(
            fields(item)
              .filter((field) => field.type !== 'radio' || field.checked)
              .map((field) => [nameOf(field), field.type === 'checkbox' ? field.checked : field.value]),
          ),
        ]),
      );

    const restore = (state) =>
      items.forEach((item) =>
        fields(item).forEach((field) => {
          const value = state[item.dataset.item]?.[nameOf(field)];
          if (value === undefined) return;
          if (field.type === 'checkbox') field.checked = value;
          else if (field.type === 'radio') field.checked = field.value === value;
          else field.value = value;
        }),
      );

    const summarize = (state) => {
      const lines = items.flatMap((item) => {
        const answers = Object.entries(state[item.dataset.item] || {})
          .filter(([, value]) => value === true || (typeof value === 'string' && value.trim()))
          .map(([name, value]) => (value === true ? `✓ ${name}` : `${name}: ${value.trim()}`));
        return answers.length ? [`- ${item.dataset.item} ${titleOf(item)}: ${answers.join('; ')}`] : [];
      });
      return [`# Feedback: ${document.title}`, '', ...(lines.length ? lines : ['No answers yet.']), '', 'Items not listed have no answer.'].join('\n');
    };

    const saved = await init();
    if (saved) restore(saved);

    const onChange = () => {
      const state = read();
      save(state, summarize(state));
    };
    document.addEventListener('input', onChange);
    document.addEventListener('change', onChange);
  }

  window.Feedback = { init, save, auto };
})();
