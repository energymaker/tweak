import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listModels } from './lib/model.js';
import { runTweak, testCode, planTweak, keepPlanned, keepProject, HOME, PROFILE, COOKIES, RUNS, LOG } from './lib/pipeline.js';
import { detect } from './lib/targets/minecraft.js';
import { app, shell } from 'electron';
import { launchTestBrowser, goto, loadCookies, saveCookies, sweepProfiles } from './lib/browser.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TWEAKS = path.resolve(process.env.TWEAK_KEEP_DIR || path.join(HOME, 'tweaks'));
const PORT = Number(process.env.PORT || 4317);
const SETTINGS = path.join(HOME, 'settings.json');
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const runs = new Map(); // id -> { events, listeners, controller, result }
const RECOMMENDED = 'qwen2.5-coder:7b';
const pull = { busy: false, model: '', percent: 0, status: '', done: false, error: '' };

// Fetch a model through Ollama, reporting progress, so nobody needs a terminal.
async function startPull(model) {
  Object.assign(pull, { busy: true, model, percent: 0, status: 'starting', done: false, error: '' });
  const base = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  try {
    const r = await fetch(base + '/api/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: true }) });
    if (!r.ok) throw new Error('Ollama said no (' + r.status + ')');
    const reader = r.body.getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line);
          if (m.error) throw new Error(m.error);
          if (m.status) pull.status = m.status;
          if (m.total && m.completed) pull.percent = Math.round((m.completed / m.total) * 100);
        } catch (e) { if (e instanceof SyntaxError) continue; throw e; }
      }
    }
    Object.assign(pull, { busy: false, done: true, percent: 100, status: 'ready' });
  } catch (e) {
    Object.assign(pull, { busy: false, done: false, error: e.message || String(e) });
  }
}
let busy = false;
let testCtx = null;
const testBrowserIsOpen = () => !!(testCtx && testCtx.isOpen());

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};
const readBody = req => new Promise((ok, bad) => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); }); req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch (e) { bad(e); } }); });
const slug = s => String(s || 'tweak').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'tweak';

// the test browser ships inside the app now
async function chromiumInstalled() { return true; }

async function readSettings() {
  try { return JSON.parse(await fs.readFile(SETTINGS, 'utf8')); } catch { return {}; }
}
async function writeSettings(next) {
  const now = { ...(await readSettings()), ...next };
  await fs.mkdir(HOME, { recursive: true });
  await fs.writeFile(SETTINGS, JSON.stringify(now, null, 2));
  if ('hfToken' in next) process.env.TWEAK_HF_TOKEN = next.hfToken || '';
  if ('fallbackModel' in next) process.env.TWEAK_FALLBACK_MODEL = next.fallbackModel || '';
  if ('ollamaHost' in next) process.env.OLLAMA_HOST = next.ollamaHost || 'http://127.0.0.1:11434';
  return now;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    // the editor and its styles ship with the app, so it works with no internet
    const asset = url.pathname.match(/^\/vendor\/([\w.-]+\.(?:js|css))$/);
    if (req.method === 'GET' && asset) {
      const file = path.join(ROOT, 'public', 'vendor', asset[1]);
      if (!existsSync(file)) return send(res, 404, 'Not found', 'text/plain');
      res.writeHead(200, { 'Content-Type': asset[1].endsWith('.css') ? 'text/css' : 'application/javascript', 'Cache-Control': 'no-store' });
      return createReadStream(file).pipe(res);
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return createReadStream(path.join(ROOT, 'public', 'index.html')).pipe(res);
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const models = await listModels();
      return send(res, 200, { models, browserReady: await chromiumInstalled(), busy, testBrowserOpen: testBrowserIsOpen(), keepDir: TWEAKS, fallback: process.env.TWEAK_FALLBACK_MODEL || '', version: VERSION });
    }

    if (req.method === 'POST' && url.pathname === '/api/run') {
      if (busy) return send(res, 409, { error: 'A tweak is already being made. Wait for it to finish.' });
      if (testBrowserIsOpen()) return send(res, 409, { error: 'Close the test browser window first.' });
      const { request, url: target, model, headless = true, target: kind = 'web' } = await readBody(req);
      const fallback = process.env.TWEAK_FALLBACK_MODEL || '';
      if (!request || !target || !model) return send(res, 400, { error: 'Say what to change, where, and pick a model.' });
      if (!['web', 'minecraft'].includes(kind)) return send(res, 400, { error: 'Tweak does not know how to change that kind of thing.' });
      const controller = new AbortController();
      const run = { events: [], listeners: new Set(), controller, result: null };
      const tempId = 'pending-' + Date.now();
      runs.set(tempId, run);
      busy = true;
      const push = ev => { run.events.push(ev); for (const l of run.listeners) l.write(`data: ${JSON.stringify(ev)}\n\n`); };
      runTweak({ target: kind, request, url: target, model, fallback, headless, signal: controller.signal, onEvent: push })
        .then(r => { run.result = r; })
        .catch(e => push({ type: 'done', result: { status: 'fail', reason: 'Something broke inside the tool: ' + e.message, attempts: [] } }))
        .finally(() => { busy = false; });
      return send(res, 200, { runId: tempId });
    }

    const evMatch = url.pathname.match(/^\/api\/run\/([\w-]+)\/events$/);
    if (req.method === 'GET' && evMatch) {
      const run = runs.get(evMatch[1]);
      if (!run) return send(res, 404, { error: 'Run not found' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      for (const ev of run.events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      run.listeners.add(res);
      req.on('close', () => run.listeners.delete(res));
      return;
    }

    const stopMatch = url.pathname.match(/^\/api\/run\/([\w-]+)\/stop$/);
    if (req.method === 'POST' && stopMatch) {
      const run = runs.get(stopMatch[1]);
      if (run) run.controller.abort();
      return send(res, 200, { ok: true });
    }

    // Getting started: is a model on this computer, and can we fetch one?
    if (url.pathname.startsWith('/api/bar/')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    }

    if (req.method === 'POST' && url.pathname === '/api/bar/plan') {
      const { url: target, request, outline } = await readBody(req);
      if (!target || !request) return send(res, 400, { error: 'Say what to change.' });
      const models = await listModels();
      const model = process.env.TWEAK_BAR_MODEL || (models.ollama.models[0] ? 'ollama:' + models.ollama.models[0] : (models.api.models[0] ? 'api:' + models.api.models[0] : ''));
      if (!model) return send(res, 400, { error: 'No model is ready. Open Tweak and follow the two setup steps.' });
      try {
        const plan = await planTweak({ url: target, request, outline, model, fallback: process.env.TWEAK_FALLBACK_MODEL || '' });
        return send(res, 200, plan);
      } catch (e) { return send(res, 500, { error: e.message || String(e) }); }
    }

    if (req.method === 'POST' && url.pathname === '/api/bar/keep') {
      const { url: target, request, gen, checks } = await readBody(req);
      if (!gen) return send(res, 400, { error: 'Nothing to keep.' });
      try {
        const folder = await keepPlanned({ url: target, request, gen, checks });
        return send(res, 200, { folder });
      } catch (e) { return send(res, 500, { error: e.message || String(e) }); }
    }

    if (req.method === 'GET' && url.pathname === '/api/setup') {
      const models = await listModels();
      const names = models.ollama.models;
      return send(res, 200, {
        ollamaRunning: models.ollama.reachable,
        models: names,
        recommended: RECOMMENDED,
        hasRecommended: names.some(n => n.startsWith(RECOMMENDED.split(':')[0])),
        pulling: pull.busy ? pull : null,
        downloadPage: 'https://ollama.com/download'
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/open-link') {
      const { url: target } = await readBody(req);
      if (!/^https:\/\/(ollama\.com|huggingface\.co)\//.test(String(target))) return send(res, 400, { error: 'That link is not allowed.' });
      shell.openExternal(target);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/open-logs') {
      const dir = app.getPath('logs');
      await fs.mkdir(dir, { recursive: true });
      const error = await shell.openPath(dir);
      return send(res, error ? 500 : 200, error ? { error, dir } : { ok: true, dir });
    }

    if (req.method === 'POST' && url.pathname === '/api/pull') {
      if (pull.busy) return send(res, 200, pull);
      const { model } = await readBody(req);
      startPull(model || RECOMMENDED);
      return send(res, 200, pull);
    }

    if (req.method === 'GET' && url.pathname === '/api/pull') return send(res, 200, pull);

    if (req.method === 'GET' && url.pathname === '/api/settings') {
      const s = await readSettings();
      return send(res, 200, { hasToken: !!(process.env.TWEAK_HF_TOKEN || s.hfToken), fallbackModel: process.env.TWEAK_FALLBACK_MODEL || s.fallbackModel || '', ollamaHost: process.env.OLLAMA_HOST || s.ollamaHost || 'http://127.0.0.1:11434', home: HOME });
    }

    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const body = await readBody(req);
      const next = {};
      if (typeof body.hfToken === 'string') next.hfToken = body.hfToken.trim();
      if (typeof body.fallbackModel === 'string') next.fallbackModel = body.fallbackModel.trim();
      if (typeof body.ollamaHost === 'string') next.ollamaHost = body.ollamaHost.trim();
      await writeSettings(next);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/retest') {
      if (busy) return send(res, 409, { error: 'Wait for the current tweak to finish.' });
      const { runId, attempt, css, js } = await readBody(req);
      const run = runs.get(runId), r = run && run.result;
      const a = r && r.attempts.find(x => x.n === attempt);
      if (!a) return send(res, 400, { error: 'That tweak is no longer available.' });
      if (r.target === 'minecraft') return send(res, 400, { error: 'Testing hand edits only works for website tweaks so far.' });
      busy = true;
      try {
        const n = Math.max(...r.attempts.map(x => x.n)) + 1;
        const dir = path.join(RUNS, r.id, `edit-${n}`);
        const out = await testCode({ url: r.url, css, js, checks: a.plannedChecks || a.checks, dir });
        const edited = { n, name: a.name, summary: a.summary, css, js, checks: out.checks, verdict: out.verdict, problem: out.problem, extDir: dir, edited: true };
        r.attempts.push(edited);
        await fs.appendFile(LOG, JSON.stringify({ kind: 'edit', id: r.id, attempt: n, verdict: out.verdict, time: new Date().toISOString() }) + '\n');
        return send(res, 200, { attempt: n, verdict: out.verdict, problem: out.problem, checks: out.checks, shot: out.shot ? `${r.id}/edit-${n}/after.jpg` : null });
      } finally { busy = false; }
    }

    // What a mod project is, so the page can say it found the right one.
    if (req.method === 'GET' && url.pathname === '/api/project') {
      try { return send(res, 200, await detect(url.searchParams.get('dir'))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }

    if (req.method === 'POST' && url.pathname === '/api/keep') {
      const { runId, attempt, name } = await readBody(req);
      const run = runs.get(runId);
      const r = run && run.result;
      if (r && r.target === 'minecraft') {
        try { return send(res, 200, { folder: r.project, files: await keepProject(r, attempt) }); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
      const a = r && r.attempts.find(x => x.n === attempt);
      if (!a || !a.extDir) return send(res, 400, { error: 'That tweak is not available to keep.' });
      let folder = path.join(TWEAKS, slug(name || a.name));
      for (let i = 2; existsSync(folder); i++) folder = path.join(TWEAKS, slug(name || a.name) + '-' + i);
      await fs.mkdir(folder, { recursive: true });
      await fs.cp(a.extDir, folder, { recursive: true });
      await fs.writeFile(path.join(folder, 'tweak.json'), JSON.stringify({ request: r.request, url: r.url, model: r.model, verdict: a.verdict, checks: a.checks, kept: new Date().toISOString() }, null, 2));
      await fs.appendFile(LOG, JSON.stringify({ kind: 'keep', id: r.id, attempt, folder, time: new Date().toISOString() }) + '\n');
      return send(res, 200, { folder });
    }

    if (req.method === 'GET' && url.pathname === '/api/tweaks') {
      const list = [];
      if (existsSync(TWEAKS)) {
        for (const d of await fs.readdir(TWEAKS, { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          try {
            const meta = JSON.parse(await fs.readFile(path.join(TWEAKS, d.name, 'tweak.json'), 'utf8'));
            const man = JSON.parse(await fs.readFile(path.join(TWEAKS, d.name, 'manifest.json'), 'utf8'));
            list.push({ folder: path.join(TWEAKS, d.name), name: man.name, summary: man.description, ...meta });
          } catch {}
        }
      }
      list.sort((a, b) => String(b.kept).localeCompare(String(a.kept)));
      return send(res, 200, { tweaks: list });
    }

    if (req.method === 'POST' && url.pathname === '/api/browser') {
      if (busy) return send(res, 409, { error: 'Wait for the current tweak to finish.' });
      if (testBrowserIsOpen()) { testCtx.win.focus(); return send(res, 200, { ok: true, alreadyOpen: true }); }
      const { url: target } = await readBody(req);
      const ctx = await launchTestBrowser(null, false, true);
      testCtx = ctx;
      await loadCookies(ctx, COOKIES);
      // remember the cookie choice made in that window, so runs inherit it
      const keep = setInterval(() => saveCookies(ctx, COOKIES).catch(() => {}), 5000);
      ctx.onClosed(() => { clearInterval(keep); testCtx = null; });
      const page = ctx.pages()[0] || await ctx.newPage();
      if (target) goto(page, target).catch(() => {});
      return send(res, 200, { ok: true });
    }

    const shot = url.pathname.match(/^\/shots\/([\w-]+)\/((?:before|after-\d+)\.jpg|edit-\d+\/after\.jpg)$/);
    if (req.method === 'GET' && shot) {
      const file = path.join(RUNS, shot[1], shot[2]);
      if (!existsSync(file)) return send(res, 404, 'Not found', 'text/plain');
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      return createReadStream(file).pipe(res);
    }

    send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

export async function startServer(port = PORT) {
  await fs.mkdir(HOME, { recursive: true });
  await sweepProfiles();
  return new Promise((ok, bad) => {
    const onErr = e => { server.off('listening', onOk); bad(e); };
    const onOk = () => { server.off('error', onErr); ok(server.address().port); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, '127.0.0.1');
  });
}

// still runnable on its own for development
if (process.env.TWEAK_STANDALONE) startServer().then(p => console.log(`\n  Tweak is running. Open http://localhost:${p}\n`));
