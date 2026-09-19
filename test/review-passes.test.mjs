import { test } from 'node:test';
import assert from 'node:assert/strict';
import { passesToReview, page } from '../review-passes.mjs';

const at = (round, sample, verdict) => ({ n: (round - 1) * 5 + sample, round, sample, verdict, temperature: sample / 5, checks: [] });
const fails = r => [1, 2, 3, 4, 5].map(k => at(r, k, 'fail'));

test('each winning attempt is reviewed once, with every N it wins for', () => {
  // N=1 wins at 2.1, N=3 and N=5 at 1.2: two attempts to judge.
  const split = { id: 'a', request: 'split', attempts: [at(1, 1, 'fail'), at(1, 2, 'works'), ...fails(1).slice(2), at(2, 1, 'works'), ...fails(2).slice(1), ...fails(3)] };
  const same = { id: 'b', request: 'same', attempts: [at(1, 1, 'works'), ...fails(1).slice(1), ...fails(2), ...fails(3)] };
  const never = { id: 'c', request: 'never', attempts: [...fails(1), ...fails(2), ...fails(3)] };
  const items = passesToReview([split, same, never]);
  assert.deepEqual(items.map(i => [i.run.request, i.attempt.round + '.' + i.attempt.sample, i.ns]), [['split', '2.1', [1]], ['split', '1.2', [3, 5]], ['same', '1.1', [1, 3, 5]]]);
});

test('the page pre-fills no verdict and says when a screenshot is missing', () => {
  const run = { id: 'x', request: 'r', url: 'u', attempts: [{ ...at(1, 1, 'works'), checks: [{ type: 'hidden', selector: '#a', origin: 'tweak', before: false, after: true }] }] };
  const html = page([{ run, attempt: run.attempts[0], ns: [1] }], 'C:/does-not-exist', 's');
  assert.doesNotMatch(html, /<input[^>]*checked/, 'a verdict was pre-filled');
  assert.match(html, /No screenshot was taken/);
  assert.match(html, /Tweak \(derived\)/);
});
