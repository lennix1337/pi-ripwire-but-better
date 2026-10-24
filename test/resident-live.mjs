// Explicit local integration probe, not part of the hermetic npm test glob.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadExtensions } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';
import { execute } from '../src/core.ts';

const dir = await mkdtemp(path.join(os.tmpdir(), 'pi-ripwire-resident-live-'));
const old = Object.fromEntries(['PI_RIPWIRE_RESIDENT', 'PI_RIPWIRE_BINARY', 'PI_RIPWIRE_EVIDENCE_DIR'].map(key => [key, process.env[key]]));
process.env.PI_RIPWIRE_RESIDENT = '1';
process.env.PI_RIPWIRE_BINARY = process.argv[2] || 'ripwire';
process.env.PI_RIPWIRE_EVIDENCE_DIR = path.join(dir, 'evidence');
const root = path.join(dir, 'repo'); await mkdir(root);
await writeFile(path.join(root, 'probe.ts'), 'export function residentBefore() { return 1; }\n');
assert.equal((await execute('git', ['init'], { cwd: root })).code, 0);
const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
let loaded;
async function shutdown() {
  for (const extension of loaded?.extensions || []) {
    for (const handler of extension.handlers.get('session_shutdown') || []) await handler({ type: 'session_shutdown' }, {});
  }
  loaded = undefined;
}
async function load() {
  loaded = await loadExtensions([entry], root);
  assert.deepEqual(loaded.errors, []);
  return loaded.extensions[0].tools;
}
const observations = [];
try {
  let tools = await load();
  const search = async query => {
    const response = await tools.get('ripwire').definition.execute('resident-live', { root, action: 'search', query });
    assert.equal(response.isError, false, JSON.stringify(response));
    assert.equal(response.details.transport, 'mcp-stdio');
    assert.ok(response.details.protocol._fresh);
    const payload = JSON.parse(response.details.output);
    observations.push({ query, receipt: response.details.id, elapsedMs: response.details.elapsedMs, freshness: response.details.protocol._fresh });
    const saved = await tools.get('project_evidence').definition.execute('resident-evidence', { id: response.details.id });
    assert.equal(saved.details.output, response.details.output);
    return payload;
  };
  assert.equal((await search('residentBefore')).total, 1);
  assert.equal((await search('residentBefore')).total, 1);
  await writeFile(path.join(root, 'probe.ts'), 'export function residentAfterChanged() { return 2; }\n');
  const after = await search('residentAfterChanged');
  assert.equal(after.total, 1, 'resident index must detect changed source without restarting');
  assert.equal((await search('residentBefore')).total, 0, 'removed source must not survive in the hot index');
  // Normal extension shutdown/reload destroys the old pool and creates a new one.
  await shutdown(); tools = await load();
  assert.equal((await search('residentAfterChanged')).total, 1);
  const receipt = { scope: 'Real Pi loader + native tool callback -> real Ripwire MCP -> source-change refresh -> saved evidence -> shutdown/reload; disposable fixture only. Not active-chat reload, model reasoning or real-repository p50.', binary: process.env.PI_RIPWIRE_BINARY, observations };
  const output = process.argv[3];
  if (output) await writeFile(output, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await shutdown();
  for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
