// Reads a runs.jsonl written by "bench.js --attempts 5 --all-rounds" and works
// out what N=1, N=3 and N=5 would have done, using only the attempts that were
// really run: samples 1 to N of each round, stopping at the first round with a
// pass. This is exact, not an estimate, because every round's prompt depends
// only on attempt 1 of the round before.
//
//   node analyse-sampling.mjs path/to/runs.jsonl

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// One task's outcome at a given N, or incomplete when an attempt it needs is
// missing from the log (a stopped run, a model that could not be used).
// rounds is what the bench ran: 3 (the pipeline's maxAttempts) with --no-escalate.
export function simulate(run, n, rounds = 3) {
  let calls = 0, unproven = false;
  for (let r = 1; r <= rounds; r++) {
    const these = run.attempts.filter(a => a.round === r && a.sample <= n).sort((a, b) => a.sample - b.sample);
    calls += these.length;
    const win = these.find(a => a.verdict === 'works');
    if (win) return { status: 'works', round: r, sample: win.sample, calls, reliedOnModelChecks: win.reliedOnModelChecks };
    if (these.length < n) return { status: 'incomplete', round: r, calls };
    if (these.some(a => a.verdict === 'unproven')) unproven = true;
  }
  return { status: unproven ? 'unproven' : 'fail', calls };
}

export function summarise(runs, n) {
  const out = runs.map(run => ({ request: run.request, ...simulate(run, n) }));
  const passed = out.filter(o => o.status === 'works');
  const calls = out.reduce((t, o) => t + o.calls, 0);
  return {
    n, tasks: out.length, passed: passed.length,
    unproven: out.filter(o => o.status === 'unproven').length,
    incomplete: out.filter(o => o.status === 'incomplete').length,
    calls, callsPerTask: out.length ? calls / out.length : null,
    reliedOnModelChecks: passed.filter(o => o.reliedOnModelChecks === true).length,
    perTask: out
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error('Give the runs.jsonl to read: node analyse-sampling.mjs path/to/runs.jsonl'); process.exit(1); }
  const runs = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l))
    
    // A run that never reached the model (the page would not load) stays in, as incomplete.
    .filter(r => r.kind === 'run' && Array.isArray(r.attempts) && r.attempts.every(a => a.sample));
  const maxSample = Math.max(0, ...runs.flatMap(r => r.attempts.map(a => a.sample)));
  console.log(`${runs.length} runs, up to ${maxSample} samples per round, from ${file}\n`);
  const rows = [1, 3, 5].filter(n => n <= maxSample).map(n => summarise(runs, n));
  console.log('| N | Passed | Not proven | Incomplete | Model calls | Calls per task | Passes relying on a model-written check |');
  console.log('|---|---|---|---|---|---|---|');
  for (const s of rows) console.log(`| ${s.n} | ${s.passed} of ${s.tasks} | ${s.unproven} | ${s.incomplete} | ${s.calls} | ${s.callsPerTask.toFixed(1)} | ${s.reliedOnModelChecks} |`);
  console.log('\nPer task (round.sample of the winning attempt, or the outcome):\n');
  console.log(`| Task | ${rows.map(s => 'N=' + s.n).join(' | ')} |`);
  console.log(`|---|${rows.map(() => '---').join('|')}|`);
  runs.forEach((run, i) => console.log(`| ${run.request} | ${rows.map(s => { const o = s.perTask[i]; return o.status === 'works' ? `works ${o.round}.${o.sample}${o.reliedOnModelChecks ? ' (model check)' : ''}` : o.status; }).join(' | ')} |`));
}
