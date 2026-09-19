// Runs the tasks in bench/tasks.json through the same pipeline as the app and
// writes a results table. Every number in it is measured.
//
//   npm run bench                              every model found in Ollama
//   npm run bench -- ollama:qwen3:8b           one model
//   npm run bench -- --tasks 3 ollama:qwen3:8b just the first 3 tasks
//
// Options: --tasks N, --timeout SECONDS (per task, default 300), --tasks-file path,
// --attempts N (1 to 5 samples per round, at temperatures 0.2 x k, default 1),
// --no-escalate (never hand over to the bigger model, for local-only numbers),
// --all-rounds (run every round even after a pass, and learn nothing between
// tasks, so smaller N can be simulated from the log afterwards)

import fs from 'node:fs/promises';
import { HOME, runTweak } from './lib/pipeline.js';
import { listModels } from './lib/model.js';
import { sweepProfiles } from './lib/browser.js';
import { forcedSection } from './analyse-sampling.mjs';
await sweepProfiles();

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf('--' + name); if (i === -1) return fallback; const v = args[i + 1]; args.splice(i, 2); return v; };
const limit = Number(opt('tasks', 0));
const taskTimeout = Number(opt('timeout', 300)) * 1000;
const tasksFile = opt('tasks-file', process.env.TWEAK_TASKS || 'bench/tasks.json');
const fallback = opt('fallback', process.env.TWEAK_FALLBACK_MODEL || '');
const attempts = Number(opt('attempts', 1));
if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) { console.error('--attempts must be a whole number from 1 to 5.'); process.exit(1); }
const escalate = !args.includes('--no-escalate');
if (!escalate) args.splice(args.indexOf('--no-escalate'), 1);
const allRounds = args.includes('--all-rounds');
if (allRounds) args.splice(args.indexOf('--all-rounds'), 1);
// The N=1/3/5 table assumes every round is the local model's; round 3 would be the bigger one's.
if (allRounds && escalate) { console.error('--all-rounds needs --no-escalate.'); process.exit(1); }
const models = args.filter(a => !a.startsWith('--') && /^(ollama|api):/.test(a));

const found = await listModels();
if (!found.ollama.reachable && !found.api.reachable) {
  console.error('\n  No models available. ' + (found.ollama.error || '') + '\n  Start Ollama, then run this again.\n');
  process.exit(1);
}
const useModels = models.length ? models : found.ollama.models.map(m => 'ollama:' + m);
if (!useModels.length) { console.error('No models given and none found. Example: npm run bench -- ollama:qwen3:8b'); process.exit(1); }

let tasks = JSON.parse(await fs.readFile(tasksFile, 'utf8'));
if (limit > 0) tasks = tasks.slice(0, limit);

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const mdFile = `bench-results-${stamp}.md`;
const jsonFile = `bench-results-${stamp}.jsonl`;
// A walled task never reached the real page, so it is neither a pass nor a fail.
const label = { works: 'Works', unproven: 'Not proven', fail: "Didn't work", stopped: 'Stopped', walled: 'Not measured (wall)' };
const rows = [];
const fullRuns = []; // with every attempt, for the --all-rounds table

function save() {
  let md = `# Bench results\n\nStarted ${new Date().toLocaleString('en-GB')}. Every result below was measured by testing the tweak in a real browser.\n\n`;
  for (const model of useModels) {
    const mine = rows.filter(r => r.model === model);
    if (!mine.length) continue;
    // Under --all-rounds every run's rounds, tries and time were forced, so only
    // the simulated N=1/3/5 outcome means anything.
    if (allRounds) {
      md += forcedSection(model, attempts, fullRuns.filter(r => r.model === model));
      continue;
    }
    const works = mine.filter(r => r.status === 'works').length;
    const first = mine.filter(r => r.status === 'works' && r.tries === 1).length;
    md += `## ${model}\n\nWorked: ${works} of ${mine.length} (first ${attempts > 1 ? 'round' : 'try'}: ${first}). Not proven: ${mine.filter(r => r.status === 'unproven').length}. Not measured (the page was a wall): ${mine.filter(r => r.status === 'walled').length}. Stopped: ${mine.filter(r => r.status === 'stopped').length}.\n\n`;
    md += `| Task | Site | Result | ${attempts > 1 ? 'Rounds' : 'Tries'} | Seconds | Notes |\n|---|---|---|---|---|---|\n`;
    md += mine.map(r => `| ${r.request} | ${r.host} | ${label[r.status] || r.status}${r.finishedBy ? ' (by ' + r.finishedBy.replace(/^(ollama|api):/, '') + ')' : ''} | ${r.tries} | ${r.seconds} | ${String(r.reason).replace(/\|/g, '/').slice(0, 160)} |`).join('\n') + '\n\n';
  }
  return fs.writeFile(mdFile, md);
}

function runOne(task, model) {
  const started = Date.now();
  let lastStep = 'starting';
  const beat = setInterval(() => process.stdout.write(`      ${Math.round((Date.now() - started) / 1000)}s  still on: ${lastStep}\n`), 20000);
  const ctl = new AbortController();
  const killer = setTimeout(() => ctl.abort(), taskTimeout);
  return runTweak({ ...task, model, fallback, attempts, escalate, allRounds, remember: !allRounds, headless: true, signal: ctl.signal, onEvent: e => {
    if (e.type === 'step') { lastStep = e.label; process.stdout.write(`      ${Math.round(e.at / 1000)}s  ${e.label}\n`); }
    if (e.type === 'attempt' && e.attempt.problem) process.stdout.write(`           ${String(e.attempt.problem).slice(0, 120)}\n`);
  } })
    .then(r => ({ attempts: r.attempts, status: r.status, reason: r.reason, seconds: r.seconds, tries: attempts > 1 ? (r.attempts.at(-1)?.round ?? 0) : r.attempts.length, model: r.model, escalated: r.model !== r.firstModel }))
    .catch(e => ({ status: 'fail', reason: 'The tool itself broke: ' + e.message, seconds: 0, tries: 0 }))
    .finally(() => { clearInterval(beat); clearTimeout(killer); });
}

console.log(`\n  ${useModels.length} model(s), ${tasks.length} task(s). Up to ${taskTimeout / 1000}s per task.`);
console.log(`  Results are saved after every task to ${mdFile}`);
if (attempts > 1) console.log(`  ${attempts} samples per round, at temperatures ${Array.from({ length: attempts }, (_, i) => Math.round((i + 1) * 2) / 10).join(', ')}. Every one is logged in runs.jsonl.`);
if (!escalate) console.log('  Escalation is off: only the model on this computer tries.');
if (allRounds) console.log('  Every round runs even after a pass, and nothing is saved to what-worked.json.');
else if (fallback) console.log(`  If the small model fails twice, ${fallback} takes over.`);
console.log('  The app must be stopped (Ctrl C in the npm start window): both use the same test browser.\n');

for (const model of useModels) {
  for (const [i, t] of tasks.entries()) {
    const host = new URL(t.url).hostname;
    process.stdout.write(`[${model}] ${i + 1}/${tasks.length} ${t.request} (${host})\n`);
    const r = await runOne(t, model);
    console.log(`      => ${label[r.status] || r.status} in ${r.seconds}s${r.escalated ? ' (finished by ' + String(r.model).replace(/^(ollama|api):/, '') + ')' : ''}`);
    if (r.status !== 'works') console.log(`         ${String(r.reason).slice(0, 150)}`);
    if (/consent/i.test(String(r.reason))) console.log(`         Fix it once: stop this, run "npm start", click "Open test browser" with ${host} in the box, accept the cookie page, close that window, stop the app, run the bench again.`);
    console.log('');
    fullRuns.push({ model, request: t.request, attempts: r.attempts || [] });
    rows.push({ model, request: t.request, url: t.url, host, status: r.status, tries: r.tries, seconds: r.seconds, reason: r.reason, finishedBy: r.escalated ? r.model : '' });
    await fs.appendFile(jsonFile, JSON.stringify(rows[rows.length - 1]) + '\n');
    await save();
  }
}
await save();
console.log(`  Done. ${mdFile} has the table, ${jsonFile} has the raw rows, ${HOME} has the screenshots.\n`);

const { app: electronApp } = await import('electron');
electronApp.quit();
