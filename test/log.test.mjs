import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendCapped } from '../lib/log.js';

test('the log keeps the newest whole lines and stays under the cap', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweak-log-'));
  const file = path.join(dir, 'logs', 'updater.log');
  const lines = Array.from({ length: 50 }, (_, i) => `line ${String(i).padStart(2, '0')} ${'x'.repeat(20)}\n`);
  for (const l of lines) await appendCapped(file, l, 300);
  const kept = fs.readFileSync(file, 'utf8');
  // Control: 50 lines are far over 300 bytes, so without trimming this fails.
  assert.ok(Buffer.byteLength(kept) <= 300, `log is ${Buffer.byteLength(kept)} bytes`);
  assert.ok(kept.endsWith(lines[49]), 'the newest line was lost');
  assert.ok(!kept.includes('line 00'), 'the oldest line was kept');
  assert.ok(kept.startsWith('line '), 'the file starts mid line');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a small log is left as written', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tweak-log-'));
  const file = path.join(dir, 'updater.log');
  await appendCapped(file, 'a\n'); await appendCapped(file, 'b\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'a\nb\n');
  fs.rmSync(dir, { recursive: true, force: true });
});
