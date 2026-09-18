// Talks to the Tweak app running on this computer. The app holds the models and
// the knowledge; this only carries messages and applies the change to your tab.
const PORTS = [4317, 4318, 4319];
let port = null;

async function findApp() {
  for (const p of port ? [port, ...PORTS] : PORTS) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/status`, { signal: AbortSignal.timeout(1200) });
      if (r.ok) { port = p; return p; }
    } catch {}
  }
  port = null;
  return null;
}

async function app(path, body) {
  const p = await findApp();
  if (!p) throw new Error('The Tweak app is not open on this computer. Start it, then try again.');
  const r = await fetch(`http://127.0.0.1:${p}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `The app said no (${r.status}).`);
  return d;
}

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd !== 'open-bar' || !tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'toggle' }).catch(() => {});
});
chrome.action?.onClicked?.addListener(tab => { if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'toggle' }).catch(() => {}); });

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    try {
      if (msg.type === 'plan') reply({ ok: true, data: await app('/api/bar/plan', msg.body) });
      else if (msg.type === 'keep') reply({ ok: true, data: await app('/api/bar/keep', msg.body) });
      else if (msg.type === 'status') reply({ ok: true, data: await app('/api/status') });
      else if (msg.type === 'css') {
        await chrome.scripting.insertCSS({ target: { tabId: sender.tab.id }, css: msg.css });
        reply({ ok: true });
      } else if (msg.type === 'uncss') {
        await chrome.scripting.removeCSS({ target: { tabId: sender.tab.id }, css: msg.css });
        reply({ ok: true });
      } else reply({ ok: false, error: 'unknown request' });
    } catch (e) { reply({ ok: false, error: e.message || String(e) }); }
  })();
  return true;
});
