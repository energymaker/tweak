import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate, summarise } from '../analyse-sampling.mjs';

// A 3-round, 5-sample run. verdicts[r][k] is round r+1, sample k+1.
const run = (verdicts, relied = false) => ({ request: 'r', attempts: verdicts.flatMap((row, r) => row.map((v, k) => ({ round: r + 1, sample: k + 1, verdict: v, reliedOnModelChecks: relied }))) });
const F = 'fail', W = 'works', U = 'unproven';

test('each N uses only samples 1 to N and stops at the first round with a pass', () => {
  const r = run([[F, F, F, W, F], [F, F, W, F, F], [W, F, F, F, F]]);
  // Control: the same log gives three different answers, so N is really applied.
  assert.deepEqual(simulate(r, 5), { status: 'works', round: 1, sample: 4, calls: 5, reliedOnModelChecks: false });
  assert.deepEqual(simulate(r, 3), { status: 'works', round: 2, sample: 3, calls: 6, reliedOnModelChecks: false });
  assert.deepEqual(simulate(r, 1), { status: 'works', round: 3, sample: 1, calls: 3, reliedOnModelChecks: false });
});

test('no pass is a fail, or not proven if a check only passed without proving anything', () => {
  assert.equal(simulate(run([[F, F, F], [F, F, F], [F, F, F]]), 3).status, 'fail');
  assert.equal(simulate(run([[F, U, F], [F, F, F], [F, F, F]]), 3).status, 'unproven');
  assert.equal(simulate(run([[F, U, F], [F, F, F], [F, F, F]]), 1).status, 'fail');
});

test('a missing attempt makes the task incomplete instead of a guess', () => {
  assert.equal(simulate(run([[F, F, F], [F]]), 3).status, 'incomplete');
  assert.equal(simulate(run([[F, F, F], [F, F, F]]), 3).status, 'incomplete', 'a run cut short after 2 rounds is not a fail');
  // but a pass found before the gap still counts
  assert.equal(simulate(run([[F, W, F], [F]]), 3).status, 'works');
});

test('the summary counts passes, calls and passes that relied on a model check', () => {
  const s = summarise([run([[W, F, F]], true), run([[F, F, F], [F, F, F], [F, F, F]])], 3);
  assert.deepEqual([s.passed, s.calls, s.callsPerTask, s.reliedOnModelChecks], [1, 12, 6, 1]);
});
