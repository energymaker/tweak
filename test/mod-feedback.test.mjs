// Run: node --test --experimental-test-module-mocks test/
// A failed build's errors and the real class names must reach every later
// try, even when a try in between is rejected before it builds (bad JSON, a
// file Tweak will not write). Before 1.7.1 those rejections replaced them.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TWEAK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tweak-test-'));
after(() => fs.rmSync(process.env.TWEAK_HOME, { recursive: true, force: true }));
const lib = new URL('../lib/', import.meta.url);
const ERRORS = 'src/main/java/a/Mod.java:3: error: cannot find symbol\n  symbol: class ItemGroup';
const HINT = 'ItemGroup is net.minecraft.world.item.CreativeModeTab.';
const good = { name: 'x', summary: 'x', files: [{ path: 'src/main/java/a/Mod.java', content: 'class Mod {}' }] };

// What the model does on each try, in order.
const replies = [
  () => ({ json: good }),                                  // 1: builds, fails
  () => { throw new Error('The reply was not valid JSON.'); }, // 2: bad JSON
  () => ({ json: { ...good, files: [{ path: 'evil.sh', content: 'x' }] } }), // 3: refused file
  () => ({ json: good })                                   // 4: builds, fails
];
const prompts = [];
mock.module(new URL('model.js', lib).href, { exports: {
  ask: async (_model, prompt) => { prompts.push(prompt); return replies[prompts.length - 1](); },
  listModels: async () => [], parseJSON: JSON.parse
} });
mock.module(new URL('browser.js', lib).href, { exports: Object.fromEntries(
  ['VIEWPORT', 'launchTestBrowser', 'goto', 'outline', 'runChecks', 'tweakError', 'consentWall', 'freshProfile', 'dropProfile', 'loadCookies', 'saveCookies', 'isResponsive'].map(k => [k, () => {}])
) });
const real = await import(new URL('targets/minecraft.js', lib).href);
mock.module(new URL('targets/minecraft.js', lib).href, { exports: {
  ...real,
  detect: async dir => ({ dir, name: 'Mod', loader: 'Fabric', minecraft: '1.21' }),
  plan: async () => 'outline',
  copy: async () => {},
  api: async () => ({ bySimple: new Map(), used: new Set() }),
  matching: () => '',
  apply: async () => [],
  undo: async () => {},
  build: async () => ({ ok: false, code: 1, log: 'cannot find symbol', errors: ERRORS }),
  test: async () => ({ checks: [], verdict: 'fail', notTested: '' }),
  hints: () => HINT
} });

const { runTweak } = await import(new URL('pipeline.js', lib).href);

test('every retry after a failed build still carries its errors and the real names', async () => {
  await runTweak({ target: 'minecraft', request: 'add a tab', url: 'C:/mod', model: 'ollama:x', fallback: 'ollama:x' });
  assert.ok(prompts.length >= 4, `expected 4 tries, got ${prompts.length}`);
  // Control: the first try has had no build yet, so it must carry neither.
  assert.ok(!prompts[0].includes(ERRORS) && !prompts[0].includes(HINT));
  for (const n of [1, 2, 3]) {
    assert.ok(prompts[n].includes(ERRORS), `try ${n + 1} lost the build errors`);
    assert.ok(prompts[n].includes(HINT), `try ${n + 1} lost the real class names`);
  }
  // The rejection that caused the retry is still said, first.
  assert.match(prompts[2], /not valid JSON/);
  assert.match(prompts[3], /evil\.sh/);
});
