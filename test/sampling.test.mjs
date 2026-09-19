// Multi-attempt sampling on the website path: N samples per round at
// temperatures 0.2, 0.4, ... (0.2 x k), all N run and logged, the lowest
// numbered pass wins, and the next round learns only from attempt 1.
// The model and the browser are fakes; the pipeline and its checks are real.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TWEAK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tweak-sampling-'));
after(() => fs.rmSync(process.env.TWEAK_HOME, { recursive: true, force: true }));
const lib = new URL('../lib/', import.meta.url);

// What the model writes. GOOD marks a change the fake page will honour.
const GEN = {
  good: { name: 'good', summary: '', css: '#ad { display: none } /*GOOD*/', js: '', checks: [{ type: 'hidden', selector: '#ad' }] },
  bad: { name: 'bad', summary: '', css: '#ad { display: none }', js: '', checks: [{ type: 'hidden', selector: '#ad' }] },
  empty: { name: 'empty', summary: '', css: '', js: '', checks: [{ type: 'hidden', selector: '#ad' }] },
  blocked: { name: 'blocked', summary: '', css: '', js: "fetch('/x')", checks: [{ type: 'hidden', selector: '#ad' }] },
  // creates #tweak-x (a check Tweak derives) and brings its own check on #title
  js: { name: 'js', summary: '', css: '', js: "const el = document.createElement('div'); el.id = 'tweak-x'; document.body.append(el); // GOOD", checks: [{ type: 'visible', selector: '#title' }] }
};

let script = [], calls = [];
mock.module(new URL('model.js', lib).href, { exports: {
  ask: async (model, prompt, _schema, _signal, _maxOutput, temperature) => {
    calls.push({ model, prompt, temperature: temperature ?? 0.2 }); // model.js defaults to 0.2
    const g = script[calls.length - 1];
    if (!g) throw new Error(`the test gave no reply for call ${calls.length}`);
    return { json: structuredClone(GEN[g]), tokens: { prompt: 100, output: 10 } };
  },
  listModels: async () => ({}), parseJSON: JSON.parse
} });

// A page with #ad (visible) and #title (visible). With a GOOD change in it,
// #ad is hidden and #tweak-x exists.
const works = inject => !!inject && /GOOD/.test((inject.css || '') + (inject.js || ''));
function fakeContext(inject) {
  const ctx = { inject, setInject(next) { ctx.inject = next; }, close: async () => {} };
  const page = { ctx, screenshot: async () => true, evaluate: async (_fn, sels) => sels.map(sel => ({ sel, count: 1 })) };
  ctx.pages = () => [page];
  return ctx;
}
const check = (c, ok) => {
  if (c.type === 'hidden') return { pass: ok, detail: ok ? '1 matched, 0 visible' : '1 matched, 1 visible' };
  if (c.type === 'exists') return { pass: ok && c.selector === '#tweak-x', detail: ok ? '1 matched, 1 visible' : '0 matched, 0 visible' };
  if (c.type === 'visible') return { pass: c.selector === '#title', detail: '1 matched, 1 visible' };
  return { pass: false, detail: '0 matched, 0 visible' };
};
mock.module(new URL('browser.js', lib).href, { exports: {
  VIEWPORT: {}, launchTestBrowser: async inject => fakeContext(inject), goto: async () => {}, outline: async () => 'outline',
  runChecks: async (page, checks) => checks.map(c => check(c, works(page.ctx.inject))),
  tweakError: async () => '', consentWall: async () => '', freshProfile: () => {}, dropProfile: () => {},
  loadCookies: async () => {}, saveCookies: async () => {}, isResponsive: async () => true, sweepProfiles: async () => {}
} });

const { runTweak, LOG } = await import(new URL('pipeline.js', lib).href);
const lastLog = () => JSON.parse(fs.readFileSync(LOG, 'utf8').trim().split('\n').pop());
async function run(replies, opts = {}) {
  script = replies; calls = [];
  const result = await runTweak({ request: 'hide the ad', url: 'https://example.com/', model: 'ollama:small', ...opts });
  return { result, calls, log: lastLog() };
}

test('N=1 behaves as before: one try per round at 0.2, repair feedback, stops at the first pass', async () => {
  // This test passed on the pipeline before sampling existed (1.7.1), unchanged.
  const { result, calls, log } = await run(['bad', 'good']);
  assert.equal(result.status, 'works');
  assert.equal(result.best, 2);
  assert.deepEqual(result.attempts.map(a => [a.n, a.verdict]), [[1, 'fail'], [2, 'works']]);
  assert.deepEqual(calls.map(c => c.temperature), [0.2, 0.2]);
  assert.match(calls[1].prompt, /Some checks failed after the change/);
  assert.deepEqual(log.attempts.map(a => [a.n, a.verdict]), [[1, 'fail'], [2, 'works']]);

  const failing = await run(['bad', 'bad', 'bad']);
  assert.equal(failing.result.status, 'fail');
  assert.equal(failing.result.reason, 'No working tweak after 3 tries.');
  assert.equal(failing.calls.length, 3);
});

test('the winner is the lowest numbered passing attempt, and each round learns from its attempt 1 only', async () => {
  const { result, calls } = await run(['empty', 'blocked', 'bad', 'bad', 'good', 'good'], { attempts: 3 });
  assert.equal(result.status, 'works');
  // Control: attempts 5 and 6 both pass, so "last pass" or "any pass" would pick wrong.
  assert.equal(result.best, 5);
  const winner = result.attempts.find(a => a.n === result.best);
  assert.deepEqual([winner.round, winner.sample, winner.temperature], [2, 2, 0.4]);
  assert.deepEqual(calls.map(c => c.temperature), [0.2, 0.4, 0.6, 0.2, 0.4, 0.6]);
  // Round 2 is told what went wrong with round 1's attempt 1, never attempt 2's.
  for (const c of calls.slice(3)) {
    assert.match(c.prompt, /You wrote no css and no js/);
    assert.doesNotMatch(c.prompt, /Blocked for safety/);
  }
});

test('all N attempts run and are logged even when attempt 1 passes', async () => {
  const { result, calls, log } = await run(['good', 'bad', 'good'], { attempts: 3 });
  assert.equal(result.best, 1);
  assert.equal(calls.length, 3, 'stopped sampling after the first pass');
  assert.equal(log.modelCalls, 3);
  assert.deepEqual(log.attempts.map(a => [a.round, a.sample, a.temperature, a.verdict]), [[1, 1, 0.2, 'works'], [1, 2, 0.4, 'fail'], [1, 3, 0.6, 'works']]);
  for (const a of log.attempts) {
    assert.equal(typeof a.ms, 'number');
    assert.deepEqual(a.tokens, { prompt: 100, output: 10 });
    assert.deepEqual(a.checks.map(c => [c.type, c.selector, c.origin]), [['hidden', '#ad', 'tweak']]);
  }
  assert.deepEqual(log.attempts[1].failed, ['#ad']);
  assert.deepEqual(log.attempts[0].failed, []);
});

test('each check is logged with its origin, and whether the verdict relied on a model-written check', async () => {
  const js = await run(['js']);
  assert.equal(js.result.status, 'works');
  assert.deepEqual(js.log.attempts[0].checks.map(c => [c.selector, c.origin, c.before, c.after]), [['#tweak-x', 'tweak', false, true], ['#title', 'model', true, true]]);
  assert.equal(js.log.attempts[0].reliedOnModelChecks, true);

  // Control: a CSS-only tweak has every check derived, so nothing relies on the model.
  const css = await run(['good']);
  assert.deepEqual(css.log.attempts[0].checks.map(c => c.origin), ['tweak']);
  assert.equal(css.log.attempts[0].reliedOnModelChecks, false);
});

test('escalate: false never calls the bigger model', async () => {
  const { calls } = await run(['bad', 'bad', 'bad'], { fallback: 'api:big', escalate: false });
  assert.deepEqual(calls.map(c => c.model), ['ollama:small', 'ollama:small', 'ollama:small']);
  // Control: with escalation on (the default), try 3 goes to the bigger model.
  const on = await run(['bad', 'bad', 'bad', 'bad'], { fallback: 'api:big' });
  assert.equal(on.calls[2].model, 'api:big');
});
