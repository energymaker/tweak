// A Minecraft mod as a target. Same promise as the web path: the model writes
// the change, it is applied to a copy, the copy is built and checked, and the
// real project is only touched when the person presses Keep.
//
// A target gives four things: plan (what the model sees), apply (write the
// change into a copy), build, and test (checks that prove the change landed).

import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// Folders a build makes or a game run fills. Never copied, never read.
const SKIP = new Set(['build', '.gradle', 'run', 'out', '.idea', '.git', 'bin']);
const EDITABLE = /^src\/main\/(java\/[\w/$.-]+\.java|resources\/[\w/.-]+\.(json|mcmeta|txt))$/;
const BUILD_TIMEOUT = Number(process.env.TWEAK_BUILD_TIMEOUT || 900) * 1000;

// Code a mod has no reason to run when it is asked for a small change.
export const BLOCKED = [
  [/\bProcessBuilder\b|Runtime\s*\.\s*getRuntime\s*\(\s*\)\s*\.\s*exec/, 'starts other programs'],
  [/\bjava\.net\.|HttpClient|URLConnection|\bnew\s+Socket\b/, 'makes network connections'],
  [/System\s*\.\s*exit\s*\(/, 'shuts the game down (System.exit)'],
  [/Files\s*\.\s*(delete|deleteIfExists)\s*\(|\.delete\s*\(\s*\)/, 'deletes files'],
  [/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/, 'has a loop that never ends']
];

const readText = f => fs.readFile(f, 'utf8');
const props = text => Object.fromEntries(text.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const classFile = javaPath => javaPath.replace(/^src\/main\/java\//, '').replace(/\.java$/, '.class');

// Where the project is and what it is. Throws a plain sentence if it is not a
// Fabric mod we can build.
export async function detect(dir) {
  dir = path.resolve(String(dir || ''));
  if (!existsSync(dir)) throw new Error(`There is no folder at ${dir}.`);
  if (!existsSync(path.join(dir, 'gradlew.bat')) && !existsSync(path.join(dir, 'gradlew'))) throw new Error(`${dir} has no gradlew, so it cannot be built.`);
  const modJson = path.join(dir, 'src', 'main', 'resources', 'fabric.mod.json');
  if (!existsSync(modJson)) throw new Error(`${dir} has no src/main/resources/fabric.mod.json, so it is not a Fabric mod.`);
  const mod = JSON.parse(await readText(modJson));
  const gp = existsSync(path.join(dir, 'gradle.properties')) ? props(await readText(path.join(dir, 'gradle.properties'))) : {};
  const main = (mod.entrypoints && mod.entrypoints.main || [])[0];
  const client = (mod.entrypoints && mod.entrypoints.client || [])[0];
  const javaOf = entry => entry ? 'src/main/java/' + String(typeof entry === 'string' ? entry : entry.value).split('::')[0].replace(/\./g, '/') + '.java' : '';
  return {
    dir, modId: mod.id, name: mod.name || mod.id, loader: 'Fabric',
    minecraft: gp.minecraft_version || (mod.depends && mod.depends.minecraft) || 'unknown',
    loaderVersion: gp.loader_version || '', fabricApi: gp.fabric_api_version || '',
    mainClass: javaOf(main), clientClass: javaOf(client)
  };
}

async function listFiles(dir, rel = '') {
  const out = [];
  for (const d of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
    if (SKIP.has(d.name)) continue;
    const r = rel ? rel + '/' + d.name : d.name;
    if (d.isDirectory()) out.push(...await listFiles(dir, r));
    else out.push(r);
  }
  return out;
}

// What the model sees, the equivalent of the page summary.
export async function plan(info) {
  const files = (await listFiles(info.dir, 'src')).map(f => 'src/' + f.slice(4));
  const show = async rel => rel && existsSync(path.join(info.dir, rel)) ? `\n--- ${rel} ---\n${await readText(path.join(info.dir, rel))}\n` : '';
  return `Mod "${info.name}" (id ${info.modId}), ${info.loader} loader ${info.loaderVersion}, Minecraft ${info.minecraft}, Fabric API ${info.fabricApi}.

Files in the project:
${files.map(f => '- ' + f).join('\n')}
${await show(info.mainClass)}${await show('src/main/resources/fabric.mod.json')}`;
}

// A throwaway copy of the project, without anything a build makes.
export async function copy(from, to) {
  await fs.cp(from, to, { recursive: true, filter: src => !SKIP.has(path.basename(src)) || path.resolve(src) === path.resolve(from) });
  return to;
}

// Checks the model's files before anything is written. Returns a problem
// sentence, or '' when they are fine.
export function problemWith(files) {
  if (!Array.isArray(files) || !files.length) return 'The model changed no files.';
  for (const f of files) {
    const p = String(f && f.path || '');
    if (!EDITABLE.test(p) || p.includes('..')) return `"${p}" is not a file Tweak lets the model write. Only .java files under src/main/java and .json, .mcmeta or .txt files under src/main/resources.`;
    if (typeof f.content !== 'string' || !f.content.trim()) return `"${p}" came back empty.`;
    const bad = BLOCKED.filter(([re]) => re.test(f.content)).map(([, why]) => why);
    if (bad.length) return `Blocked for safety: ${p} ${bad.join(', ')}.`;
    if (p.endsWith('.json')) { try { JSON.parse(f.content); } catch (e) { return `${p} is not valid JSON: ${e.message}`; } }
  }
  return '';
}

// Write the change into a copy. Returns what each file looked like before, so
// the next attempt can start from the original again.
export async function apply(workDir, files) {
  const before = [];
  for (const f of files) {
    const target = path.join(workDir, ...f.path.split('/'));
    if (!path.resolve(target).startsWith(path.resolve(workDir) + path.sep)) throw new Error(`"${f.path}" points outside the project.`);
    before.push({ path: f.path, content: existsSync(target) ? await readText(target) : null });
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, f.content);
  }
  return before;
}

// Put a copy back the way it was before apply.
export async function undo(workDir, before) {
  for (const b of before) {
    const target = path.join(workDir, ...b.path.split('/'));
    if (b.content === null) await fs.rm(target, { force: true });
    else await fs.writeFile(target, b.content);
  }
}

// Run gradlew in a project folder. Resolves with the exit code and the output.
function gradle(dir, args, signal) {
  return new Promise(resolve => {
    const bat = process.platform === 'win32';
    const child = bat
      ? spawn(`"${path.join(dir, 'gradlew.bat')}" ${args.map(a => `"${a}"`).join(' ')}`, { cwd: dir, shell: true, windowsHide: true })
      : spawn('./gradlew', args, { cwd: dir });
    let log = '';
    const keep = d => { log += d; if (log.length > 400000) log = log.slice(-200000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const stop = () => { try { bat ? spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }) : child.kill(); } catch {} };
    const timer = setTimeout(() => { log += `\nGradle took longer than ${BUILD_TIMEOUT / 1000}s and was stopped.`; stop(); }, BUILD_TIMEOUT);
    if (signal) signal.addEventListener('abort', stop, { once: true });
    child.on('error', e => { clearTimeout(timer); resolve({ code: null, log: log + '\nGradle could not start: ' + e.message }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, log }); });
  });
}

// The verdict is Gradle's exit code, never its chatter. The errors are pulled
// out so the model can be told exactly what broke.
export async function build(dir, signal) {
  const { code, log } = await gradle(dir, ['build', '--console=plain', '--warning-mode=none'], signal);
  return { ok: code === 0, code, log, errors: code === 0 ? '' : buildErrors(log) };
}

export function buildErrors(log) {
  const lines = log.split(/\r?\n/);
  const blocks = [];
  lines.forEach((l, i) => {
    if (!/\.java:\d+: error:/.test(l)) return;
    const more = lines.slice(i + 1, i + 5).filter((x, k) => k < 2 || /^\s*(symbol|location):/.test(x));
    blocks.push([l.replace(/^.*?src[\\/]main[\\/]java[\\/]/, 'src/main/java/').replace(/\\/g, '/'), ...more].map(x => x.trimEnd()).join('\n'));
  });
  if (blocks.length) return [...new Set(blocks)].slice(0, 10).join('\n');
  const wrong = lines.findIndex(l => /What went wrong/.test(l));
  if (wrong >= 0) return lines.slice(wrong + 1, wrong + 12).filter(l => l.trim()).join('\n');
  return lines.filter(l => l.trim()).slice(-15).join('\n');
}

// Class names inside a jar, read from the zip's central directory. Nothing is
// unzipped, so the 47,000 classes of Minecraft and Fabric index in a blink.
function jarClasses(file) {
  const b = readFileSync(file);
  let e = b.length - 22;
  while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) return [];
  let p = b.readUInt32LE(e + 16);
  const out = [];
  while (p + 46 <= b.length && b.readUInt32LE(p) === 0x02014b50) {
    const n = b.readUInt16LE(p + 28), x = b.readUInt16LE(p + 30), c = b.readUInt16LE(p + 32);
    const name = b.toString('utf8', p + 46, p + 46 + n);
    if (name.endsWith('.class')) out.push(name.slice(0, -6));
    p += 46 + n + x + c;
  }
  return out;
}

const CLASSPATH_SCRIPT = `allprojects {
  tasks.register('tweakClasspath') {
    def files = project.provider { project.sourceSets.main.compileClasspath.files }
    doLast { files.get().each { println "TWEAKCP " + it } }
  }
}
`;

// Every class the mod can use, from its own compile classpath. This is the
// equivalent of "selectors that do exist on the page": the real names.
export async function api(dir, signal) {
  const script = path.join(dir, '.tweak-classpath.gradle');
  await fs.writeFile(script, CLASSPATH_SCRIPT);
  const { code, log } = await gradle(dir, ['-q', '--init-script', script, 'tweakClasspath'], signal);
  await fs.rm(script, { force: true });
  if (code !== 0) throw new Error('Gradle could not list the libraries the mod uses.');
  const bySimple = new Map();
  for (const jar of log.split(/\r?\n/).filter(l => l.startsWith('TWEAKCP ')).map(l => l.slice(8).trim())) {
    if (!jar.endsWith('.jar') || !existsSync(jar)) continue;
    for (const c of jarClasses(jar)) {
      if (/\/(impl|mixin)\//.test(c) || /\$\d/.test(c) || c.endsWith('package-info')) continue;
      const fqn = c.replace(/\//g, '.').replace(/\$/g, '.');
      const simple = fqn.slice(fqn.lastIndexOf('.') + 1);
      if (!bySimple.has(simple)) bySimple.set(simple, []);
      bySimple.get(simple).push({ fqn, bin: c.replace(/\//g, '.'), jar });
    }
  }
  const gp = existsSync(path.join(dir, 'gradle.properties')) ? props(await readText(path.join(dir, 'gradle.properties'))) : {};
  const home = gp['org.gradle.java.home'] || process.env.JAVA_HOME || '';
  const javap = home ? path.join(home, 'bin', process.platform === 'win32' ? 'javap.exe' : 'javap') : 'javap';
  // Names the project already imports win: its Logger is slf4j's, not log4j's.
  const used = new Set();
  for (const f of (await listFiles(dir, 'src/main/java')).filter(f => f.endsWith('.java'))) {
    for (const m of (await readText(path.join(dir, f))).matchAll(/^import\s+([\w.]+)\s*;/gm)) used.add(m[1]);
  }
  return { bySimple, javap, used };
}

// Old names models learned from earlier Minecraft versions (Yarn), and what
// they are called now. Only suggested when the new name really is on the
// classpath, so a wrong entry here can never mislead.
const RENAMED = { ItemGroup: 'CreativeModeTab', ItemGroups: 'CreativeModeTabs', ItemGroupEvents: 'CreativeModeTabEvents', Settings: 'Properties', Text: 'Component', MinecraftClient: 'Minecraft', PlayerEntity: 'Player', ServerPlayerEntity: 'ServerPlayer', World: 'Level', ServerWorld: 'ServerLevel', RegistryKey: 'ResourceKey', RegistryKeys: 'Registries', Formatting: 'ChatFormatting', Hand: 'InteractionHand', ActionResult: 'InteractionResult', ResourceLocation: 'Identifier' };

// Public members of a class, from javap, trimmed to what fits in a prompt.
const javapCache = new Map();
function javap(a, entry) {
  if (!javapCache.has(entry.bin)) {
    const r = spawnSync(a.javap, ['-public', '-cp', entry.jar, entry.bin], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    javapCache.set(entry.bin, r.status === 0 && r.stdout ? r.stdout.split(/\r?\n/).filter(l => /^\s+(public|static|final)/.test(l)).map(l => l.trim().replace(/\$/g, '.').replace(/\b([a-z]\w*\.)+(?=[A-Z])/g, '')) : []);
  }
  return javapCache.get(entry.bin);
}

// Java's own classes are not in the mod's libraries, so ask javap directly.
const JAVA_PACKAGES = ['java.util', 'java.util.function', 'java.io', 'java.nio.file', 'java.time'];
function fromJava(a, name) {
  for (const pkg of JAVA_PACKAGES) if (javap(a, { bin: `${pkg}.${name}`, jar: '.' }).length) return `${pkg}.${name}`;
  return '';
}

// Minecraft and Fabric first, then the mod's other libraries.
const rank = e => /^net\.minecraft\./.test(e.fqn) ? 0 : /^net\.fabricmc\.fabric\.api\./.test(e.fqn) ? 1 : /^com\.mojang\./.test(e.fqn) ? 2 : 3;
function real(a, name) {
  const mine = e => (a.used && a.used.has(e.fqn) ? -10 : 0);
  const all = (a.bySimple.get(name) || []).slice().sort((x, y) => mine(x) + rank(x) - mine(y) - rank(y));
  const best = all.filter(e => rank(e) < 3);
  return best.length ? best : all;
}
const nestedEntries = (a, owner) => [...a.bySimple.values()].flat().filter(e => e.fqn.startsWith(owner.fqn + '.') && !e.fqn.slice(owner.fqn.length + 1).includes('.'));
const nested = (a, owner) => nestedEntries(a, owner).map(e => e.fqn.split('.').pop());
const isClassName = n => /^[A-Z][a-z]\w*$/.test(n) || /^[A-Z][A-Z]?[a-z]\w*$/.test(n);

// Classes whose names match the words of the request, the way the page summary
// lists the elements that match. Fabric API hooks come first, with their real
// signatures, because those are what a small change usually needs.
const STOP = new Set(['that', 'this', 'with', 'from', 'into', 'when', 'what', 'called', 'appears', 'make', 'called', 'add', 'have', 'should', 'there', 'which']);
export function matching(request, a) {
  const words = [...new Set((String(request).toLowerCase().match(/[a-z]{4,}/g) || []).filter(w => !STOP.has(w)).map(w => w.replace(/s$/, '')))];
  if (!words.length) return '';
  // A word found in few class names (creative) says more than one found in
  // hundreds (item), so each word counts by how rare it is.
  const names = [...a.bySimple.keys()].map(n => n.toLowerCase());
  const weight = Object.fromEntries(words.map(w => [w, Math.log(names.length / (1 + names.filter(n => n.includes(w)).length))]));
  const scored = [];
  for (const [name, entries] of a.bySimple) {
    const low = name.toLowerCase();
    const score = words.reduce((t, w) => t + (low.includes(w) ? weight[w] : 0), 0);
    if (!score) continue;
    // nested classes are often private, so only Fabric API's are listed
    for (const e of entries) if (rank(e) < 3 && !/\.(client\.)?(gui|render)/.test(e.fqn) && (rank(e) === 1 || e.fqn === e.bin)) scored.push({ e, score });
  }
  scored.sort((x, y) => y.score - x.score || (rank(x.e) === 1 ? -1 : 0) - (rank(y.e) === 1 ? -1 : 0) || x.e.fqn.length - y.e.fqn.length);
  const top = scored.slice(0, 12).map(s => s.e);
  if (!top.length) return '';
  return '\nClasses in Minecraft and Fabric API whose names match the request. These names are real, use them exactly:\n' + top.map(e => {
    // Fabric hooks take a callback; show its one method so the lambda has the right shape.
    const callbacks = rank(e) === 1 ? nestedEntries(a, e).map(n => javap(a, n).filter(l => /\babstract\b/.test(l)).map(l => `${n.fqn.split('.').pop()}: ${l}`)[0]).filter(Boolean).slice(0, 3) : [];
    const sig = rank(e) === 1 ? [...javap(a, e).filter(l => /\bstatic\b|\binterface\b|\bvoid\b/.test(l)).slice(0, 4), ...callbacks] : [];
    return `- ${e.fqn}${sig.length ? '\n    ' + sig.join('\n    ') : ''}`;
  }).join('\n') + '\n';
}

// Reads javac's complaints and answers each with the real names, the way the
// web path answers a missing selector with the selectors that do exist.
export function hints(log, a) {
  const out = new Set(), show = new Set();
  const lines = log.split(/\r?\n/);
  const say = s => out.add(s);
  const missingClass = name => {
    const found = real(a, name), renamed = RENAMED[name] && real(a, RENAMED[name]);
    const java = (!found.length || (rank(found[0]) >= 2 && !a.used.has(found[0].fqn))) && fromJava(a, name);
    if (java) say(`${name} is ${java}, from Java itself. Import it by that full name.`);
    else if (found.length) say(`${name} is ${found.slice(0, 2).map(e => e.fqn).join(' or ')}. Import it by that full name.`);
    else if (renamed && renamed.length) { say(`There is no ${name} in this version. It is now ${renamed[0].fqn}.`); show.add(renamed[0]); }
    else say(`There is no class called ${name} anywhere in this mod's libraries. Do not use it.`);
  };
  lines.forEach((l, i) => {
    let m;
    // import a.b.Name; after "package does not exist" or "cannot find symbol"
    if (/package [\w.]+ does not exist|cannot find symbol/.test(l) && (m = (lines[i + 1] || '').match(/^\s*import\s+(?:static\s+)?[\w.]+\.([A-Z]\w*)\s*;/))) missingClass(m[1]);
    if (!(m = l.match(/^\s*symbol:\s+(class|variable|method)\s+(\w+)/))) return;
    const [, kind, name] = m;
    const loc = (lines[i + 1] || '').match(/location:\s+(?:class|interface|variable \w+ of type)\s+([\w.<>]+)/);
    const owner = loc && loc[1].replace(/<.*$/, '').split('.').pop();
    const ownerEntry = owner && real(a, owner)[0];
    if (!ownerEntry) {
      if (kind !== 'method' && isClassName(name)) missingClass(name);
      return;
    }
    if (kind === 'class') {
      // Item.Settings: a nested class that does not exist
      const inner = nested(a, ownerEntry), rn = RENAMED[name];
      if (rn && inner.includes(rn)) say(`${owner}.${name} does not exist in this version. Use ${owner}.${rn}.`);
      else say(`${owner} has no ${name}. What ${owner} does contain: ${inner.slice(0, 12).join(', ') || 'nothing nested'}.`);
      if (rn && inner.includes(rn)) { const e = real(a, rn).find(x => x.fqn === ownerEntry.fqn + '.' + rn); if (e) show.add(e); }
      return;
    }
    // A missing field or method: maybe it lives on a sibling class, such as
    // CreativeModeTabs.INGREDIENTS instead of CreativeModeTab.INGREDIENTS.
    const stem = owner.replace(/(ies|y|s)$/, ''), ends = new RegExp(stem + '(y|ies|s)?$');
    // DefaultedRegistry's missing register() lives on Registry, the end of its name
    const siblings = [...a.bySimple.keys()].filter(k => k !== owner && ((k.includes(stem) && k.length <= owner.length + 10) || (kind === 'method' && k.length >= 4 && owner.endsWith(k)))).sort((x, y) => !ends.test(x) - !ends.test(y) || x.length - y.length).flatMap(k => real(a, k)).filter(e => rank(e) < 2).slice(0, 20);
    // Several classes can have it (Registries.ITEM is a key, BuiltInRegistries.ITEM
    // the registry), so give each with its real declaration and let the model pick.
    const homes = siblings.map(e => ({ e, decl: javap(a, e).filter(x => new RegExp(`[ .]${name}[;(]`).test(x)).slice(0, 3).join('\n    ') })).filter(h => h.decl).slice(0, 3);
    if (homes.length) say(`${owner} has no ${name}. It exists as:\n${homes.map(h => `  ${h.e.fqn}: ${h.decl}`).join('\n')}`);
    else { say(`${owner} has no ${kind === 'method' ? 'method' : 'field'} called ${name}.`); show.add(ownerEntry); }
  });
  const list = [...out];
  for (const e of [...show].slice(0, 3)) {
    const m = javap(a, e);
    if (m.length) list.push(`What ${e.fqn} really has:\n  ${m.slice(0, 60).join('\n  ')}`);
  }
  return list.join('\n');
}

// Where a changed file ends up after a build.
function builtPath(dir, rel) {
  return rel.startsWith('src/main/java/')
    ? path.join(dir, 'build', 'classes', 'java', 'main', ...classFile(rel).split('/'))
    : path.join(dir, 'build', 'resources', 'main', ...rel.replace(/^src\/main\/resources\//, '').split('/'));
}

async function same(a, b) {
  if (!existsSync(a) || !existsSync(b)) return false;
  return (await fs.readFile(a)).equals(await fs.readFile(b));
}

// The checks, written by us from the files the model changed, never by the
// model. For each changed file: is it in the build output, and is it different
// from what the original project builds. Before the change the second is false,
// so a passing check proves the change was compiled in. The game is not
// started, and the result says so.
export async function test(original, workDir, files, built) {
  const checks = [{ type: 'builds', selector: 'gradlew build', before: true, beforeDetail: 'the project built before the change', after: built.ok, afterDetail: built.ok ? 'exit code 0' : `exit code ${built.code}` }];
  for (const f of files) {
    const mine = builtPath(workDir, f.path), theirs = builtPath(original, f.path);
    const what = f.path.startsWith('src/main/java/') ? classFile(f.path) : f.path.replace(/^src\/main\/resources\//, '');
    const hadOriginal = existsSync(theirs);
    const inBuild = built.ok && existsSync(mine);
    const changed = inBuild && !(await same(mine, theirs));
    checks.push({
      type: 'inBuild', selector: what,
      before: false, beforeDetail: hadOriginal ? 'the original build has the old version' : 'not in the original build',
      after: changed, afterDetail: !built.ok ? 'not built' : !inBuild ? 'missing from the build' : changed ? 'the new version is in the build' : 'identical to the original, so the change did nothing'
    });
  }
  const allPass = checks.every(c => c.after), proved = checks.some(c => c.after && !c.before);
  return { checks, verdict: allPass && proved ? 'works' : 'fail', notTested: 'The game was not started, so this proves the mod compiles with the change in it, not that it behaves in game.' };
}

// Keep: write the changed files into the real project, but only if nobody
// changed those files since the run read them. The old versions are saved in
// the run folder first, so a keep can always be undone by hand.
export async function keep(projectDir, files, originals, backupDir) {
  for (const o of originals) {
    const target = path.join(projectDir, ...o.path.split('/'));
    const now = existsSync(target) ? await readText(target) : null;
    if (now !== o.content) throw new Error(`${o.path} changed in your project since this run started, so Tweak did not overwrite it. Run the request again.`);
  }
  await fs.mkdir(backupDir, { recursive: true });
  await fs.writeFile(path.join(backupDir, 'before.json'), JSON.stringify(originals, null, 2));
  for (const f of files) {
    const target = path.join(projectDir, ...f.path.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, f.content);
  }
  return files.map(f => f.path);
}
