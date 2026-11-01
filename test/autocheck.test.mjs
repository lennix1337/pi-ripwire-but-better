import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { projectChecks, reapStaleHeadTrees, loadRecipes } from '../src/core.ts';
import { createAutocheck } from '../src/autocheck.ts';
import { fixtureRepo } from './fixture.mjs';

const node = (code, extra = {}) => ({ description: 'fixture', argv: [process.execPath, '-e', code], timeoutMs: 20000, ...extra });
const repo = (t, checks) => fixtureRepo(t, checks, { 'src/a.ts': 'one' });

// Records every run so tests can count real executions.
function recorder(store) {
  const runs = [];
  const run = args => { runs.push(args.name); return projectChecks({ ...args, store }); };
  return { runs, run };
}

const settle = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, ms = 15000) {
  const end = Date.now() + ms;
  while (!(await predicate())) { if (Date.now() > end) throw new Error('timed out waiting'); await settle(25); }
}

test('a burst of edits runs each onEdit recipe once and the explicit call reuses it', async t => {
  const f = await repo(t, { quick: node("console.log('quick-ok')", { onEdit: true }), manual: node("console.log('manual')") });
  const { runs, run } = recorder(f.store);
  const auto = createAutocheck({ run, debounceMs: 50 }); t.after(() => auto.dispose());
  for (const text of ['two', 'three', 'four']) { await writeFile(path.join(f.root, 'src/a.ts'), text); await auto.edited(path.join(f.root, 'src/a.ts')); }
  let notes = [];
  await until(async () => (notes = notes.concat((await auto.drainNotes()))).length > 0);
  assert.deepEqual(runs, ['quick']);
  assert.match(notes[0], /\[autocheck\] repo quick passed/);
  const reused = await auto.claim(f.root, 'quick');
  assert.equal(reused.status, 'passed'); assert.match(reused.output, /quick-ok/); assert.ok(reused.reused);
  assert.equal(await auto.claim(f.root, 'manual'), null, 'recipes without onEdit never run speculatively');
  assert.deepEqual(runs, ['quick']);
});

// Pi runs a batch of tool calls concurrently, so their tool_result hooks overlap (seen live 2026-10-24: two
// parallel edits in pi-optchat produced no autocheck at all, the same edits in sequence did).
test('concurrent edits from one tool batch still run the onEdit recipes once', async t => {
  const f = await repo(t, { quick: node("console.log('quick-ok')", { onEdit: true }) });
  const { runs, run } = recorder(f.store);
  const auto = createAutocheck({ run, debounceMs: 50 }); t.after(() => auto.dispose());
  const file = path.join(f.root, 'src/a.ts');
  await writeFile(file, 'two');
  await Promise.all([auto.edited(file), auto.edited(file)]);
  let notes = [];
  await until(async () => (notes = notes.concat((await auto.drainNotes()))).length > 0);
  assert.deepEqual(runs, ['quick']);
  assert.ok((await auto.claim(f.root, 'quick')).reused);
});

test('a run whose sources change without a new edit is reported, not dropped', async t => {
  const f = await repo(t, { quick: node("require('fs').writeFileSync('src/generated.ts', String(Date.now()))", { onEdit: true }) });
  const auto = createAutocheck({ run: recorder(f.store).run, debounceMs: 20 }); t.after(() => auto.dispose());
  await auto.edited(path.join(f.root, 'src/a.ts'));
  let notes = [];
  await until(async () => (notes = notes.concat((await auto.drainNotes()))).length > 0);
  assert.match(notes[0], /\[autocheck\] repo quick ended source_changed \(receipt [\w-]+\); nothing to reuse/);
});

test('a result is not reused once the sources change', async t => {
  const f = await repo(t, { quick: node("console.log('ok')", { onEdit: true }) });
  const auto = createAutocheck({ run: recorder(f.store).run, debounceMs: 20 }); t.after(() => auto.dispose());
  await auto.edited(path.join(f.root, 'src/a.ts'));
  await until(async () => (await auto.drainNotes()).length > 0);
  await writeFile(path.join(f.root, 'src/b.ts'), 'untracked change after the run');
  assert.equal(await auto.claim(f.root, 'quick'), null);
});

// Seen live 2026-10-30: a typecheck note said "passed on the current sources" for code tsc rejected, because the run
// had finished on the sources before the change that was being reported on.
test('a note from a run whose sources changed afterwards does not claim the current sources', async t => {
  const f = await repo(t, { quick: node("console.log('ok')", { onEdit: true }) });
  let done = false;
  const run = args => projectChecks({ ...args, store: f.store }).finally(() => { done = true; });
  const auto = createAutocheck({ run, debounceMs: 20 }); t.after(() => auto.dispose());
  await auto.edited(path.join(f.root, 'src/a.ts'));
  await until(() => done);
  await settle(50);
  await writeFile(path.join(f.root, 'src/a.ts'), 'changed by a shell command after the run');
  const notes = await auto.drainNotes();
  assert.equal(notes.length, 1);
  assert.doesNotMatch(notes[0], /current sources/);
  assert.match(notes[0], /\[autocheck\] repo quick passed .*sources that have changed since/);
});

test('a run that finishes after a newer edit superseded it leaves no note of its own', async t => {
  const f = await repo(t, { quick: node("console.log('ok')", { onEdit: true }) });
  let finished = 0;
  // A process that completes despite the abort: the run ignores the signal and resolves late.
  const run = ({ signal, ...args }) => settle(300).then(() => projectChecks({ ...args, store: f.store })).finally(() => { finished += 1; });
  const auto = createAutocheck({ run, debounceMs: 20 }); t.after(() => auto.dispose());
  const file = path.join(f.root, 'src/a.ts');
  await auto.edited(file);
  await settle(100);
  await auto.edited(file);
  await until(() => finished === 2);
  await settle(50);
  assert.equal((await auto.drainNotes()).length, 1, 'only the run on the latest edit reports');
});

test('failures are reported in the next note with their output', async t => {
  const f = await repo(t, { types: node("console.error('src/a.ts(1,1): error TS2304'); process.exit(2)", { onEdit: true }) });
  const auto = createAutocheck({ run: recorder(f.store).run, debounceMs: 20 }); t.after(() => auto.dispose());
  await auto.edited(path.join(f.root, 'src/a.ts'));
  let notes = [];
  await until(async () => (notes = (await auto.drainNotes())).length > 0);
  assert.match(notes[0], /types FAILED \(exit 2/); assert.match(notes[0], /TS2304/);
  assert.deepEqual((await auto.drainNotes()), [], 'a note is delivered once');
});

test('an edit during a run cancels it, and the rerun starts after the lock is free', async t => {
  const f = await repo(t, { slow: node("setTimeout(()=>console.log('slow-ok'),1500)", { onEdit: true }) });
  const { runs, run } = recorder(f.store);
  const auto = createAutocheck({ run, debounceMs: 20 }); t.after(() => auto.dispose());
  await auto.edited(path.join(f.root, 'src/a.ts'));
  await until(async () => runs.length === 1); await settle(300);
  await writeFile(path.join(f.root, 'src/a.ts'), 'edited mid-run'); await auto.edited(path.join(f.root, 'src/a.ts'));
  let notes = [];
  await until(async () => (notes = notes.concat((await auto.drainNotes()))).length > 0);
  assert.equal(runs.length, 2); assert.equal(notes.length, 1); assert.match(notes[0], /slow passed/);
  assert.deepEqual((await readdir(f.store)).filter(x => x.endsWith('.active')), [], 'the cancelled speculative run left no uncertainty marker');
});

test('an explicit request for another check stops the speculative run and gets the lock', async t => {
  const f = await repo(t, { slow: node('setInterval(()=>{},100)', { onEdit: true }), other: node("console.log('other-ok')") });
  const { runs, run } = recorder(f.store);
  const auto = createAutocheck({ run, debounceMs: 20 }); t.after(() => auto.dispose());
  await auto.edited(path.join(f.root, 'src/a.ts'));
  await until(async () => runs.length === 1); await settle(300);
  assert.equal(await auto.claim(f.root, 'other'), null);
  const explicit = await projectChecks({ root: f.root, name: 'other', store: f.store });
  assert.equal(explicit.status, 'passed');
});

// A sweep that was waiting for the cancelled run of the previous edit used to reset its own state once that run
// exited, which undid the cancellation of the explicit request that arrived meanwhile and started a speculative run
// the explicit check had been promised the lock against.
test('a sweep waiting for a cancelled run does not start once an explicit check has claimed the repository', async t => {
  const root = path.resolve('/virtual/repo');
  const calls = []; let exitCancelledRun;
  const run = args => {
    calls.push(args.name);
    if (calls.length === 1) return new Promise(resolve => { exitCancelledRun = () => resolve({ status: 'cancelled', id: 'first' }); });
    return Promise.resolve({ status: 'passed', id: `run-${calls.length}`, unchanged: true, after: { digest: 'd' }, recipeDigest: 'r', elapsedMs: 1, root, name: args.name, output: '' });
  };
  const recipes = { config: { checks: { unit: { onEdit: true }, other: {} } }, digest: 'r' };
  const auto = createAutocheck({ run, rootOf: async () => root, recipesOf: async () => recipes, fingerprintOf: async () => ({ digest: 'd' }), debounceMs: 10 });
  t.after(() => auto.dispose());
  const file = path.join(root, 'src/a.ts');
  await auto.edited(file);
  await until(() => calls.length === 1);
  await auto.edited(file); // cancels the first run; the second sweep now waits for it to exit
  await settle(60);
  const claimed = auto.claim(root, 'other');
  exitCancelledRun();
  assert.equal(await claimed, null);
  await settle(60);
  assert.deepEqual(calls, ['unit'], 'no speculative run starts after the explicit check claimed the repository');
});

test('reusing a finished result leaves the next speculative check running; fresh asks for the lock', async t => {
  const f = await repo(t, { quick: node("console.log('quick')", { onEdit: true }), slow: node("setTimeout(()=>console.log('slow-ok'),1200)", { onEdit: true }) });
  const { runs, run } = recorder(f.store);
  const auto = createAutocheck({ run, debounceMs: 20 }); t.after(() => auto.dispose());
  await auto.edited(path.join(f.root, 'src/a.ts'));
  await until(async () => runs.length === 2);
  assert.equal((await auto.claim(f.root, 'quick')).status, 'passed');
  assert.equal((await auto.claim(f.root, 'slow')).status, 'passed', 'the slow run was awaited, not cancelled');
  assert.deepEqual(runs, ['quick', 'slow']);
  assert.equal(await auto.claim(f.root, 'quick', { fresh: true }), null);
});

test('watch prefixes limit which edits trigger a recipe; files outside a repository are ignored', async t => {
  const f = await repo(t, { docs: node("console.log('docs')", { onEdit: true, watch: ['docs'] }) });
  const { runs, run } = recorder(f.store);
  const auto = createAutocheck({ run, debounceMs: 10 }); t.after(() => auto.dispose());
  await auto.edited(path.join(f.root, 'src/a.ts'));
  await auto.edited(path.join(os.tmpdir(), 'not-a-repo-file.txt'));
  await settle(200);
  assert.deepEqual(runs, []);
  await mkdir(path.join(f.root, 'docs')); await auto.edited(path.join(f.root, 'docs/x.md'));
  await until(async () => runs.length === 1);
});

test('a repository without recipes runs nothing and tells the agent once', async t => {
  const f = await repo(t, {});
  await rm(path.join(f.root, '.pi'), { recursive: true });
  const { runs, run } = recorder(f.store);
  const auto = createAutocheck({ run, debounceMs: 10 }); t.after(() => auto.dispose());
  await auto.edited(path.join(f.root, 'src/a.ts'));
  await auto.edited(path.join(f.root, 'src/a.ts'));
  await settle(100);
  assert.deepEqual(runs, []);
  const notes = (await auto.drainNotes());
  assert.equal(notes.length, 1);
  assert.match(notes[0], /\[autocheck\] repo has no \.pi\/checks\.json/);
  await auto.edited(path.join(f.root, 'src/a.ts'));
  assert.deepEqual((await auto.drainNotes()), []);
});

test('a malformed recipe file still reaches the user', async t => {
  const f = await repo(t, {});
  await writeFile(path.join(f.root, '.pi/checks.json'), '{"version": 2}');
  const auto = createAutocheck({ debounceMs: 10 }); t.after(() => auto.dispose());
  await assert.rejects(auto.edited(path.join(f.root, 'src/a.ts')), /Expected recipe version 1/);
});

test('recipe validation rejects malformed onEdit and watch entries', async t => {
  const f = await repo(t, { a: node('1', { onEdit: 'yes' }) });
  await assert.rejects(loadRecipes(f.root), /onEdit must be a boolean/);
  await writeFile(path.join(f.root, '.pi/checks.json'), JSON.stringify({ version: 1, checks: { a: node('1', { watch: ['../outside'] }) } }));
  await assert.rejects(loadRecipes(f.root), /watch must list/);
  await writeFile(path.join(f.root, '.pi/checks.json'), JSON.stringify({ version: 1, checks: { a: node('1') } }));
  await assert.rejects(projectChecks({ root: f.root, name: 'a', store: f.store, speculative: true }), /not marked onEdit/);
});

test('a speculative marker from a dead process is cleared; any other marker still blocks', async t => {
  const f = await repo(t, { quick: node("console.log('ok')", { onEdit: true }) });
  await projectChecks({ root: f.root, name: 'quick', store: f.store });
  const marker = path.join(f.store, `${createHash('sha256').update(f.root).digest('hex')}.active`);
  const deadPid = 2 ** 22 + 12345;
  await writeFile(marker, JSON.stringify({ pid: deadPid, name: 'quick', speculative: true }));
  assert.equal((await projectChecks({ root: f.root, name: 'quick', store: f.store })).status, 'passed');
  await writeFile(marker, JSON.stringify({ pid: deadPid, name: 'quick' }));
  await assert.rejects(projectChecks({ root: f.root, name: 'quick', store: f.store }), /outcome uncertain/);
  await writeFile(marker, JSON.stringify({ pid: process.pid, name: 'quick', speculative: true }));
  await assert.rejects(projectChecks({ root: f.root, name: 'quick', store: f.store }), /automatic onEdit check \(quick\) is running/);
});

test('stale Ripwire HEAD checkouts of dead processes are removed, live and unrelated ones kept', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'rw-reap-')); t.after(() => rm(base, { recursive: true, force: true }));
  const cache = path.join(base, 'ripwire-1000');
  for (const dir of ['ripwire-qhead-111/src', 'ripwire-qhead-222', 'locks', 'ripwire-qheadsnap-1.bin.d']) await mkdir(path.join(cache, dir), { recursive: true });
  await writeFile(path.join(cache, 'ripwire-qhead-111/src/x.ts'), 'x');
  await mkdir(path.join(base, 'unrelated-qhead-333'));
  const removed = await reapStaleHeadTrees({ bases: [base, path.join(base, 'missing')], alive: pid => pid === 222 });
  assert.deepEqual(removed, [path.join(cache, 'ripwire-qhead-111')]);
  assert.deepEqual((await readdir(cache)).sort(), ['locks', 'ripwire-qhead-222', 'ripwire-qheadsnap-1.bin.d']);
});
