/*
 * Saves the user's answers on an HTML artifact so the agent can read them back.
 *
 * On a page published with `share-html --writable`, answers autosave to the page's feedback file and the agent reads
 * them with `share-html feedback --json`. Give `[data-feedback]` a `data-notify="WEBHOOK_URL"` attribute, or call
 * `Feedback.notify(url)`, to show a Send to agent button. It POSTs the current summary as `{note}` to a T3 webhook
 * schedule. Without a webhook or a writable page, the button copies the summary instead.
 *
 * Two ways to use it, after `<script src="feedback.js"></script>`:
 *
 *   Feedback.auto()  Tracks every input, textarea, and select inside elements with `data-item="ID"` (title from
 *                    `data-title`), restores them on load, and writes the summary itself. Radio buttons form one group
 *                    per item, even when items reuse a name such as `choice`; to make several items share one group,
 *                    give their radios the same `form="ID"` attribute and put that empty `<form id="ID" hidden>` before
 *                    them, because the browser groups radios as it parses the page. Clicking the picked radio again
 *                    clears it.
 *
 *   const saved = await Feedback.init()       For custom pages: returns the last saved state, or null.
 *   Feedback.save(state, markdown)            Call after every change with the full state and the summary to send.
 *
 * The status and button render into `[data-feedback]`, or a corner badge when the page has none. The button inherits
 * the page's text color; `data-fb-state` is `due`, `sending`, `sent`, or `copy` for page-specific styling.
 */
(() => {
  const STORE = 'feedback:' + location.pathname;
  const SENT = STORE + ':sent';
  const DEBOUNCE_MS = 800;
  let endpoint = null;
  let notifyUrl = null;
  let last = null;
  let timer;
  let ui;
  let sending = false;
  let writes = Promise.resolve();

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
    notifyUrl ||= document.querySelector('[data-notify]')?.dataset.notify || null;
    host.innerHTML = `<span data-fb-status role="status"></span>
      <button type="button" data-fb-send style="font:inherit;color:inherit;background:transparent;border:1px solid currentColor;border-radius:.5em;padding:.45em .8em;min-height:36px;cursor:pointer"></button>`;
    ui = { status: host.querySelector('[data-fb-status]'), send: host.querySelector('[data-fb-send]') };
    ui.send.addEventListener('click', send);
    paintButton();
  }

  function show(text, tone = 'muted') {
    ui.status.textContent = text;
    ui.status.className = `text-xs text-${tone}`;
  }

  function paintButton() {
    if (!ui) return;
    if (sending) return;
    const writable = Boolean(endpoint && notifyUrl);
    const sent = last && localStorage.getItem(SENT) === last.savedAt;
    const state = writable ? (sent ? 'sent' : 'due') : 'copy';
    ui.send.dataset.fbState = state;
    ui.send.textContent = writable ? (sent ? 'Sent ✓' : 'Send to agent') : 'Copy answers';
    ui.send.disabled = !last;
    ui.send.style.opacity = sent || !last ? '.65' : '1';
  }

  async function init() {
    mount();

    const config = location.protocol.startsWith('http') ? await fetchJson('./feedback-endpoint.json') : null;
    const expired = config && new Date(config.expires) <= new Date();
    if (config && !expired) endpoint = config.put;

    const remote = endpoint ? await fetchJson('./feedback.json') : null;
    const local = JSON.parse(localStorage.getItem(STORE) || 'null');
    last = [remote, local].filter(Boolean).sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''))[0] || null;

    if (endpoint) show(last ? 'Saved' : 'Answers save automatically');
    else if (expired) show('Saving expired · ask the AI to republish', 'warn');
    else show('');
    paintButton();

    return last?.state ?? null;
  }

  function save(state, markdown) {
    last = { state, markdown, savedAt: new Date().toISOString() };
    localStorage.setItem(STORE, JSON.stringify(last));
    paintButton();
    if (!endpoint) return;

    show('Saving…');
    clearTimeout(timer);
    timer = setTimeout(() => push(), DEBOUNCE_MS);
  }

  function push(snapshot = last) {
    const write = async () => {
      try {
        const response = await fetch(endpoint, { method: 'PUT', body: JSON.stringify(snapshot) });
        if (!response.ok) throw new Error(String(response.status));
        show('Saved', 'ok');
        return true;
      } catch {
        show('Not saved', 'bad');
        return false;
      }
    };
    writes = writes.then(write, write);
    return writes;
  }

  function notify(url) {
    notifyUrl = url || null;
    paintButton();
  }

  async function send() {
    if (!last || sending) return;
    if (!endpoint || !notifyUrl) return copy();

    clearTimeout(timer);
    sending = true;
    ui.send.disabled = true;
    ui.send.dataset.fbState = 'sending';
    ui.send.textContent = 'Sending…';
    const current = last;
    if (!(await push(current))) {
      sending = false;
      paintButton();
      return;
    }

    try {
      await fetch(notifyUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ note: current.markdown }),
      });
      localStorage.setItem(SENT, current.savedAt);
      show('Sent', 'ok');
    } catch {
      show('Could not send', 'bad');
    }
    sending = false;
    paintButton();
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
    ui.send.textContent = 'Copied: paste in chat';
    setTimeout(paintButton, 2500);
  }

  // Browsers group same-named radios across the whole page, so one pick would clear every other item's pick.
  function scopeRadios(items) {
    items.forEach((item) => {
      const radios = [...item.querySelectorAll('input[type="radio"]:not([form])')];
      if (!radios.length) return;
      const form = Object.assign(document.createElement('form'), { id: `feedback-${item.dataset.item}`, hidden: true });
      document.body.append(form);
      radios.forEach((radio) => radio.setAttribute('form', form.id));
    });
  }

  // A browser radio cannot be cleared once picked, so clicking the picked radio again, or pressing Space on it, clears it.
  function allowUnpick() {
    let picked = new Set();
    const remember = () => (picked = new Set(document.querySelectorAll('input[type="radio"]:checked')));

    document.addEventListener('click', (event) => {
      if (picked.has(event.target)) {
        event.target.checked = false;
        event.target.dispatchEvent(new Event('change', { bubbles: true }));
      }
      remember();
    });
    // Browsers send no click when Space lands on a radio that is already picked.
    document.addEventListener('keyup', (event) => {
      if (event.key === ' ' && picked.has(event.target)) event.target.click();
    });
    remember();
  }

  async function auto() {
    const items = [...document.querySelectorAll('[data-item]')];
    scopeRadios(items);
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
    allowUnpick();

    const onChange = () => {
      const state = read();
      save(state, summarize(state));
    };
    document.addEventListener('input', onChange);
    document.addEventListener('change', onChange);
  }

  window.Feedback = { init, save, auto, notify };
})();
