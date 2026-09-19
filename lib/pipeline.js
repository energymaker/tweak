import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import { ask } from './model.js';
import { VIEWPORT, launchTestBrowser, goto, outline, runChecks, tweakError, consentWall, freshProfile, dropProfile, loadCookies, saveCookies, isResponsive } from './browser.js';

// Kept outside the version folder, so cookie choices, kept tweaks and records
// survive when you move to a new version.
export const HOME = path.resolve(process.env.TWEAK_HOME || path.join(os.homedir(), 'Tweak'));
export const setHome = () => HOME;
export const PROFILE = path.join(HOME, 'browser-profile');
export const COOKIES = path.join(HOME, 'cookies.json');
export const KNOWN = path.join(HOME, 'what-worked.json');

// What worked before on this site. Every kept or proved tweak teaches the next
// one, so the model stops guessing selectors it has already found once.
async function readKnown() {
  try { return JSON.parse(await fs.readFile(KNOWN, 'utf8')); } catch { return {}; }
}
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }

export async function rememberWorking({ url, request, gen, checks }) {
  const host = hostOf(url);
  if (!host) return;
  const selectors = [...new Set([
    ...(checks || []).map(c => c.selector),
    ...selectorsUsed({ css: gen.css, js: gen.js, checks: checks || [] })
  ])].filter(Boolean).slice(0, 6);
  if (!selectors.length) return;
  const all = await readKnown();
  const list = all[host] || [];
  if (list.some(e => e.request === request)) return;
  list.unshift({ request: String(request).slice(0, 120), selectors, when: new Date().toISOString().slice(0, 10) });
  all[host] = list.slice(0, 12);
  await fs.mkdir(HOME, { recursive: true });
  await fs.writeFile(KNOWN, JSON.stringify(all, null, 2)).catch(() => {});
}

async function knownFor(url) {
  const host = hostOf(url);
  const all = await readKnown();
  const list = (all[host] || []).slice(0, 6);
  if (!list.length) return '';
  return `\nThings that worked on ${host} before, use these selectors when they fit:\n` +
    list.map(e => `- "${e.request}" used ${e.selectors.join(', ')}`).join('\n') + '\n';
}
export const RUNS = path.join(HOME, 'runs');
export const LOG = path.join(HOME, 'runs.jsonl');

const PHASE_TIMEOUT = Number(process.env.TWEAK_PHASE_TIMEOUT || 120) * 1000;

// The browser can get stuck (a profile another window is using, a page that
// never settles). Every browser phase gets its own limit so a run cannot freeze.
function withLimit(promise, what, ms = PHASE_TIMEOUT) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, bad) => { timer = setTimeout(() => bad(Object.assign(new Error(what + ' took longer than ' + Math.round(ms / 1000) + 's'), { code: 'phase_timeout' })), ms); })
  ]).finally(() => clearTimeout(timer));
}

// Every run opens a throwaway profile, so a browser left behind by a killed run
// can never block the next one. The consent choice travels in a cookie file.
async function openBrowser(inject, headless, which = 'tests') {
  const ctx = await withLimit(launchTestBrowser(inject, headless, false, which), 'Opening the test browser', 60000);
  await loadCookies(ctx, COOKIES);
  return ctx;
}
async function shutBrowser(ctx) {
  if (!ctx) return;
  await withLimit(ctx.close(), 'Closing the browser', 20000).catch(() => {});
}

const CHECK_TYPES = ['hidden', 'visible', 'exists', 'absent', 'textContains', 'style'];
const S = { type: 'string' };
const SCHEMA = {
  type: 'object',
  properties: {
    name: S, summary: S, css: S, js: S,
    checks: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', properties: { type: { type: 'string', enum: CHECK_TYPES }, selector: S, text: S, property: S, value: S }, required: ['type', 'selector'] } }
  },
  required: ['name', 'summary', 'css', 'js', 'checks']
};

// Version 0.1 only writes tweaks that change the page you are on. No network,
// no access to other sites, no cookies. That keeps every tweak easy to trust.
// A tweak that is asked to work something out must work it out, not type a
// number in. This catches the model taking the easy way past its own check.
const COUNTING = /\b(count|counts|number of|how many|total|reading time|minutes|seconds|words|length|sum|average|price|score|percent)\b/i;
const COMPUTES = /(\.length|\.split\(|Math\.|reduce\(|querySelectorAll|toFixed|parseInt|parseFloat|Number\(|\/\s*\d)/;
function looksHardcoded(request, gen) {
  if (!COUNTING.test(request)) return '';
  const js = gen.js || '';
  const texts = [...js.matchAll(/(?:textContent|innerText|innerHTML)\s*=\s*(['"`])((?:(?!\1).)*)\1/g)].map(m => m[2]);
  const withNumber = texts.filter(t => /\d/.test(t));
  if (!withNumber.length) return '';
  if (COMPUTES.test(js)) return '';
  return `the text "${withNumber[0].slice(0, 60)}" has a fixed number in it, but nothing in the code works that number out`;
}

const BLOCKED = [
  [/\bfetch\s*\(/, 'makes network requests (fetch)'],
  [/XMLHttpRequest/, 'makes network requests (XMLHttpRequest)'],
  [/WebSocket|EventSource|sendBeacon/, 'opens a network connection'],
  [/\beval\s*\(/, 'uses eval'],
  [/new\s+Function\s*\(/, 'builds code from text (new Function)'],
  [/document\.cookie/, 'reads cookies'],
  [/chrome\.(cookies|history|tabs|downloads|webRequest)/, 'asks for browser permissions'],
  [/<script[\s>]|\.src\s*=\s*['"`]https?:/i, 'loads outside scripts or files'],
  [/@import|url\(\s*['"]?https?:/i, 'loads outside files in CSS']
];

function matchesFor(url) {
  const u = new URL(url);
  const parts = u.hostname.split('.');
  const base = parts.length > 2 ? parts.slice(-2).join('.') : u.hostname;
  return [...new Set([`*://${u.hostname}/*`, `*://*.${base}/*`, `*://${base}/*`])];
}

function wrapJs(js) {
  return `// Written by Tweak. Errors are reported back to the tester.
(() => {
  const report = (e) => document.documentElement.setAttribute('data-tweak-error', String((e && e.message) || e).slice(0, 300));
  window.addEventListener('error', (ev) => report(ev.error || ev.message));
  // A tweak that reacts to page changes can trigger its own changes forever and
  // freeze the page. Every watcher is capped and switched off if it runs away.
  const RealObserver = window.MutationObserver;
  window.MutationObserver = function (fn) {
    let runs = 0, burst = 0, since = Date.now();
    const o = new RealObserver((...args) => {
      const now = Date.now();
      if (now - since > 1000) { burst = 0; since = now; }
      if (++runs > 60 || ++burst > 12) { o.disconnect(); report('the tweak kept reacting to its own changes, so it was stopped'); return; }
      return fn(...args);
    });
    return o;
  };
  try {
${js.split('\n').map(l => '    ' + l).join('\n')}
  } catch (e) { report(e); }
})();
`;
}

async function writeExtension(dir, url, gen) {
  await fs.mkdir(dir, { recursive: true });
  const cs = { matches: matchesFor(url), run_at: 'document_idle' };
  if (gen.js.trim()) { cs.js = ['content.js']; await fs.writeFile(path.join(dir, 'content.js'), wrapJs(gen.js)); }
  if (gen.css.trim()) { cs.css = ['content.css']; await fs.writeFile(path.join(dir, 'content.css'), gen.css); }
  const manifest = { manifest_version: 3, name: String(gen.name || 'Tweak').slice(0, 45), version: '0.1.0', description: String(gen.summary || '').slice(0, 130), content_scripts: [cs] };
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

function buildPrompt({ url, request, pageOutline, feedback, known }) {
  return `You write small Chrome extensions (Manifest V3 content scripts) that change how a website looks or behaves for one person.

The person is on: ${url}
They want: """${request}"""

Summary of what is on the page right now, most relevant first. Prefer selectors that appear here:
${pageOutline}
${known || ''}
${feedback ? `\nYour previous attempt did not work. What the tester found:\n${feedback}\nFix the problem. Use different selectors if the old ones did not match.\n` : ''}
Rules:
- Put purely visual changes (hiding, sizes, colours) in "css". Put behaviour (buttons, copying, counting, reacting to changes) in "js". Either can be an empty string.
- Sites like YouTube and GitHub load content late. Only watch the page for changes if what you need appears late, and if you do, the FIRST line inside your function must return when your own element already exists, or you will trigger yourself forever:
    const add = () => {
      if (document.getElementById('tweak-thing')) return;   // always first
      const spot = document.querySelector('...');
      if (!spot) return;
      const el = document.createElement('button');
      el.id = 'tweak-thing';
      spot.after(el);
    };
    add();
    new MutationObserver(add).observe(document.body, { childList: true, subtree: true });
- Put anything you add right next to the thing the request mentions, using that element's .after() or .append(). Do not attach it to a large container such as a page header or the body, or it will appear in a strange place. Never use insertBefore with a node that is not a child of the element you call it on.
- Any element you add needs an id or class starting with "tweak-".
- Not allowed: fetch, XMLHttpRequest, WebSockets, eval, new Function, cookies, chrome.* APIs, outside scripts, images or fonts.
- For a change in how something looks (size, colour, spacing, hiding), check it with "style" on the property you changed, or "hidden" if you hid it. Never check "hidden" on something you only restyled.
- "checks" are 1 to 4 tests run on the page after your change. At least one must be FALSE on the page before the change, so the test proves your change worked. Every selector you check must match something that is on the page NOW, from the summary above. A "hidden" check on a selector that matches nothing passes no matter what you do and is worthless. Types:
  "hidden": every element matching selector is invisible or gone
  "visible": at least one matching element is visible
  "exists": at least one element matches
  "absent": no element matches
  "textContains": the first match's text includes "text"
  "style": the first match's computed CSS "property" equals "value" exactly (for example "font-weight" equals "700")
- Never write a loop that could run forever, and never do work that triggers itself again. Do the work once, then stop. A tweak that locks up the page is thrown away.
- Do not use regular expressions. A small mistake in one breaks the whole tweak. Use string methods such as split(" "), trim(), includes() and textContent instead.
- Keep the code under about 40 lines. Short tweaks are faster to write and far more likely to work.
- If the request asks for anything counted, measured or worked out (a reading time, a count, a total), work it out from the page in the code. Never type a fixed number into the text.
- Keep the code short and readable.

Reply with only JSON:
{"name":"short name","summary":"one sentence on what it does","css":"","js":"","checks":[{"type":"hidden","selector":"","text":"","property":"","value":""}]}`;
}

// Pulls out the selectors the model's code depends on, so the tester can say
// which ones match nothing on the real page. Small models often guess these.
function selectorsUsed(gen) {
  const found = new Set();
  const js = gen.js || '';
  for (const m of js.matchAll(/querySelector(?:All)?\(\s*(['"`])((?:(?!\1).){1,120})\1\s*\)/g)) if (!m[2].includes('${')) found.add(m[2].trim());
  for (const m of js.matchAll(/getElementById\(\s*(['"`])([\w-]{1,80})\1\s*\)/g)) found.add('#' + m[2]);
  for (const m of js.matchAll(/getElementsByClassName\(\s*(['"`])([\w-]{1,80})\1\s*\)/g)) found.add('.' + m[2].trim().split(/\s+/).join('.'));
  for (const m of js.matchAll(/getElementsByTagName\(\s*(['"`])([\w-]{1,40})\1\s*\)/g)) found.add(m[2]);
  const css = (gen.css || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '');
  for (const m of css.matchAll(/([^{}]+)\{/g)) for (const part of m[1].split(',')) { const t = part.trim(); if (t && !t.startsWith('@') && t.length < 120) found.add(t.replace(/::?(before|after|hover|focus)\b.*/, '').trim() || t); }
  const created = new Set(gen.checks.filter(c => ['exists', 'visible', 'textContains', 'style'].includes(c.type)).map(c => c.selector));
  return [...found].filter(x => x && !/tweak-/.test(x) && !created.has(x)).slice(0, 12);
}

async function countSelectors(page, selectors) {
  return page.evaluate(sels => sels.map(sel => { try { return { sel, count: document.querySelectorAll(sel).length }; } catch { return { sel, count: -1 }; } }), selectors);
}

// Work out the checks from the CSS itself, instead of trusting the model to
// mark its own homework. A rule like "#title { font-size: 18px }" becomes a
// check that #title really is 18px, which cannot be wrong about what it tested.
const SAFE_PROPS = new Set(['display', 'visibility', 'font-size', 'font-weight', 'opacity', 'text-transform', 'text-decoration-line', 'width', 'height', 'max-width', 'max-height', 'border-radius', 'line-height', 'letter-spacing']);
export function checksFromCss(css) {
  const out = [];
  const body = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const block of body.split('}')) {
    const [rawSel, rawDecls] = block.split('{');
    if (!rawSel || !rawDecls) continue;
    const selector = rawSel.trim().split(',')[0].trim();
    if (!selector || selector.startsWith('@') || selector.includes(':hover') || selector.includes('::')) continue;
    for (const decl of rawDecls.split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const prop = decl.slice(0, i).trim().toLowerCase();
      let value = decl.slice(i + 1).replace(/!important/i, '').trim();
      if (!SAFE_PROPS.has(prop) || !value) continue;
      if (prop === 'display' && value === 'none') { out.push({ type: 'hidden', selector, text: '', property: '', value: '' }); continue; }
      if (prop === 'visibility' && value === 'hidden') { out.push({ type: 'hidden', selector, text: '', property: '', value: '' }); continue; }
      // only values a browser reports back unchanged, so the check cannot mislead
      if (prop === 'line-height' && !/px$/.test(value)) continue;
      if (prop === 'font-weight') value = value.toLowerCase() === 'bold' ? '700' : value.toLowerCase() === 'normal' ? '400' : value;
      if (!/^(-?\d+(\.\d+)?(px)?|normal|bold|none|block|flex|inline|inline-block|uppercase|lowercase|capitalize|underline|visible|hidden|[1-9]00)$/i.test(value)) continue;
      if (/^-?\d+(\.\d+)?$/.test(value) && ['font-size', 'width', 'height', 'max-width', 'max-height', 'border-radius', 'letter-spacing'].includes(prop)) value += 'px';
      out.push({ type: 'style', selector, property: prop, value, text: '' });
    }
  }
  return out.slice(0, 4);
}

// A tweak that adds something gives its element an id starting with tweak-.
// That is a check we can write ourselves: does it exist now.
export function checksFromJs(js) {
  const out = [], seen = new Set();
  for (const m of String(js || '').matchAll(/\bid\s*=\s*(['"`])(tweak-[\w-]+)\1/g)) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    out.push({ type: 'exists', selector: '#' + m[2], text: '', property: '', value: '' });
  }
  return out.slice(0, 3);
}

// Hiding something the tweak itself creates can never prove anything. The model
// means "it should be there", so read it that way instead of failing it.
function mendChecks(checks) {
  return checks.map(c => (['hidden', 'absent'].includes(c.type) && /tweak-/.test(c.selector)) ? { ...c, type: 'exists' } : c);
}

function tidyChecks(checks) {
  return (Array.isArray(checks) ? checks : [])
    .filter(c => c && CHECK_TYPES.includes(c.type) && typeof c.selector === 'string' && c.selector.trim())
    .slice(0, 4)
    .map(c => ({ type: c.type, selector: c.selector.trim(), text: c.text || '', property: c.property || '', value: c.value || '' }));
}


// Test code the person edited by hand. Same proof as the model gets: the page
// without it, then the page with it, then the checks compared.
export async function testCode({ url, css, js, checks, headless = true, dir }) {
  const out = { verdict: 'fail', problem: '', checks: [], shot: null };
  if (js && js.trim()) {
    try { new vm.Script(js); } catch (e) { out.problem = 'The JavaScript has a syntax error: ' + e.message; return out; }
  }
  const blocked = BLOCKED.filter(([re]) => re.test(js || '') || re.test(css || '')).map(([, why]) => why);
  if (blocked.length) { out.problem = 'Blocked for safety: the code ' + blocked.join(', ') + '.'; return out; }
  // If you edited pure CSS, the checks come from your CSS, not the old ones.
  const derived = !String(js || '').trim() ? checksFromCss(css) : [];
  const good = derived.length ? derived : tidyChecks(checks);
  if (!good.length) { out.problem = 'There are no checks to test this against.'; return out; }

  await writeExtension(dir, url, { name: 'Edited tweak', summary: '', css: css || '', js: js || '', checks: good });
  let browser, ctxB;
  try {
    browser = await openBrowser(null, true, 'base');
    const pageB = browser.pages()[0];
    await withLimit(goto(pageB, url), 'Opening the page');
    const before = await withLimit(runChecks(pageB, good), 'Checking the page as it is', 45000);
    await shutBrowser(browser);
    browser = null;

    ctxB = await openBrowser({ css: css || '', js: (js || '').trim() ? wrapJs(js) : '' }, headless);
    const page = ctxB.pages()[0] || await ctxB.newPage();
    await withLimit(goto(page, url), 'Opening the page with your change');
    if (!await isResponsive(page)) { out.problem = 'Your change locked up the page, so nothing could be checked.'; return out; }
    const err = await withLimit(tweakError(page), 'Reading the result', 20000).catch(() => 'the page stopped responding');
    const after = await withLimit(runChecks(page, good), 'Running the checks', 45000);
    const shot = path.join(dir, 'after.jpg');
    await withLimit(page.screenshot({ path: shot }), 'Taking a picture', 30000).catch(() => {});
    out.shot = shot;
    out.checks = good.map((c, i) => ({ ...c, before: before[i].pass, beforeDetail: before[i].detail, after: after[i].pass, afterDetail: after[i].detail }));
    const allPass = after.every(c => c.pass), proved = out.checks.some(c => c.after && !c.before);
    if (err) { out.problem = 'Your change crashed on the page: ' + err; }
    else if (allPass && proved) { out.verdict = 'works'; }
    else if (allPass) { out.verdict = 'unproven'; out.problem = 'Every check passed, but they also passed without the change.'; }
    else { out.problem = 'Some checks failed after the change.'; }
  } catch (e) {
    out.problem = e.code === 'phase_timeout' ? e.message : 'The test could not run: ' + e.message;
  } finally {
    await shutBrowser(ctxB);
    if (browser) await shutBrowser(browser);
  }
  return out;
}

// Used by the Chrome companion: the page is the one you are looking at, so the
// model writes the change and your own tab is the test.
export async function planTweak({ url, request, outline, model, fallback = '', feedback = '' }) {
  const known = await knownFor(url);
  const prompt = buildPrompt({ url, request, pageOutline: outline || '(no summary of the page)', feedback, known });
  let gen, usedModel = model;
  try {
    const r = await ask(model, prompt, SCHEMA, undefined);
    gen = r.json;
  } catch (e) {
    if (!fallback || fallback === model) throw e;
    usedModel = fallback;
    const r = await ask(fallback, prompt, SCHEMA, undefined);
    gen = r.json;
  }
  gen = { name: String(gen.name || 'Tweak'), summary: String(gen.summary || ''), css: String(gen.css || ''), js: String(gen.js || ''), checks: mendChecks(tidyChecks(gen.checks)) };
  const fromCss = !gen.js.trim() ? checksFromCss(gen.css) : [];
  const fromJs = gen.js.trim() ? checksFromJs(gen.js) : [];
  if (fromCss.length) gen.checks = fromCss;
  else if (fromJs.length) gen.checks = [...fromJs, ...gen.checks.filter(c => !fromJs.some(f => f.selector === c.selector))].slice(0, 4);
  return { ...gen, model: usedModel, wrappedJs: gen.js.trim() ? wrapJs(gen.js) : '' };
}

// Save a tweak the companion proved in your own tab.
export async function keepPlanned({ url, request, gen, checks }) {
  const dir = path.join(HOME, 'tweaks', (String(gen.name || 'tweak').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tweak'));
  let folder = dir;
  for (let i = 2; ; i++) { try { await fs.access(folder); folder = dir + '-' + i; } catch { break; } }
  await writeExtension(folder, url, gen);
  await fs.writeFile(path.join(folder, 'tweak.json'), JSON.stringify({ request, url, model: gen.model, verdict: 'works', checks, kept: new Date().toISOString(), madeIn: 'the browser bar' }, null, 2));
  await rememberWorking({ url, request, gen, checks }).catch(() => {});
  await fs.appendFile(LOG, JSON.stringify({ kind: 'keep', source: 'bar', url, request, folder, time: new Date().toISOString() }) + '\n').catch(() => {});
  return folder;
}

const MOD_SCHEMA = {
  type: 'object',
  properties: {
    name: S, summary: S,
    files: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'object', properties: { path: S, content: S }, required: ['path', 'content'] } }
  },
  required: ['name', 'summary', 'files']
};

function buildModPrompt({ request, projectOutline, feedback }) {
  return `You change a Minecraft mod written in Java.

The person wants: """${request}"""

The project as it is now:
${projectOutline}
${feedback ? `\nYour previous attempt did not work. What the build found:\n${feedback}\nFix exactly these problems.\n` : ''}
Rules:
- This Minecraft version uses Mojang's official names, not Yarn. For example net.minecraft.resources.Identifier, net.minecraft.world.item.Item, net.minecraft.core.Registry, net.minecraft.core.registries.BuiltInRegistries. Follow the imports already in the project.
- Reply with the COMPLETE new content of every file you change or add, not a fragment or a diff. Keep everything in those files that the request does not ask you to change.
- Only files under src/main/java (.java) or src/main/resources (.json, .mcmeta, .txt). Paths start with "src/main/". Never write images such as .png textures.
- Change as little as you can. One or two files is usually enough.
- A new Item needs its id set on its properties, new Item.Properties().setId(ResourceKey.create(Registries.ITEM, id)), or the game crashes when it starts.
- Not allowed: starting other programs, network connections, System.exit, deleting files, loops that never end.

Reply with only JSON:
{"name":"short name","summary":"one sentence on what it does","files":[{"path":"src/main/java/...","content":"..."}]}`;
}

// The same loop as a web tweak, for a project on disk: the model writes the
// change, it goes into a copy, the copy is built, and it only counts as working
// when the build passes and the change is provably in what was built.
async function runProject({ request, project, model, fallback = '', maxAttempts = 5, onEvent = () => {}, signal }) {
  const mc = await import('./targets/minecraft.js');
  const firstModel = model;
  // A 7B model is far weaker at Java than at CSS, so the bigger one is on by default.
  fallback = fallback || process.env.TWEAK_FALLBACK_MODEL || '';
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 6);
  const runDir = path.join(RUNS, id);
  await fs.mkdir(runDir, { recursive: true });
  const t0 = Date.now();
  const emit = (type, data) => onEvent({ type, at: Date.now() - t0, ...data });
  const result = { id, target: 'minecraft', request, url: project, project, model, firstModel, status: 'fail', attempts: [], reason: '', seconds: 0 };
  const finish = async (status, reason) => {
    Object.assign(result, { status, reason, seconds: Math.round((Date.now() - t0) / 100) / 10 });
    await fs.appendFile(LOG, JSON.stringify({ kind: 'run', target: 'minecraft', id, time: new Date().toISOString(), request, project, model: result.model, status, reason, seconds: result.seconds, attempts: result.attempts.map(a => ({ n: a.n, model: a.model, verdict: a.verdict, problem: a.problem, files: (a.files || []).map(f => f.path), tokens: a.tokens })) }) + '\n');
    emit('done', { result });
    return result;
  };

  emit('step', { key: 'open', label: 'Reading the mod project' });
  let info, projectOutline;
  try { info = await mc.detect(project); projectOutline = await mc.plan(info); }
  catch (e) { return finish('fail', 'Could not read the mod project: ' + e.message); }
  result.project = info.dir;
  await fs.writeFile(path.join(runDir, 'outline.txt'), projectOutline);
  emit('step', { key: 'read', label: `Found ${info.name}, ${info.loader} for Minecraft ${info.minecraft}` });
  if (!fallback) emit('step', { key: 'no-fallback', label: 'No bigger model is set in Settings, so only the model on this computer will try' });

  const work = path.join(runDir, 'project');
  emit('step', { key: 'copy', label: 'Copying the project, your folder is not touched' });
  await mc.copy(info.dir, work);

  // lastBuild: the last failed build's errors and real names, kept for every
  // later try, so a rejected reply in between cannot make the model forget them.
  let feedback = '', lastBuild = '', applied = null, names = null, retriedBig = false;
  emit('step', { key: 'names', label: 'Looking up the real names in Minecraft and Fabric' });
  try { names = await mc.api(work, signal); projectOutline += mc.matching(request, names); }
  catch (e) { projectOutline += '\n(Tweak could not list the libraries this mod uses: ' + e.message + ')\n'; emit('step', { key: 'names-failed', label: 'Could not look up the names: ' + e.message }); }
  await fs.writeFile(path.join(runDir, 'outline.txt'), projectOutline);
  for (let n = 1; n <= maxAttempts; n++) {
    if (signal && signal.aborted) return finish('stopped', 'Stopped.');
    if (applied) { await mc.undo(work, applied); applied = null; }
    if (fallback && fallback !== model && model === firstModel && n === 3) {
      model = fallback;
      emit('step', { key: 'escalate', label: `The small model could not do it. Trying ${fallback.replace(/^(ollama|api):/, '')}` });
    }
    const attempt = { n, verdict: 'fail', problem: '', checks: [], tokens: null, model };
    result.attempts.push(attempt);
    result.model = model;
    emit('step', { key: 'write', label: n === 1 ? 'Writing the change' : `Fixing it, try ${n} of ${maxAttempts}` });
    let gen;
    try {
      const prompt = buildModPrompt({ request, projectOutline, feedback });
      await fs.writeFile(path.join(runDir, `prompt-${n}.txt`), prompt);
      const r = await ask(model, prompt, MOD_SCHEMA, signal, 4000);
      gen = r.json; attempt.tokens = r.tokens;
    } catch (e) {
      if (e.name === 'AbortError') return finish('stopped', 'Stopped.');
      attempt.problem = e.name === 'TimeoutError' ? `${model.replace(/^(ollama|api):/, '')} did not answer within the time limit.` : e.message;
      emit('attempt', { attempt });
      // A busy server (5xx) gets one more go before giving up on it, as on the web path.
      if (e.code === 'model_unavailable' && e.status >= 500 && !retriedBig) {
        retriedBig = true;
        emit('step', { key: 'retry', label: `${model.replace(/^(ollama|api):/, '')} did not answer (error ${e.status}). Trying it once more` });
        await new Promise(r => setTimeout(r, 2000));
        n--; continue;
      }
      // If the bigger model cannot be used, the model on this computer carries on.
      if (e.code === 'model_unavailable' && model !== firstModel) {
        emit('step', { key: 'back-local', label: `Carrying on with ${firstModel.replace(/^(ollama|api):/, '')} on your computer` });
        model = firstModel; fallback = ''; n--; continue; // not counted, as on the web path
      }
      if (e.raw) await fs.writeFile(path.join(runDir, `reply-${n}.txt`), e.raw);
      if (/valid JSON|returned nothing/.test(e.message)) { feedback = 'Your reply was not valid JSON. Reply with only the JSON object.' + lastBuild; continue; }
      if (e.name === 'TimeoutError' && fallback && model === firstModel) {
        model = fallback;
        emit('step', { key: 'escalate', label: `Trying ${fallback.replace(/^(ollama|api):/, '')} instead` });
        continue;
      }
      if (e.name === 'TimeoutError') return finish('fail', 'The model did not answer within the time limit. Try a smaller model, or raise TWEAK_MODEL_TIMEOUT.');
      return finish('fail', 'The model could not be used: ' + e.message);
    }
    let files = (Array.isArray(gen.files) ? gen.files : []).map(f => ({ path: String(f && f.path || '').replace(/\\/g, '/').replace(/^\.?\//, ''), content: String(f && f.content || '') }));
    // A model cannot draw a texture in JSON. Leave images out, say so, build the rest.
    const images = files.filter(f => /\.(png|jpe?g|gif|ogg)$/i.test(f.path));
    if (images.length && images.length < files.length) {
      files = files.filter(f => !images.includes(f));
      attempt.leftOut = images.map(f => f.path);
      emit('step', { key: 'left-out', label: `Left out ${attempt.leftOut.join(', ')}: Tweak cannot make images, so it will have no texture` });
    }
    Object.assign(attempt, { name: String(gen.name || 'Change'), summary: String(gen.summary || ''), files });
    const bad = mc.problemWith(files);
    if (bad) { attempt.problem = bad; feedback = bad + lastBuild; emit('attempt', { attempt }); continue; }

    applied = await mc.apply(work, files);
    attempt.originals = applied;
    emit('step', { key: 'test', label: 'Building the mod with the change' });
    const built = await mc.build(work, signal);
    if (signal && signal.aborted) return finish('stopped', 'Stopped.');
    const tested = await mc.test(info.dir, work, files, built);
    Object.assign(attempt, { checks: tested.checks, verdict: tested.verdict, notTested: tested.notTested });
    await fs.writeFile(path.join(runDir, `build-${n}.log`), built.log);
    if (!built.ok) attempt.problem = 'The build failed:\n' + built.errors;
    else if (tested.verdict !== 'works') attempt.problem = 'The build passed, but ' + tested.checks.filter(c => !c.after).map(c => `${c.selector}: ${c.afterDetail}`).join('; ') + '.';
    emit('attempt', { attempt });
    if (tested.verdict === 'works') { result.best = n; return finish('works', 'The mod builds with the change, and the changed code is in the build. ' + tested.notTested); }
    feedback = attempt.problem;
    // Answer "cannot find symbol" with the names that really exist in this
    // mod's libraries, the way the web path lists selectors that do exist.
    if (!built.ok && /cannot find symbol|does not exist/.test(built.log)) {
      try {
        if (!names) { emit('step', { key: 'names', label: 'Looking up the real names in Minecraft and Fabric' }); names = await mc.api(work, signal); }
        attempt.hints = mc.hints(built.log, names);
      } catch (e) { attempt.hints = 'Tweak could not look up the real names: ' + e.message; }
      if (attempt.hints) feedback += '\n\nThe real names in this version:\n' + attempt.hints;
    }
    lastBuild = built.ok ? '' : '\n\nThe last change that was built failed like this:\n' + feedback;
  }
  return finish('fail', `No change that builds after ${maxAttempts} tries.`);
}

// Keep for a project target: write the proved files into the real project.
export async function keepProject(result, attemptN) {
  const a = result.attempts.find(x => x.n === attemptN);
  if (!a || a.verdict !== 'works' || !a.files) throw new Error('Only a change that built and was proved can be kept.');
  const mc = await import('./targets/minecraft.js');
  const written = await mc.keep(result.project, a.files, a.originals, path.join(RUNS, result.id, `kept-${attemptN}`));
  await fs.appendFile(LOG, JSON.stringify({ kind: 'keep', target: 'minecraft', id: result.id, attempt: attemptN, project: result.project, files: written, time: new Date().toISOString() }) + '\n');
  return written;
}

// attempts: how many samples the model on this computer writes per round, at
// temperatures 0.2, 0.4, ... (0.2 x k). All of them are tested and logged; the
// lowest numbered one that works wins. escalate: false never uses the fallback.
export async function runTweak({ target = 'web', request, url, model, fallback = '', headless = true, maxAttempts = 3, attempts = 1, escalate = true, onEvent = () => {}, signal }) {
  if (target === 'minecraft') return runProject({ request, project: url, model, fallback, onEvent, signal });
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) throw new Error(`attempts must be a whole number from 1 to 5, not ${attempts}`);
  if (!escalate) fallback = '';
  // After two failures on the small model, try the bigger one if there is one.
  const firstModel = model;
  if (fallback && fallback !== model) maxAttempts = Math.max(maxAttempts, 4);
  const id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 6);
  const runDir = path.join(RUNS, id);
  await fs.mkdir(runDir, { recursive: true });
  const t0 = Date.now();
  const emit = (type, data) => onEvent({ type, at: Date.now() - t0, ...data });
  const result = { id, request, url, model, firstModel, status: 'fail', attempts: [], reason: '', seconds: 0 };
  let baselineBrowser, testBrowser, modelCalls = 0;

  const finish = async (status, reason) => {
    
    result.status = status; result.reason = reason; result.seconds = Math.round((Date.now() - t0) / 100) / 10;
    if (baselineBrowser) await shutBrowser(baselineBrowser);
    if (testBrowser) await shutBrowser(testBrowser);
    await fs.mkdir(HOME, { recursive: true });
    let line;
    try { line = JSON.stringify({ kind: 'run', id, time: new Date().toISOString(), request, url, model, status, reason, seconds: result.seconds, modelCalls, attempts: result.attempts.map(a => ({
      n: a.n, round: a.round, sample: a.sample, temperature: a.temperature, model: a.model, ms: a.ms ?? Date.now() - a.started,
      verdict: a.verdict, problem: a.problem, tokens: a.tokens,
      checks: a.checks.map(c => ({ type: c.type, selector: c.selector, origin: c.origin, before: c.before, after: c.after })),
      failed: a.checks.filter(c => !c.after).map(c => c.selector),
      reliedOnModelChecks: a.reliedOnModelChecks ?? null
    })) }) + '\n'; }
    catch (e) { line = '{}\n'; }
    await fs.appendFile(LOG, line).catch(() => {});
    emit('done', { result });
    return result;
  };

  try {
    new URL(url);
  } catch { return finish('fail', 'That address is not a valid web address.'); }

  // 1. Open the page as it is, read it, and keep that window as the one we
  //    compare against. One window, loaded once.
  emit('step', { key: 'open', label: 'Opening the page' });
  let pageOutline, basePage;
  try { baselineBrowser = await openBrowser(null, true, 'base'); }
  catch (e) { return finish('fail', e.code === 'phase_timeout' ? 'The test browser would not start. Close any other window running Tweak, then try again.' : 'The test browser would not start: ' + e.message); }
  try {
    basePage = baselineBrowser.pages()[0];
    await withLimit(goto(basePage, url), 'Opening the page');
    const wall = await consentWall(basePage);
    if (wall) return finish('fail', `Cannot test this: ${wall}, so anything built now would be about the wall, not the real page. Click "Open test browser", accept or reject the cookie page once, close that window, then try again.`);
    await withLimit(basePage.screenshot({ path: path.join(runDir, 'before.jpg') }), 'Taking a picture', 30000);
    emit('shot', { which: 'before', file: `${id}/before.jpg` });
    emit('step', { key: 'read', label: 'Reading the page' });
    pageOutline = await withLimit(outline(basePage, request), 'Reading the page', 60000);
    await fs.writeFile(path.join(runDir, 'outline.txt'), pageOutline);
    await saveCookies(baselineBrowser, COOKIES);
  } catch (e) {
    return finish('fail', e.code === 'phase_timeout' ? e.message + '. The page may be too slow or blocked.' : 'Could not read the page: ' + e.message);
  }

  // Every sample in a round gets the same prompt. Only attempt 1's lesson goes
  // to the next round, so attempt 1 of each round is exactly the single-try loop.
  let roundFeedback = '', nextFeedback = '', n = 0;
  let weakBest = null;
  const known = await knownFor(url);
  if (known) emit('step', { key: 'known', label: 'Using what worked on this site before' });
  for (let round = 1; round <= maxAttempts; round++) {
    if (fallback && fallback !== model && round === 3) {
      model = fallback;
      emit('step', { key: 'escalate', label: `The small model could not do it. Trying ${fallback.replace(/^(ollama|api):/, '')}` });
    }
    // The bigger model keeps one try per round at 0.2, as before sampling.
    const samples = model === firstModel ? attempts : 1;
    let winner = null;
    for (let k = 1; k <= samples; k++) {
      let feedback = '', attempt = null;
      try {
        if (signal && signal.aborted) return finish('stopped', 'Stopped.');
        n++;
        const temperature = model === firstModel ? Math.round(k * 2) / 10 : 0.2;
        attempt = { n, round, sample: k, temperature, started: Date.now(), verdict: 'fail', problem: '', checks: [], tokens: null, model };
        result.attempts.push(attempt);

        emit('step', { key: 'write', label: attempts > 1 ? `Round ${round}, attempt ${k} of ${samples}` : n === 1 ? 'Writing the tweak' : `Fixing it, try ${n} of ${maxAttempts}` });
        result.model = model;
        let gen;
        try {
          modelCalls++;
          const r = await ask(model, buildPrompt({ url, request, pageOutline, feedback: roundFeedback, known }), SCHEMA, signal, undefined, temperature);
          gen = r.json; attempt.tokens = r.tokens;
        } catch (e) {
          // Nothing ever fully stops: if the bigger model cannot be used, the model
          // on this computer carries on.
          if (e.code === 'model_unavailable' && e.status >= 500 && !attempt.retried) {
            attempt.retried = true;
            attempt.problem = `${model.replace(/^(ollama|api):/, '')} timed out. Trying it once more.`;
            emit('attempt', { attempt });
            await new Promise(r => setTimeout(r, 2000));
            n--; k--;
            continue;
          }
          if (e.code === 'model_unavailable' && model !== firstModel) {
            attempt.problem = e.message;
            emit('attempt', { attempt });
            emit('step', { key: 'back-local', label: `Carrying on with ${firstModel.replace(/^(ollama|api):/, '')} on your computer` });
            model = firstModel;
            result.model = model;
            fallback = '';
            n--; k--;
            continue;
          }
          if (e.name === 'AbortError') return finish('stopped', 'Stopped.');
          if (e.name === 'TimeoutError') return finish('fail', 'The model did not answer within the time limit. Try a smaller model, or raise TWEAK_MODEL_TIMEOUT.');
          attempt.problem = e.message;
          emit('attempt', { attempt });
          if (/valid JSON|returned nothing/.test(e.message) && (round < maxAttempts || k < samples)) { feedback = 'Your reply was not valid JSON. Reply with only the JSON object.'; continue; }
          return finish('fail', 'The model could not be used: ' + e.message);
        }
        gen = { name: String(gen.name || 'Tweak'), summary: String(gen.summary || ''), css: String(gen.css || ''), js: String(gen.js || ''), checks: tidyChecks(gen.checks) };
        // Write the checks ourselves wherever we can, so a bad check cannot fail good work.
        // origin says who wrote each check: 'tweak' (derived from the code) or 'model'.
        gen.checks = mendChecks(gen.checks).map(c => ({ ...c, origin: 'model' }));
        const fromCss = (!gen.js.trim() ? checksFromCss(gen.css) : []).map(c => ({ ...c, origin: 'tweak' }));
        const fromJs = (gen.js.trim() ? checksFromJs(gen.js) : []).map(c => ({ ...c, origin: 'tweak' }));
        if (fromCss.length) { attempt.checksFromCss = true; gen.checks = fromCss; }
        else if (fromJs.length) { attempt.checksFromCss = true; gen.checks = [...fromJs, ...gen.checks.filter(c => !fromJs.some(f => f.selector === c.selector))].slice(0, 4); }
        attempt.name = gen.name; attempt.summary = gen.summary; attempt.css = gen.css; attempt.js = gen.js; attempt.plannedChecks = gen.checks;

        const blocked = BLOCKED.filter(([re]) => re.test(gen.js) || re.test(gen.css)).map(([, why]) => why);
        if (blocked.length) {
          attempt.problem = 'Blocked for safety: the code ' + blocked.join(', ') + '.';
          feedback = attempt.problem + ' That is not allowed. Change the page without it.';
          emit('attempt', { attempt }); continue;
        }
        const fake = looksHardcoded(request, gen);
        if (fake) {
          attempt.problem = 'Rejected: ' + fake + '.';
          feedback = attempt.problem + ' Work the value out from the page itself, for example by counting words with .split(/\\s+/).length, and show the result. Never type a number in.';
          emit('attempt', { attempt }); continue;
        }
        if (!gen.css.trim() && !gen.js.trim()) { attempt.problem = 'The model wrote no code.'; feedback = 'You wrote no css and no js.'; emit('attempt', { attempt }); continue; }
        if (gen.js.trim()) {
          try { new vm.Script(gen.js); } catch (e) {
            attempt.problem = 'The JavaScript has a syntax error: ' + e.message;
            feedback = attempt.problem + (/regular expression|regex/i.test(e.message) ? ' Do not use a regular expression at all. Use split(" ") and other plain string methods.' : '');
            emit('attempt', { attempt }); continue;
          }
        }
        if (!gen.checks.length) { attempt.problem = 'The model gave no usable checks, so the tweak cannot be tested.'; feedback = 'You gave no valid checks. Give 1 to 4 checks using the allowed types.'; emit('attempt', { attempt }); continue; }

        const extDir = path.join(runDir, `attempt-${n}`);
        await writeExtension(extDir, url, gen);
        const inject = { css: gen.css, js: gen.js.trim() ? wrapJs(gen.js) : '' };

        emit('step', { key: 'test', label: 'Testing it on the real page' });
        let after, err, before;
        try {
          before = await withLimit(runChecks(basePage, gen.checks), 'Checking the page as it is', 45000);
          // A "hidden" or "absent" check on a selector that matches nothing passes
          // whatever the tweak does, so it can never prove anything.
          const empty = gen.checks.map((c, i) => ({ c, i })).filter(({ c, i }) => ['hidden', 'absent'].includes(c.type) && /^0 matched/.test(before[i].detail));
          const allTrue = before.every(c => c.pass);
          if (empty.length || allTrue) {
            attempt.verdict = 'fail';
            attempt.problem = empty.length
              ? `Nothing on the page matches ${empty.map(({ c }) => '"' + c.selector + '"').join(' or ')}, so hiding it proves nothing.`
              : 'Every one of your checks is already true before the change, so they cannot prove anything.';
            const used = selectorsUsed(gen);
            if (used.length) { const counts = await countSelectors(basePage, used); attempt.missing = counts.filter(x => x.count <= 0).map(x => x.sel); attempt.matched = counts.filter(x => x.count > 0).map(x => `${x.sel} (${x.count})`); }
            emit('attempt', { attempt });
            feedback = attempt.problem + ' Pick selectors that really exist on this page, from the summary above, and check something that is TRUE now and FALSE after your change (or the other way round).'
              + (attempt.matched && attempt.matched.length ? ' Selectors that do exist: ' + attempt.matched.join(', ') + '.' : '');
            continue;
          }
          emit('step', { key: 'test-open', label: 'Testing it: opening the browser' });
          if (!testBrowser) testBrowser = await openBrowser(inject, headless);
          else testBrowser.setInject(inject);
          const page = testBrowser.pages()[0];
          emit('step', { key: 'test-goto', label: 'Testing it: loading the page' });
          await withLimit(goto(page, url), 'Opening the page with the tweak');
          emit('step', { key: 'test-check', label: 'Testing it: running the checks' });
          if (!await isResponsive(page)) {
            await shutBrowser(testBrowser); testBrowser = null;
            attempt.verdict = 'fail';
            attempt.problem = 'The tweak locked up the page, so nothing could be checked.';
            emit('attempt', { attempt });
            feedback = attempt.problem + ' Your code must do its work once and stop. No endless loops, no code that runs itself again and again, no work inside a loop over every element on the page.';
            continue;
          }
          err = await withLimit(tweakError(page), 'Reading the result', 20000).catch(() => 'the page stopped responding');
          after = await withLimit(runChecks(page, gen.checks), 'Running the checks', 30000);
          emit('step', { key: 'test-shot', label: 'Testing it: taking a picture' });
          await withLimit(page.screenshot({ path: path.join(runDir, `after-${n}.jpg`) }), 'Taking a picture', 30000);
          emit('shot', { which: 'after', n, file: `${id}/after-${n}.jpg` });
          
        } catch (e) {
          await shutBrowser(testBrowser); testBrowser = null;
          attempt.verdict = 'fail';
          attempt.problem = e.code === 'phase_timeout' ? e.message : 'The test could not run: ' + e.message;
          emit('attempt', { attempt });
          feedback = attempt.problem;
          continue;
        }
        attempt.checks = gen.checks.map((c, i) => ({ ...c, before: before[i].pass, beforeDetail: before[i].detail, after: after[i].pass, afterDetail: after[i].detail }));
        const allPass = after.every(c => c.pass);
        const proved = attempt.checks.some(c => c.after && !c.before);
        attempt.reliedOnModelChecks = attempt.checks.some(c => c.origin === 'model');
        if (err) {
          attempt.verdict = 'fail'; attempt.problem = 'The tweak crashed on the page: ' + err;
        } else if (allPass && proved) {
          attempt.verdict = 'works';
        } else if (allPass) {
          attempt.verdict = 'unproven'; attempt.problem = 'Every check passed, but they also passed without the tweak, so the test proves nothing.';
        } else {
          attempt.verdict = 'fail'; attempt.problem = 'Some checks failed after the change.';
        }
        attempt.extDir = extDir;
        if (attempt.verdict !== 'works') {
          const used = selectorsUsed(gen);
          if (used.length) {
            const counts = await countSelectors(basePage, used);
            attempt.missing = counts.filter(c => c.count <= 0).map(c => c.sel);
            attempt.matched = counts.filter(c => c.count > 0).map(c => `${c.sel} (${c.count})`);
          }
        }
        emit('attempt', { attempt });

        if (attempt.verdict === 'works') {
          if (!winner) { winner = n; await rememberWorking({ url, request, gen, checks: attempt.checks }).catch(() => {}); }
          continue;
        }
        if (attempt.verdict === 'unproven') weakBest = weakBest || n;

        const lines = attempt.checks.map(c => `- ${c.type} "${c.selector}": before the change ${c.before ? 'TRUE' : 'false'} (${c.beforeDetail}), after ${c.after ? 'TRUE' : 'FALSE'} (${c.afterDetail})`);
        const hints = [];
        if (attempt.missing && attempt.missing.length) hints.push(`Selectors your code depends on that match NOTHING on this page, so your change never attached: ${attempt.missing.join(', ')}. Choose selectors that appear in the page summary instead.`);
        if (attempt.matched && attempt.matched.length) hints.push(`Selectors that do exist on the page (with counts): ${attempt.matched.join(', ')}.`);
        if (/before initialization|is not defined/i.test(attempt.problem)) hints.push('Declare every variable and function before you use it.');
        if (/regular expression|regex/i.test(attempt.problem)) hints.push('Do not use a regular expression at all. Use split(" ") and other plain string methods.');
        if (/insertBefore|not a child/i.test(attempt.problem)) hints.push('Never call insertBefore on a different element. To put your element just before or after something, use spot.before(el) or spot.after(el). To put it inside, use spot.prepend(el) or spot.append(el).');
        if (/locked up the page|reacting to its own changes/i.test(attempt.problem)) hints.push('Either drop the MutationObserver entirely, or make the very first line of the function return when document.getElementById("your-id") already exists.');
        feedback = [attempt.problem, ...lines, ...hints].join('\n');
      } finally {
        if (attempt) attempt.ms = Date.now() - attempt.started;
        if (k === 1) nextFeedback = feedback;
      }
    }
    if (winner) { result.best = winner; return finish('works', 'The change was tested on the real page and the checks prove it.'); }
    roundFeedback = nextFeedback;
  }
  if (weakBest) { result.best = weakBest; return finish('unproven', 'The checks passed but did not prove anything changed. Look at the screenshots before keeping it.'); }
  return finish('fail', `No working tweak after ${maxAttempts} tries.`);
}
