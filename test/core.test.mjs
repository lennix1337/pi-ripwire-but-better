import { realpathSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execute, repositoryRoot, ripwireArgs, fingerprint, projectChecks, evidence, navigate, contained, loadRecipes } from '../src/core.ts';
import { fixtureRepo } from './fixture.mjs';

const fixture = (t, checks = { smoke: { description: 'Print a fixture result', argv: [process.execPath, '-e', "console.log('fixture-ok')"], timeoutMs: 2000 } }) => fixtureRepo(t, checks);

test('fixed arguments keep hostile shell text as data and reject unsupported operations', () => {
  const args = ripwireArgs('/repo', 'search', 'x; rm -rf /');
  assert.ok(args.includes('--grep=x; rm -rf /'));
  assert.throws(() => ripwireArgs('/repo', 'shell', 'x'), /Unknown/);
  assert.throws(() => ripwireArgs('/repo', 'task'), /requires/);
  assert.throws(() => ripwireArgs('/repo', 'search', 'x\ny'), /Invalid/);
});

const await_real = p => realpathSync(p);

test('enforce exactly one repository root', async t => {
  const f = await fixture(t);
  assert.equal(await repositoryRoot(f.root), await (await import('node:fs/promises')).realpath(f.root));
  await assert.rejects(repositoryRoot(path.join(f.root, '.pi')), /single repository root/);
  const outside = path.dirname(f.root);
  await assert.rejects(repositoryRoot(outside), error => /Git repository root/.test(error.message) && error.message.includes(await_real(outside)) && /not a Git repository/.test(error.message));
});

test('source fingerprint catches tracked, staged, untracked changes', async t => {
  const { root } = await fixture(t); const before = await fingerprint(root);
  await writeFile(path.join(root, 'source.txt'), 'changed');
  assert.notEqual((await fingerprint(root)).digest, before.digest);
  await execute('git', ['add', '.'], { cwd: root });
  assert.notEqual((await fingerprint(root)).digest, before.digest);
  await writeFile(path.join(root, 'source.txt'), 'initial'); await execute('git', ['add', '.'], { cwd: root });
  assert.equal((await fingerprint(root)).digest, before.digest);
  await writeFile(path.join(root, 'new.txt'), 'new'); assert.notEqual((await fingerprint(root)).digest, before.digest);
});

// Seen live 2026-10-24 (receipts d0a6f5e0, c2c2cbb6): an edit that restored a file to its committed content made
// the first `git diff` print a core.autocrlf warning on stderr and refresh the index, so the next fingerprint
// differed and the onEdit run ended source_changed. Git warnings are not source.
test('source fingerprint ignores Git warnings that vanish once the index is refreshed', async t => {
  const { root } = await fixture(t);
  await execute('git', ['config', 'core.autocrlf', 'true'], { cwd: root });
  await writeFile(path.join(root, 'lf.ts'), 'a\nb\n'); await execute('git', ['add', 'lf.ts'], { cwd: root });
  await execute('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'lf'], { cwd: root });
  const clean = await fingerprint(root);
  await new Promise(resolve => setTimeout(resolve, 1100)); // A new mtime second marks the index entry stat-dirty.
  await writeFile(path.join(root, 'lf.ts'), 'a\nb\n');
  assert.equal((await fingerprint(root)).digest, clean.digest);
  assert.equal((await fingerprint(root)).digest, clean.digest);
});

test('list never executes; named check persists bounded paged evidence', async t => {
  const f = await fixture(t);
  assert.equal((await projectChecks(f)).checks.length, 1);
  const result = await projectChecks({ ...f, name: 'smoke' });
  assert.equal(result.status, 'passed'); assert.equal(result.unchanged, true); assert.match(result.output, /fixture-ok/);
  const page = await evidence({ ...f, id: result.id, limit: 4 });
  assert.equal(page.output, 'fixt'); assert.equal(page.nextOffset, 4);
  assert.equal((await evidence({ ...f, id: result.id, offset: 4 })).output, 'ure-ok\n');
  assert.match(page.freshness, /historical/);
  await assert.rejects(evidence({ ...f, id: '../secret' }), /Invalid/);
  await assert.rejects(projectChecks({ ...f, name: 'unknown' }), /Unknown/);
  await assert.rejects(projectChecks({ ...f, name: 'toString' }), /Unknown/);
});

test('source-changing command cannot claim pass', async t => {
  const f = await fixture(t, { edit: { description: 'Mutate fixture', argv: [process.execPath, '-e', "require('fs').writeFileSync('source.txt','changed')"], timeoutMs: 2000 } });
  assert.equal((await projectChecks({ ...f, name: 'edit' })).status, 'source_changed');
});

test('missing saved evidence gives a safe recovery without replay or local paths', async t => {
  const { store } = await fixture(t);
  const id = '00000000-0000-4000-8000-000000000000';
  const safeError = error => /No saved evidence/.test(error.message) && /Nothing was re-run/.test(error.message) && !error.message.includes(store);
  await assert.rejects(evidence({ store, id }), safeError);
  await mkdir(store, { recursive: true });
  await writeFile(path.join(store, `${id}.json`), JSON.stringify({ id }));
  await assert.rejects(evidence({ store, id }), safeError, 'a missing log is also unavailable evidence');
  await writeFile(path.join(store, `${id}.json`), '{invalid-json');
  await assert.rejects(evidence({ store, id }), SyntaxError, 'corruption must not be hidden as a missing receipt');
});

test('failure is not retried, receipt remains available', async t => {
  const f = await fixture(t, { fail: { description: 'Fail once', argv: [process.execPath, '-e', 'process.exit(7)'], timeoutMs: 2000 } });
  const result = await projectChecks({ ...f, name: 'fail' });
  assert.equal(result.status, 'failed'); assert.equal(result.exitCode, 7);
  assert.equal((await readdir(f.store)).filter(x => x.endsWith('.json')).length, 1);
});

test('timeout preserves uncertainty marker and prevents blind replay', async t => {
  const f = await fixture(t, { wait: { description: 'Timeout', argv: [process.execPath, '-e', 'setInterval(()=>{},100)'], timeoutMs: 100 } });
  const result = await projectChecks({ ...f, name: 'wait' });
  assert.equal(result.status, 'timeout');
  await assert.rejects(projectChecks({ ...f, name: 'wait' }), /outcome uncertain/);
});

// 14 days of sessions (2026-10-21..11-04): 35 "Prior check active" refusals, 25 of them a second check of the same
// reply (typecheck + unit), which Pi runs together. Checks of one repository from one process now run in turn.
test('explicit checks of one repository started together run one after the other', async t => {
  const slow = (label) => ({ description: label, argv: [process.execPath, '-e', `setTimeout(()=>console.log('${label}'),300)`], timeoutMs: 5000 });
  const f = await fixture(t, { typecheck: slow('types-ok'), unit: slow('unit-ok'), lint: slow('lint-ok') });
  const results = await Promise.all(['typecheck', 'unit', 'lint'].map(name => projectChecks({ ...f, name })));
  assert.deepEqual(results.map(r => r.status), ['passed', 'passed', 'passed']);
  assert.deepEqual(results.map(r => r.output.trim()), ['types-ok', 'unit-ok', 'lint-ok']);
  assert.deepEqual((await readdir(f.store)).filter(x => x.endsWith('.active')), [], 'every run released the lock');
});

test('a queued check whose caller aborted never starts', async t => {
  const f = await fixture(t, { first: { description: 'Slow', argv: [process.execPath, '-e', 'setTimeout(()=>{},300)'], timeoutMs: 5000 }, second: { description: 'Marker', argv: [process.execPath, '-e', "require('fs').writeFileSync(process.argv[1],'ran')", path.join(os.tmpdir(), 'never')], timeoutMs: 5000 } });
  const controller = new AbortController();
  const first = projectChecks({ ...f, name: 'first' });
  // Either call may reach the queue first, so the rejection is awaited from the start, not after the first check.
  const second = assert.rejects(projectChecks({ ...f, name: 'second', signal: controller.signal }), /Cancelled before execution/);
  controller.abort();
  assert.equal((await first).status, 'passed');
  await second;
  assert.equal((await readdir(f.store)).filter(x => x.endsWith('.json')).length, 1, 'only the first check left a receipt');
});

test('a marker left by an uncertain run names the run and the evidence to read', async t => {
  const f = await fixture(t, { wait: { description: 'Timeout', argv: [process.execPath, '-e', 'setInterval(()=>{},100)'], timeoutMs: 100 } });
  const result = await projectChecks({ ...f, name: 'wait' });
  await assert.rejects(projectChecks({ ...f, name: 'wait' }), error => {
    assert.match(error.message, /outcome uncertain/);
    assert.match(error.message, /"wait"/);
    assert.ok(error.message.includes(`project_evidence id=${result.id}`), error.message);
    assert.match(error.message, /Nothing was started/);
    return true;
  });
});

test('a marker held by another live process says it is running and to call again', async t => {
  const f = await fixture(t);
  await mkdir(f.store, { recursive: true });
  const { createHash } = await import('node:crypto');
  const marker = path.join(f.store, `${createHash('sha256').update(await realpath(f.root)).digest('hex')}.active`);
  const child = (await import('node:child_process')).spawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)']);
  t.after(() => child.kill());
  await writeFile(marker, JSON.stringify({ id: 'abc', pid: child.pid, name: 'unit', started: Date.now() }));
  await assert.rejects(projectChecks({ ...f, name: 'smoke' }), error => {
    assert.match(error.message, /"unit".*running in process \d+/);
    assert.match(error.message, /call again when it ends/);
    return true;
  });
});

test('a launch that never started leaves a not_started receipt and releases the lock', async t => {
  const f = await fixture(t, {
    missing: { description: 'Missing fixture executable', argv: ['pi-ripwire-nonexistent-fixture-executable'], timeoutMs: 1000 },
    smoke: { description: 'Print a fixture result', argv: [process.execPath, '-e', "console.log('fixture-ok')"], timeoutMs: 2000 },
  });
  await assert.rejects(projectChecks({ ...f, name: 'missing' }), error => {
    assert.match(error.message, /ENOENT.*inspect project_evidence id=/);
    assert.match(error.message, /Nothing started/);
    assert.match(error.message, /argv\[0\].*cwd.*PATH/);
    assert.match(error.message, /No retry or shell fallback/);
    assert.equal(error.cause.code, 'ENOENT');
    return true;
  });
  const filename = (await readdir(f.store)).find(file => file.endsWith('.json'));
  const receipt = JSON.parse(await readFile(path.join(f.store, filename), 'utf8'));
  assert.equal(receipt.status, 'not_started');
  assert.match(receipt.error, /ENOENT/);
  assert.match(receipt.error, /Nothing started/);
  // The process never existed (no pid), so nothing is uncertain: the error repeats and other checks still run.
  await assert.rejects(projectChecks({ ...f, name: 'missing' }), /ENOENT/);
  assert.equal((await projectChecks({ ...f, name: 'smoke' })).status, 'passed');
});

test('Windows batch recipes require an explicit shell and never get a shell fallback', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixtureRepo(t, {
    direct: { description: 'Direct batch shim', argv: ['.\\shim.cmd'], timeoutMs: 2000 },
    explicit: { description: 'Explicit reviewed shell', argv: [process.env.ComSpec || 'cmd.exe', '/d', '/s', '/c', 'shim.cmd'], timeoutMs: 2000 },
  }, { 'shim.cmd': '@echo off\r\necho started>>.git\\shim-started\r\necho shim-ok\r\n' });
  await assert.rejects(projectChecks({ ...f, name: 'direct' }), error => {
    assert.match(error.message, /Nothing started/);
    assert.match(error.message, /Windows.*\.cmd.*\.bat.*explicit shell/);
    return true;
  });
  await assert.rejects(readFile(path.join(f.root, '.git/shim-started')), { code: 'ENOENT' });
  const receiptFile = (await readdir(f.store)).find(file => file.endsWith('.json'));
  const receipt = JSON.parse(await readFile(path.join(f.store, receiptFile), 'utf8'));
  assert.equal(receipt.status, 'not_started');
  assert.match(receipt.error, /explicit shell/);
  const result = await projectChecks({ ...f, name: 'explicit' });
  assert.equal(result.status, 'passed');
  assert.match(result.output, /shim-ok/);
  assert.equal((await readFile(path.join(f.root, '.git/shim-started'), 'utf8')).trim(), 'started');
});

test('synchronous spawn validation failures are known not to have started', async () => {
  await assert.rejects(execute('invalid\0fixture', []), error => {
    assert.equal(error.code, 'ERR_INVALID_ARG_VALUE');
    assert.equal(error.notStarted, true);
    return true;
  });
});

test('output cap and pre-aborted execution', async () => {
  const result = await execute(process.execPath, ['-e', "console.log('x'.repeat(10000))"], { limit: 100 });
  assert.equal(result.reason, 'output_limit'); assert.equal(Buffer.byteLength(result.output), 100);
  await assert.rejects(execute(process.execPath, [], { signal: AbortSignal.abort() }), /Cancelled/);
});

test('navigation bounds output, stores full local log and nonzero status', async t => {
  const f = await fixture(t);
  // node treats repo as script; this is an actual failed subprocess, not a fabricated success.
  const result = await navigate({ ...f, binary: process.execPath, action: 'map' });
  assert.equal(result.status, 'nonzero_exit'); assert.ok(result.id);
  assert.equal((await evidence({ ...f, id: result.id })).exitCode, result.exitCode);
});

test('new repositories without a first commit have an explicit fingerprint', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'rw-unborn-')); t.after(() => rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  assert.equal((await execute('git', ['init'], { cwd: base })).code, 0);
  assert.equal((await fingerprint(base)).head, 'unborn');
});

test('focused built-in discovery does not edit project files', async t => {
  const f = await fixture(t);
  await rm(path.join(f.root, '.pi/checks.json'));
  await mkdir(path.join(f.root, 'scripts'));
  await writeFile(path.join(f.root, 'Genexus18MCP.sln'), 'fixture sentinel');
  await writeFile(path.join(f.root, 'scripts/lint.test.js'), 'fixture sentinel');
  const before = await fingerprint(f.root);
  const result = await projectChecks(f);
  assert.equal(result.origin, 'built-in:genexus18mcp');
  assert.equal(result.checks[0].name, 'lint-setup');
  assert.equal((await fingerprint(f.root)).digest, before.digest);
  assert.deepEqual(await readdir(path.join(f.root, '.pi')), []);
});

test('recipes cannot escape root and malformed commands are rejected', async t => {
  const f = await fixture(t, { bad: { description: 'Bad cwd', cwd: '..', argv: ['node'], timeoutMs: 100 } });
  await assert.rejects(projectChecks(f), /escapes/);
  await writeFile(path.join(f.root, '.pi/checks.json'), JSON.stringify({ version: 1, checks: { bad: { description: 'Bad argv', argv: ['node', 123], timeoutMs: 100 } } }));
  await assert.rejects(projectChecks(f), /Invalid recipe/);
});

// Concurrency is observed through the injected canonicaliser: a sequential implementation never starts the second
// realpath while the first is pending, so the first call's wait runs out (300 ms) and the assertion fails.
test('canonical path and canonical root are resolved together, not one after the other', async t => {
  const f = await fixture(t, {}, { 'source.txt': 'x' });
  const calls = []; let release; const second = new Promise(resolve => { release = resolve; });
  let secondStartedWhileFirstPending;
  const canonicalize = async target => {
    calls.push(target);
    if (calls.length === 1) {
      await Promise.race([second, new Promise(resolve => setTimeout(resolve, 300))]);
      secondStartedWhileFirstPending = calls.length === 2;
    } else release();
    return realpath(target);
  };
  const resolved = await contained(f.root, 'source.txt', { canonicalize });
  assert.equal(resolved, path.join(f.root, 'source.txt'));
  assert.equal(secondStartedWhileFirstPending, true);
  await writeFile(path.join(path.dirname(f.root), 'outside.txt'), 'outside');
  await assert.rejects(contained(f.root, '../outside.txt', { canonicalize }), /Path escapes project/);
});

test('recipe working directories are checked concurrently; an escaping one is still refused', async t => {
  const checks = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(name => [name, { description: 'd', argv: ['node'], timeoutMs: 1000, cwd: name }]));
  const f = await fixtureRepo(t, checks, { 'a/x': '', 'b/x': '', 'c/x': '', 'd/x': '', 'e/x': '' });
  let inFlight = 0; let maxInFlight = 0;
  const canonicalize = async target => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setImmediate(resolve));
    inFlight--;
    return realpath(target);
  };
  const recipes = await loadRecipes(f.root, { canonicalize });
  assert.equal(Object.keys(recipes.config.checks).length, 5);
  assert.ok(maxInFlight >= 5, `recipe directories checked one at a time (max in flight ${maxInFlight})`);
  const escaping = await fixture(t, { ok: { description: 'd', argv: ['node'], timeoutMs: 1000, cwd: '.' }, bad: { description: 'd', argv: ['node'], timeoutMs: 1000, cwd: '../outside' } });
  await mkdir(path.join(path.dirname(escaping.root), 'outside'));
  await assert.rejects(loadRecipes(escaping.root), /Path escapes project/);
});

test('a fingerprint canonicalises the repository root once, not once per untracked file', async t => {
  const { root } = await fixtureRepo(t, {});
  // Created after the commit, so they are untracked and each one goes through contained().
  for (let i = 0; i < 20; i++) await writeFile(path.join(root, `untracked${i}.txt`), 'x');
  const rootCalls = [];
  const canonicalize = target => { if (target === root) rootCalls.push(target); return realpath(target); };
  const fingerprinted = await fingerprint(root, { canonicalize });
  assert.equal(fingerprinted.digest, (await fingerprint(root)).digest);
  assert.ok(rootCalls.length <= 1, `root canonicalised ${rootCalls.length} times for 20 untracked files`);
});

// 14 days of sessions: typecheck and unit of one reply ran one after the other (the queue above), so the second
// call's latency was both durations (project_checks p95 1.7 s -> 5.0 s in the paired bench). Recipes that declare
// `parallel` write nothing the fingerprint sees, so they may overlap each other; every other check stays exclusive.
const rendezvous = (dir, me, other) => ({ description: `Rendezvous ${me}`, parallel: true, timeoutMs: 8000, argv: [process.execPath, '-e', `
const fs = require('fs'); const d = ${JSON.stringify(dir)};
fs.writeFileSync(d + '/${me}.start', '1');
const end = Date.now() + 4000;
(function wait() { if (fs.existsSync(d + '/${other}.start')) process.exit(0); if (Date.now() > end) process.exit(3); setTimeout(wait, 20); })();`] });
const windowed = (dir, me, parallel) => ({ description: `Windowed ${me}`, ...(parallel && { parallel: true }), timeoutMs: 8000, argv: [process.execPath, '-e', `
const fs = require('fs'); const d = ${JSON.stringify(dir)};
const seen = fs.readdirSync(d).filter(f => f.endsWith('.start') && !fs.existsSync(d + '/' + f.replace('.start', '.end')));
fs.writeFileSync(d + '/${me}.start', '1');
setTimeout(() => { fs.writeFileSync(d + '/${me}.end', '1'); process.exit(seen.length ? 4 : 0); }, 300);`] });

test('parallel recipes of one repository overlap; a serialized pair could never meet', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-ripwire-rdv-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const f = await fixture(t, { a: rendezvous(dir, 'a', 'b'), b: rendezvous(dir, 'b', 'a') });
  const results = await Promise.all([projectChecks({ ...f, name: 'a' }), projectChecks({ ...f, name: 'b' })]);
  assert.deepEqual(results.map(r => r.status), ['passed', 'passed']);
  assert.deepEqual(await readdir(f.store).then(names => names.filter(n => n.endsWith('.active') || n.includes('.active.'))), [], 'no marker left behind');
});

test('a check that is not parallel never overlaps one that is, in either order', async t => {
  for (const order of [['x', 'p'], ['p', 'x']]) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-ripwire-ex-')); t.after(() => rm(dir, { recursive: true, force: true }));
    const f = await fixture(t, { x: windowed(dir, 'x', false), p: windowed(dir, 'p', true) });
    const results = await Promise.all(order.map(name => projectChecks({ ...f, name })));
    assert.deepEqual(results.map(r => r.status), ['passed', 'passed'], order.join('>'));
  }
});

test('parallel must be a boolean', async t => {
  const f = await fixture(t, { a: { description: 'x', parallel: 'yes', timeoutMs: 1000, argv: [process.execPath, '-e', '0'] } });
  await assert.rejects(projectChecks(f), /parallel must be a boolean/);
});

test('a parallel check that ended uncertain keeps blocking exclusive checks, not other parallel ones', async t => {
  const hang = { description: 'Hang past its timeout', parallel: true, timeoutMs: 200, argv: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'] };
  const ok = { description: 'Quick', parallel: true, timeoutMs: 4000, argv: [process.execPath, '-e', '0'] };
  const f = await fixture(t, { hang, ok, exclusive: { ...ok, parallel: undefined } });
  assert.equal((await projectChecks({ ...f, name: 'hang' }).catch(error => error)).status ?? 'threw', 'timeout');
  assert.equal((await projectChecks({ ...f, name: 'ok' })).status, 'passed');
  await assert.rejects(projectChecks({ ...f, name: 'exclusive' }), /parallel check\(s\) "hang"/);
});

test('an exclusive check that ended uncertain blocks parallel checks too, and the refused one leaves no marker', async t => {
  const hang = { description: 'Hang past its timeout', timeoutMs: 200, argv: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'] };
  const ok = { description: 'Quick', parallel: true, timeoutMs: 4000, argv: [process.execPath, '-e', '0'] };
  const f = await fixture(t, { hang, ok });
  assert.equal((await projectChecks({ ...f, name: 'hang' }).catch(error => error)).status ?? 'threw', 'timeout');
  await assert.rejects(projectChecks({ ...f, name: 'ok' }), /outcome uncertain/);
  assert.deepEqual(await readdir(f.store).then(names => names.filter(n => n.includes('.active.'))), [], 'refused parallel start removed its own marker');
});

test('a command run for the model gets plain text: color codes are asked off and forced color is dropped', async () => {
  const probe = "console.log(JSON.stringify([process.env.NO_COLOR, process.env.FORCE_COLOR ?? null]))";
  const previous = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = '1';
  try {
    const result = await execute(process.execPath, ['-e', probe]);
    assert.deepEqual(JSON.parse(result.output), ['1', null]);
  } finally {
    if (previous === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = previous;
  }
});
