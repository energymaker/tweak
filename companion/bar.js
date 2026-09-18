// The bar you see on the page. It reads the page, asks the app for a change,
// applies it here, then checks it here, so the test is your own tab.
(() => {
  if (window.__tweakBar) return;
  window.__tweakBar = true;

  const HOST_ID = 'tweak-bar-host';
  let host, root, box, input, line, keepRow, state = null;

  const send = msg => new Promise(res => chrome.runtime.sendMessage(msg, r => res(r || { ok: false, error: 'The extension could not reach the app.' })));

  function build() {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;left:0;right:0;bottom:24px;z-index:2147483647;display:flex;justify-content:center;pointer-events:none';
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        *{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
        .box{pointer-events:auto;width:min(560px,calc(100vw - 32px));background:#1C1C1C;color:#D6D6D6;border:1px solid #333;border-radius:14px;box-shadow:0 24px 60px rgba(0,0,0,.45);overflow:hidden}
        .row{display:flex;align-items:center;gap:10px;padding:12px 14px}
        svg{width:16px;height:16px;flex:none}
        input{flex:1;min-width:0;background:none;border:0;outline:none;color:#D6D6D6;font-size:15px}
        input::placeholder{color:#6E6E6E}
        .line{display:flex;align-items:center;gap:10px;padding:9px 14px;border-top:1px solid #2A2A2A;font-size:12.5px;color:#8C8C8C}
        .line.good{color:#A9C4B6;background:#131B17}
        .line.bad{color:#C39B98;background:#1B1313}
        .grow{flex:1}
        button{font:inherit;font-size:12.5px;border-radius:7px;padding:5px 12px;cursor:pointer;border:1px solid #333;background:none;color:#B8B8B8}
        button:hover{color:#EDEDED}
        button.keep{background:#7FB89C;border-color:#7FB89C;color:#12201A;font-weight:500}
        kbd{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#6E6E6E}
        .dots{display:inline-flex;gap:3px}
        .dots i{width:4px;height:4px;border-radius:50%;background:#8C8C8C;animation:p 1s infinite}
        .dots i:nth-child(2){animation-delay:.15s}.dots i:nth-child(3){animation-delay:.3s}
        @keyframes p{0%,100%{opacity:1}50%{opacity:.25}}
      </style>
      <div class="box">
        <div class="row">
          <svg viewBox="-50 -50 100 100" aria-hidden="true"><circle cx="0" cy="0" r="7" fill="#D6D6D6"/><circle cx="0" cy="-34" r="6" fill="#D6D6D6"/><circle cx="29.4" cy="-17" r="6" fill="#D6D6D6"/><circle cx="29.4" cy="17" r="6" fill="#D6D6D6"/><circle cx="0" cy="34" r="6" fill="#D6D6D6"/><circle cx="-29.4" cy="17" r="6" fill="#D6D6D6"/><circle cx="-29.4" cy="-17" r="6" fill="#D6D6D6"/></svg>
          <input id="i" type="text" placeholder="What do you want to change on this page?" autocomplete="off" spellcheck="false">
          <kbd>esc</kbd>
        </div>
        <div class="line" id="line" hidden></div>
      </div>`;
    box = root.querySelector('.box');
    input = root.getElementById('i');
    line = root.getElementById('line');
    document.documentElement.append(host);

    input.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); hide(); }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); }
    });
    host.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && state && state.verdict === 'works') { e.preventDefault(); keep(); }
    });
  }

  function show() {
    if (!host) build();
    host.style.display = 'flex';
    input.focus(); input.select();
  }
  function hide() { if (host) host.style.display = 'none'; }
  function toggle() { if (!host || host.style.display === 'none') show(); else hide(); }

  function say(html, kind) {
    line.hidden = false;
    line.className = 'line' + (kind ? ' ' + kind : '');
    line.innerHTML = html;
  }

  /* what is on this page, for the model to pick selectors from */
  function outline(request) {
    const stop = new Set('the and for with that this from into onto make show hide add remove page button when what your you all any can have more less like just every each only them they then than its also want need please'.split(' '));
    const words = String(request).toLowerCase().match(/[a-z0-9]{3,}/g) || [];
    const keys = [...new Set(words.filter(w => !stop.has(w)).flatMap(w => (w.endsWith('s') && w.length > 4 ? [w, w.slice(0, -1)] : [w])))];
    const hit = s => keys.some(k => s.includes(k));
    const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META', 'TEMPLATE']);
    const groups = new Map();
    [...document.body.querySelectorAll('*')].slice(0, 20000).forEach((el, order) => {
      if (skip.has(el.tagName) || host.contains(el)) return;
      let sig = el.tagName.toLowerCase();
      if (el.id && el.id.length < 40) sig += '#' + el.id;
      const cls = [...el.classList].filter(c => c.length < 40).slice(0, 3);
      if (cls.length) sig += '.' + cls.join('.');
      let score = 0;
      for (const a of el.attributes) {
        if (['id', 'class', 'style'].includes(a.name)) continue;
        const v = String(a.value || '').toLowerCase();
        if (['aria-label', 'title', 'role', 'data-testid'].includes(a.name) && v && v.length < 50) sig += `[${a.name}="${a.value}"]`;
        else if (hit(a.name.toLowerCase())) { sig += `[${a.name}]`; score += 3; }
        else if (v && v.length < 50 && hit(v)) { sig += `[${a.name}="${a.value}"]`; score += 2; }
      }
      if (hit(sig.toLowerCase())) score += 3;
      const name = (el.id + ' ' + el.className).toLowerCase();
      if (/(^|[-_ ])(content|article|main|body|feed|results|list|container|post|entry)([-_ ]|$)/.test(name)) score += 4;
      if (['MAIN', 'ARTICLE', 'SECTION', 'NAV', 'ASIDE', 'HEADER', 'FOOTER', 'UL', 'OL'].includes(el.tagName)) score += 2;
      if (['A', 'SPAN', 'LI'].includes(el.tagName)) score -= 2;
      if (el.getBoundingClientRect().height > 200) score += 2;
      let g = groups.get(sig);
      if (!g) { g = { sig, count: 0, text: '', score: 0, order, custom: el.tagName.includes('-') || !!el.id }; groups.set(sig, g); }
      g.count++;
      const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join(' ').replace(/\s+/g, ' ').trim();
      if (own && !g.text) g.text = own.slice(0, 60);
      if (own && hit(own.toLowerCase())) score += 2;
      g.score = Math.max(g.score, score);
    });
    const all = [...groups.values()];
    const rel = all.filter(g => g.score > 0).sort((a, b) => b.score - a.score || a.order - b.order).slice(0, 30);
    const land = all.filter(g => g.custom && g.score <= 0).sort((a, b) => a.order - b.order).slice(0, 20);
    const line = g => `${g.sig}${g.count > 1 ? ` (x${g.count})` : ''}${g.text ? ` "${g.text}"` : ''}`;
    return `Title: ${document.title}\nAddress: ${location.href}\n\nElements matching the request:\n${rel.map(line).join('\n')}\n\nOther landmark elements:\n${land.map(line).join('\n')}`.slice(0, 5000);
  }

  function runChecks(checks) {
    const visible = el => { const s = getComputedStyle(el), r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity || '1') > 0 && (r.width > 0 || r.height > 0); };
    return checks.map(c => {
      try {
        const els = [...document.querySelectorAll(c.selector)].filter(el => !host.contains(el));
        const vis = els.filter(visible).length;
        switch (c.type) {
          case 'hidden': return { ...c, pass: vis === 0 };
          case 'visible': return { ...c, pass: vis > 0 };
          case 'exists': return { ...c, pass: els.length > 0 };
          case 'absent': return { ...c, pass: els.length === 0 };
          case 'textContains': return { ...c, pass: !!els[0] && els[0].textContent.toLowerCase().includes(String(c.text || '').toLowerCase()) };
          case 'style': return { ...c, pass: !!els[0] && getComputedStyle(els[0]).getPropertyValue(c.property).trim() === String(c.value || '').trim() };
          default: return { ...c, pass: false };
        }
      } catch { return { ...c, pass: false }; }
    });
  }

  async function go() {
    const request = input.value.trim();
    if (!request) return;
    if (state && state.css) { await send({ type: 'uncss', css: state.css }); state = null; }
    say('<span class="dots"><i></i><i></i><i></i></span> reading the page and writing the change');
    const r = await send({ type: 'plan', body: { url: location.href, request, outline: outline(request) } });
    if (!r.ok) return say(esc(r.error), 'bad');
    const plan = r.data;

    if (plan.js && plan.js.trim()) {
      return say(`This one needs code that runs on the page, which the bar cannot do yet. Ask for it in the Tweak app instead. <span class="grow"></span>`, 'bad');
    }
    if (!plan.css || !plan.css.trim()) return say('The model did not produce a change for that.', 'bad');

    const before = runChecks(plan.checks || []);
    const applied = await send({ type: 'css', css: plan.css });
    if (!applied.ok) return say(esc(applied.error), 'bad');
    await new Promise(r => setTimeout(r, 250));
    const after = runChecks(plan.checks || []);

    const allPass = after.length && after.every(c => c.pass);
    const proved = after.some((c, i) => c.pass && !before[i].pass);
    state = { request, plan, css: plan.css, checks: after.map((c, i) => ({ ...c, before: before[i].pass, after: c.pass })), verdict: allPass && proved ? 'works' : allPass ? 'unproven' : 'fail' };

    if (state.verdict === 'works') {
      const what = after.map(c => c.type === 'style' ? `${c.property} is ${c.value}` : c.type === 'hidden' ? 'it is hidden now' : `${c.selector} is there`).join(', ');
      say(`done, ${esc(what)} <span class="grow"></span><button class="keep" id="k">Keep</button><button id="u">Undo</button><kbd>ctrl enter</kbd>`, 'good');
    } else if (state.verdict === 'unproven') {
      say(`changed, but the check was already true before. Have a look. <span class="grow"></span><button class="keep" id="k">Keep anyway</button><button id="u">Undo</button>`);
    } else {
      await send({ type: 'uncss', css: plan.css });
      state = null;
      return say('that did not change what you asked for. Try saying it differently.', 'bad');
    }
    const k = root.getElementById('k'), u = root.getElementById('u');
    if (k) k.onclick = keep;
    if (u) u.onclick = undo;
  }

  async function undo() {
    if (state && state.css) await send({ type: 'uncss', css: state.css });
    state = null;
    say('put back the way it was');
    setTimeout(hide, 900);
  }

  async function keep() {
    if (!state) return;
    say('<span class="dots"><i></i><i></i><i></i></span> saving');
    const r = await send({ type: 'keep', body: { url: location.href, request: state.request, gen: state.plan, checks: state.checks } });
    if (!r.ok) return say(esc(r.error), 'bad');
    say(`kept. it is in your Tweak folder, ready to add to Chrome <span class="grow"></span><button id="c">Close</button>`, 'good');
    const c = root.getElementById('c'); if (c) c.onclick = hide;
  }

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  chrome.runtime.onMessage.addListener(msg => { if (msg && msg.type === 'toggle') toggle(); });

  // The page listens for the shortcut itself, so it still works when Chrome
  // gives the command to another extension or the worker is asleep.
  window.addEventListener('keydown', e => {
    if (e.altKey && e.shiftKey && (e.key === 'T' || e.key === 't' || e.code === 'KeyT')) {
      e.preventDefault(); e.stopPropagation();
      toggle();
    }
  }, true);
})();
