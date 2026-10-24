import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execute, repositoryRoot, ripwireArgs, fingerprint, projectChecks, evidence, navigate } from '../src/core.ts';
import { fixtureRepo } from './fixture.mjs';

const fixture = (t, checks = { smoke: { description: 'Print a fixture result', argv: [process.execPath, '-e', "console.log('fixture-ok')"], timeoutMs: 2000 } }) => fixtureRepo(t, checks);

test('fixed arguments keep hostile shell text as data and reject unsupported operations', () => {
  const args = ripwireArgs('/repo', 'search', 'x; rm -rf /');
  assert.ok(args.includes('--grep=x; rm -rf /'));
  assert.throws(() => ripwireArgs('/repo', 'shell', 'x'), /Unknown/);
  assert.throws(() => ripwireArgs('/repo', 'task'), /requires/);
  assert.throws(() => ripwireArgs('/repo', 'search', 'x\ny'), /Invalid/);
});

test('enforce exactly one repository root', async t => {
  const f = await fixture(t);
  assert.equal(await repositoryRoot(f.root), await (await import('node:fs/promises')).realpath(f.root));
  await assert.rejects(repositoryRoot(path.join(f.root, '.pi')), /single repository root/);
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

test('a launch that never started leaves a not_started receipt and releases the lock', async t => {
  const f = await fixture(t, {
    missing: { description: 'Missing fixture executable', argv: ['pi-ripwire-nonexistent-fixture-executable'], timeoutMs: 1000 },
    smoke: { description: 'Print a fixture result', argv: [process.execPath, '-e', "console.log('fixture-ok')"], timeoutMs: 2000 },
  });
  await assert.rejects(projectChecks({ ...f, name: 'missing' }), /ENOENT.*inspect project_evidence id=/);
  const filename = (await readdir(f.store)).find(file => file.endsWith('.json'));
  const receipt = JSON.parse(await readFile(path.join(f.store, filename), 'utf8'));
  assert.equal(receipt.status, 'not_started');
  assert.match(receipt.error, /ENOENT/);
  // The process never existed (no pid), so nothing is uncertain: the error repeats and other checks still run.
  await assert.rejects(projectChecks({ ...f, name: 'missing' }), /ENOENT/);
  assert.equal((await projectChecks({ ...f, name: 'smoke' })).status, 'passed');
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
