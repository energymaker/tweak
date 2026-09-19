// Builds one HTML file for judging, by eye, whether each pass in a sampling
// bench really did what was asked. Screenshots and code are built in, so it
// opens from disk with no server. Nothing is pre-judged.
//
//   node review-passes.mjs <bench data folder> [out.html]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulate } from './analyse-sampling.mjs';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const readOr = (file, fallback) => fs.existsSync(file) ? fs.readFileSync(file) : fallback;
const img = file => { const b = readOr(file, null); return b ? `<img src="data:image/jpeg;base64,${b.toString('base64')}" alt="">` : '<p class="none">No screenshot was taken.</p>'; };

// The winning attempt for every N that passes, once per attempt.
export function passesToReview(runs, ns = [1, 3, 5]) {
  const out = [];
  for (const run of runs) {
    const byAttempt = new Map();
    for (const n of ns) {
      const o = simulate(run, n);
      if (o.status !== 'works') continue;
      const a = run.attempts.find(x => x.round === o.round && x.sample === o.sample);
      if (!byAttempt.has(a.n)) byAttempt.set(a.n, { run, attempt: a, ns: [] });
      byAttempt.get(a.n).ns.push(n);
    }
    out.push(...byAttempt.values());
  }
  return out;
}

function card({ run, attempt: a, ns }, dir, i) {
  const runDir = path.join(dir, 'runs', run.id);
  const ext = path.join(runDir, `attempt-${a.n}`);
  const css = String(readOr(path.join(ext, 'content.css'), ''));
  const js = String(readOr(path.join(ext, 'content.js'), ''));
  const key = `${run.id}#${a.n}`;
  const checks = a.checks.map(c => `<tr class="${c.after && !c.before ? 'proved' : ''}"><td>${esc(c.type)}</td><td><code>${esc(c.selector)}</code></td><td>${c.origin === 'tweak' ? 'Tweak (derived)' : 'the model'}</td><td>${c.before ? 'true' : 'false'}</td><td>${c.after ? 'true' : 'false'}</td></tr>`).join('');
  return `<section class="card" data-key="${esc(key)}">
  <h2>${i + 1}. ${esc(run.request)}</h2>
  <p class="meta">${esc(run.url)} · round ${a.round}, attempt ${a.sample}, temperature ${a.temperature} · the winner for ${ns.map(n => 'N=' + n).join(', ')}</p>
  <div class="shots"><figure><figcaption>Before</figcaption>${img(path.join(runDir, 'before.jpg'))}</figure><figure><figcaption>After</figcaption>${img(path.join(runDir, `after-${a.n}.jpg`))}</figure></div>
  <table><thead><tr><th>Check</th><th>Selector</th><th>Written by</th><th>Before</th><th>After</th></tr></thead><tbody>${checks}</tbody></table>
  <p class="hint">A pass needs every check true after the change and at least one false before it. Highlighted rows went from false to true.</p>
  ${css || js ? `<details><summary>The code</summary>${css ? `<pre>${esc(css)}</pre>` : ''}${js ? `<pre>${esc(js)}</pre>` : ''}</details>` : ''}
  <fieldset><legend>Did it really do what was asked?</legend>
    ${['genuinely done', 'not done', 'unsure'].map(v => `<label><input type="radio" name="v${i}" value="${v}"> ${v}</label>`).join('')}
  </fieldset>
  <label class="notes">Notes<textarea rows="3"></textarea></label>
</section>`;
}

export function page(items, dir, source) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>False pass review</title>
<style>
:root{--bg:#fafafa;--fg:#161616;--dim:#666;--card:#fff;--line:#ddd;--mark:#e3f2e8}
@media (prefers-color-scheme:dark){:root{--bg:#111112;--fg:#eee;--dim:#999;--card:#1b1b1d;--line:#333;--mark:#1f3a2a}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:1200px;margin:0 auto;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px;margin:0 0 20px}
h1{font-size:22px}h2{font-size:17px;margin:0 0 4px}.meta,.hint,.none{color:var(--dim);font-size:13px;margin:4px 0}
.shots{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0}
@media (max-width:700px){.shots{grid-template-columns:1fr}}
figure{margin:0}figcaption{font-size:13px;color:var(--dim)}img{width:100%;border:1px solid var(--line);border-radius:4px}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line)}
tr.proved{background:var(--mark)}code,pre{font:12px/1.4 ui-monospace,monospace}pre{white-space:pre-wrap;overflow-x:auto;background:var(--bg);padding:8px;border-radius:4px}
fieldset{border:1px solid var(--line);border-radius:6px;margin:12px 0}fieldset label{margin-right:18px}
.notes{display:block}textarea{display:block;width:100%;box-sizing:border-box;margin-top:4px;font:inherit;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:4px}
.bar{position:sticky;bottom:0;background:var(--bg);border-top:1px solid var(--line);padding:12px 16px;display:flex;gap:16px;align-items:center}
button{font:inherit;padding:8px 16px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
</style></head><body><main>
<h1>False pass review</h1>
<p class="meta">${items.length} winning attempts from ${esc(source)}. Nothing is filled in. Judge each from the pictures and the code.</p>
${items.map((it, i) => card(it, dir, i)).join('\n')}
</main>
<div class="bar"><button id="save" type="button">Save my answers</button><span class="meta" id="msg"></span></div>
<script>
const cards = [...document.querySelectorAll('.card')];
const KEY = 'false-pass-review-2026-09-19';
const answers = () => cards.map(c => ({
  key: c.dataset.key, request: c.querySelector('h2').textContent.replace(/^\\d+\\. /, ''),
  verdict: (c.querySelector('input:checked') || {}).value || null,
  notes: c.querySelector('textarea').value
}));
// A draft is kept in this browser so a closed tab loses nothing; the saved file is the record.
try { const d = JSON.parse(localStorage.getItem(KEY) || '[]'); cards.forEach(c => { const a = d.find(x => x.key === c.dataset.key); if (!a) return; if (a.verdict) c.querySelector('input[value="' + a.verdict + '"]').checked = true; c.querySelector('textarea').value = a.notes || ''; }); } catch {}
document.addEventListener('input', () => { try { localStorage.setItem(KEY, JSON.stringify(answers())); } catch {} });
document.getElementById('save').onclick = () => {
  const list = answers();
  const blob = new Blob([JSON.stringify({ saved: new Date().toISOString(), source: ${JSON.stringify(source)}, answers: list }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'false-pass-review-2026-09-19.json'; a.click();
  const left = list.filter(x => !x.verdict).length;
  document.getElementById('msg').textContent = 'Saved to your Downloads folder.' + (left ? ' ' + left + ' still have no answer.' : '');
};
</script></body></html>`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error('Give the bench data folder: node review-passes.mjs C:\\Users\\you\\Tweak-bench-sampling'); process.exit(1); }
  const source = path.join(dir, 'runs.jsonl');
  const runs = fs.readFileSync(source, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)).filter(r => r.kind === 'run' && Array.isArray(r.attempts) && r.attempts.every(a => a.sample));
  const items = passesToReview(runs);
  const out = process.argv[3] || path.join(dir, 'false-pass-review.html');
  fs.writeFileSync(out, page(items, dir, source));
  console.log(`${items.length} winning attempts written to ${out}`);
}
