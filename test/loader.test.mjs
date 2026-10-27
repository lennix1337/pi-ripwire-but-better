import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm, copyFile, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { execute } from '../src/core.ts';
import { fixtureRepo } from './fixture.mjs';
import { loadExtensions } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';

test('real Pi loader registers exactly three tools and no prompt-shaping hooks', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const loaded = await loadExtensions([fileURLToPath(new URL('../src/index.ts', import.meta.url))], root);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.deepEqual([...extension.tools.keys()], ['ripwire', 'project_checks', 'project_evidence']);
  // tool_result only appends onEdit check notes to results; nothing rewrites the prompt or the context.
  assert.deepEqual([...extension.handlers.keys()].sort(), ['session_shutdown', 'session_start', 'tool_result']);
  for (const name of ['ripwire', 'project_checks', 'project_evidence']) {
    const definition = extension.tools.get(name).definition;
    const args = name === 'ripwire' ? { root, action: 'map', qurey: 'typo' } : name === 'project_checks' ? { root, nmae: 'typo' } : { id: '00000000-0000-4000-8000-000000000000', offest: 2 };
    assert.throws(() => validateToolArguments(definition, { name, arguments: args }), /additional properties|Unexpected property/);
  }
  const info = extension.tools.get('ripwire');
  const tool = info.definition;
  const result = await tool.execute('loader-test', { root: root + '/src', action: 'map' }, undefined, undefined, {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /single repository root/);
});

test('native check launch failures stay errors with actionable saved evidence and no stranded lock', async t => {
  const f = await fixtureRepo(t, {
    missing: { description: 'Missing executable', argv: ['pi-ripwire-missing-launch-fixture'], timeoutMs: 1000 },
    smoke: { description: 'Working executable', argv: [process.execPath, '-e', "console.log('still-works')"], timeoutMs: 2000 },
  });
  const previousStore = process.env.PI_RIPWIRE_EVIDENCE_DIR;
  process.env.PI_RIPWIRE_EVIDENCE_DIR = f.store;
  t.after(() => {
    if (previousStore === undefined) delete process.env.PI_RIPWIRE_EVIDENCE_DIR;
    else process.env.PI_RIPWIRE_EVIDENCE_DIR = previousStore;
  });
  const loaded = await loadExtensions([fileURLToPath(new URL('../src/index.ts', import.meta.url))], f.root);
  assert.deepEqual(loaded.errors, []);
  const tools = loaded.extensions[0].tools;
  const failed = await tools.get('project_checks').definition.execute('missing', { root: f.root, name: 'missing' });
  assert.equal(failed.isError, true);
  assert.match(failed.details.message, /Nothing started.*argv\[0\].*cwd.*PATH/);
  assert.match(failed.details.message, /No retry or shell fallback/);
  const id = /project_evidence id=([a-f0-9-]{36})/.exec(failed.details.message)?.[1];
  assert.ok(id);
  const saved = await tools.get('project_evidence').definition.execute('receipt', { id });
  assert.equal(saved.details.status, 'not_started');
  assert.match(saved.details.error, /Nothing started/);
  assert.equal((await readdir(f.store)).filter(file => file.endsWith('.json')).length, 1);
  const smoke = await tools.get('project_checks').definition.execute('smoke', { root: f.root, name: 'smoke' });
  assert.equal(smoke.isError, false);
  assert.equal(smoke.details.status, 'passed');
  assert.match(smoke.details.output, /still-works/);
});

test('/reload picks up edits to every source module, not only the entry', async t => {
  // jiti hands .mjs files to Node's native import, whose cache never reloads; .ts modules are re-read on each load.
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const dir = await mkdtemp(path.join(repo, 'node_modules', '.reload-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const src = path.join(dir, 'src');
  await mkdir(src);
  for (const file of await readdir(path.join(repo, 'src'))) await copyFile(path.join(repo, 'src', file), path.join(src, file));
  const entry = path.join(src, 'index.ts');
  const enumOf = loaded => loaded.extensions[0].tools.get('ripwire').definition.parameters.properties.action.enum;
  const first = await loadExtensions([entry], repo);
  assert.deepEqual(first.errors, []);
  assert.ok(!enumOf(first).includes('reload_probe'));
  const core = path.join(src, 'core.ts');
  await writeFile(core, (await readFile(core, 'utf8')).replace("'test_gate'];", "'test_gate', 'reload_probe'];"));
  const second = await loadExtensions([entry], repo);
  assert.deepEqual(second.errors, []);
  assert.ok(enumOf(second).includes('reload_probe'));
});

test('incomplete navigation returns a native error and preserves inspectable receipt', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rw-incomplete-'));
  const previousPath = process.env.PATH;
  const previousStore = process.env.PI_RIPWIRE_EVIDENCE_DIR;
  t.after(async () => {
    process.env.PATH = previousPath;
    if (previousStore === undefined) delete process.env.PI_RIPWIRE_EVIDENCE_DIR;
    else process.env.PI_RIPWIRE_EVIDENCE_DIR = previousStore;
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const root = path.join(dir, 'repo'); const bin = path.join(dir, 'bin');
  await mkdir(root); await mkdir(bin);
  await writeFile(path.join(root, 'index.js'), "process.stdout.write('x'.repeat(5 * 1024 * 1024));");
  assert.equal((await execute('git', ['init'], { cwd: root })).code, 0);
  // Node accepts a directory with index.js. The fixture executable never invokes Ripwire.
  await copyFile(process.execPath, path.join(bin, process.platform === 'win32' ? 'ripwire.exe' : 'ripwire'));
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  process.env.PI_RIPWIRE_EVIDENCE_DIR = path.join(dir, 'store');
  const loaded = await loadExtensions([fileURLToPath(new URL('../src/index.ts', import.meta.url))], root);
  assert.deepEqual(loaded.errors, []);
  const tools = loaded.extensions[0].tools;
  const result = await tools.get('ripwire').definition.execute('incomplete', { root, action: 'map' });
  const receipt = result.details;
  assert.equal(receipt.status, 'output_limit');
  assert.equal(result.isError, true);
  assert.ok(receipt.id);
  const saved = await tools.get('project_evidence').definition.execute('read', { id: receipt.id, limit: 40 });
  assert.equal(saved.details.status, 'output_limit');
  assert.equal(saved.details.output, 'x'.repeat(40));
});

test('native CLI search compacts only the known legend and retains raw receipt', async t => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const store = await mkdtemp(path.join(os.tmpdir(), 'rw-compact-'));
  const previous = process.env.PI_RIPWIRE_EVIDENCE_DIR;
  const previousResident = process.env.PI_RIPWIRE_RESIDENT;
  process.env.PI_RIPWIRE_EVIDENCE_DIR = store;
  process.env.PI_RIPWIRE_RESIDENT = '0'; // This fixture proves CLI output, regardless of the host setting.
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_RIPWIRE_EVIDENCE_DIR; else process.env.PI_RIPWIRE_EVIDENCE_DIR = previous;
    if (previousResident === undefined) delete process.env.PI_RIPWIRE_RESIDENT; else process.env.PI_RIPWIRE_RESIDENT = previousResident;
    await rm(store, { recursive: true, force: true });
  });
  const loaded = await loadExtensions([fileURLToPath(new URL('../src/index.ts', import.meta.url))], root);
  assert.deepEqual(loaded.errors, []);
  t.after(async () => { for (const handler of loaded.extensions[0].handlers.get('session_shutdown') || []) await handler({}, {}); });
  const tools = loaded.extensions[0].tools;
  const result = await tools.get('ripwire').definition.execute('compact', { root, action: 'search', query: 'navigate' });
  assert.equal(result.isError, false);
  assert.match(result.details.output, /^<!-- ripwire grep schema=/);
  const text = JSON.parse(result.content[0].text);
  assert.match(text.output, /^<grep /);
  assert.match(text.recovery, new RegExp(result.details.id));
  const saved = await tools.get('project_evidence').definition.execute('raw', { id: result.details.id });
  assert.equal(saved.details.output, result.details.output);
});
