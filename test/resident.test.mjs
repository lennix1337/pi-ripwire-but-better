import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { fixtureRepo } from './fixture.mjs';
import { navigate, navigateResident, residentActions, evidence } from '../src/core.ts';

const fixture = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url));
async function poolFor(t, options = {}) {
  const { createResidentPool } = await import('../src/resident.ts');
  const children = [];
  const pool = createResidentPool({
    timeoutMs: 2000,
    spawnProcess(binary, args, config) {
      assert.equal(config.shell, false);
      assert.deepEqual(args.slice(1), ['--mcp', '--mcp-tools=grep,for']);
      // Protocol fixture echoes synthetic roots; only the core integration uses a real Git root.
      const child = spawn(process.execPath, [fixture, ...args], { ...config, cwd: dirname(fixture) });
      children.push(child);
      return child;
    },
    ...options,
  });
  t.after(async () => {
    await pool.dispose();
    for (const child of children) assert.ok(child.exitCode !== null || child.signalCode !== null, 'owned subprocess was reaped');
  });
  return { pool, children };
}
const payload = result => JSON.parse(result.output);

test('resident MCP reuses one process, retains freshness, isolates roots and preserves errors', async t => {
  const { pool, children } = await poolFor(t);
  const first = payload(await pool.navigate('/root-a', 'search', 'x; touch forbidden'));
  const second = payload(await pool.navigate('/root-a', 'task', 'explain task'));
  assert.equal(first.pid, second.pid);
  assert.equal(first.query, 'x; touch forbidden');
  assert.equal(second.tool, 'for');
  assert.notEqual(payload(await pool.navigate('/root-b', 'search', 'query')).pid, first.pid);
  const refusal = await pool.navigate('/root-b', 'search', 'refuse');
  assert.equal(refusal.code, 1);
  assert.equal(refusal.metadata._fresh, 'ok');
  assert.equal(children.length, 2);
  await assert.rejects(pool.navigate('/root-b', 'quality', ''), /Unsupported resident action/);
  const third = payload(await pool.navigate('/root-c', 'search', 'new root'));
  assert.notEqual(third.pid, first.pid);
  assert.ok(children[0].exitCode !== null || children[0].signalCode !== null, 'idle owner is reaped before eviction replacement');
});

test('timeout is not retried and terminates the uncertain server', async t => {
  const { pool, children } = await poolFor(t, { timeoutMs: 250 });
  await assert.rejects(pool.navigate('/root', 'search', 'hang'), /timeout.*not replayed/i);
  assert.equal(children.length, 1, 'no automatic fallback or retry');
});

test('protocol corruption and output limits fail explicitly without fallback', async t => {
  for (const query of ['malformed', 'null-response', 'oversize']) {
    const { pool, children } = await poolFor(t, { maxBytes: 4096 });
    await assert.rejects(pool.navigate('/root', 'search', query), /protocol|output limit/i);
    assert.equal(children.length, 1);
  }
});

test('pre-dispatch cancellation has no launch effect; active cancellation closes only its server', async t => {
  const { pool, children } = await poolFor(t);
  await assert.rejects(pool.navigate('/root', 'search', 'q', { signal: AbortSignal.abort() }), /cancelled/i);
  assert.equal(children.length, 0);
  const controller = new AbortController();
  const pending = pool.navigate('/root', 'search', 'hang', { signal: controller.signal });
  setTimeout(() => controller.abort(), 80);
  await assert.rejects(pending, /cancelled/i);
  assert.equal(children.length, 1);
});

test('queued cancellation responds without interrupting or replaying the active request', async t => {
  const { pool, children } = await poolFor(t);
  const active = pool.navigate('/root', 'search', 'hang');
  const activeResult = Promise.allSettled([active]);
  const controller = new AbortController();
  const queued = pool.navigate('/root', 'search', 'must-not-dispatch', { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  // A bounded check distinguishes immediate cancellation from waiting for the active timeout.
  let timer;
  try {
    const result = await Promise.race([
      queued.then(() => 'dispatched', error => error.message),
      new Promise(resolve => { timer = setTimeout(() => resolve('still queued'), 150); }),
    ]);
    assert.match(result, /cancelled/i);
    assert.ok(children.length <= 1);
  } finally { clearTimeout(timer); await pool.dispose(); await activeResult; }
});

test('bounded bursts reject excess requests and immediate shutdown never replays queued work', async t => {
  const { pool, children } = await poolFor(t, { maxPending: 2, timeoutMs: 2000 });
  const first = pool.navigate('/root', 'search', 'hang');
  const queued = pool.navigate('/root', 'task', 'queued');
  const results = Promise.allSettled([first, queued]);
  await assert.rejects(pool.navigate('/root', 'search', 'excess'), /queue.*full/i);
  await new Promise(resolve => setImmediate(resolve));
  await pool.dispose();
  assert.ok((await results).every(result => result.status === 'rejected'));
  assert.equal(children.length, 1);
  await assert.rejects(pool.navigate('/root', 'search', 'after shutdown'), /closed/i);
});

test('a dispatched resident failure keeps an inspectable uncertain receipt without CLI fallback', async t => {
  const { pool, children } = await poolFor(t, { timeoutMs: 250 });
  const f = await fixtureRepo(t, {});
  await assert.rejects(navigateResident({ ...f, root: `${f.root}/.pi`, action: 'search', query: 'x', resident: pool }), /single repository root/);
  assert.equal(children.length, 0);
  const result = await navigateResident({ ...f, action: 'search', query: 'hang', resident: pool });
  assert.equal(result.status, 'transport_error');
  assert.equal(result.exitCode, null);
  assert.match(result.output, /timeout.*not replayed/i);
  assert.equal(children.length, 1);
  const saved = await evidence({ ...f, id: result.id });
  assert.equal(saved.status, 'transport_error');
  assert.equal(saved.output, result.output);
});

test('navigation integrates resident output with saved evidence and keeps CLI-only actions outside the pool', async t => {
  const { pool } = await poolFor(t);
  const f = await fixtureRepo(t, {});
  const result = await navigateResident({ ...f, action: 'search', query: 'needle', resident: pool });
  assert.equal(result.transport, 'mcp-stdio');
  assert.equal(result.status, 'completed');
  assert.equal(result.protocol._fresh, 'ok');
  const saved = await evidence({ ...f, id: result.id });
  assert.equal(saved.output, result.output);
  assert.equal(saved.transport, 'mcp-stdio');
  assert.deepEqual([...residentActions].sort(), ['search', 'task']);
  const cli = await navigate({ ...f, action: 'quality', binary: process.execPath });
  assert.equal(cli.transport, undefined);
  assert.equal(cli.status, 'nonzero_exit');
  const refused = await navigateResident({ ...f, action: 'quality', resident: pool });
  assert.equal(refused.status, 'transport_error');
  assert.match(refused.output, /Unsupported resident action/);
});
