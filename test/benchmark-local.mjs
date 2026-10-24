import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const core = await import(process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href : '../src/core.ts');
const fileCount = Number(process.env.PI_RIPWIRE_BENCH_FILES || 20);
if (!Number.isInteger(fileCount) || fileCount < 1 || fileCount > 10000) throw new Error('Invalid benchmark file count');
const base = await mkdtemp(path.join(os.tmpdir(), 'rw-bench-'));
const root = path.join(base, 'repo'), store = path.join(base, 'evidence');
await mkdir(path.join(root, '.pi'), { recursive: true });
try {
  await core.execute('git', ['init'], { cwd: root });
  await writeFile(path.join(root, '.pi/checks.json'), JSON.stringify({ version: 1, checks: { smoke: { description: 'Synthetic local overhead benchmark', argv: [process.execPath, '-e', "console.log('fixture-ok')"], timeoutMs: 3000 } } }));
  for (let i = 0; i < fileCount; i++) await writeFile(path.join(root, `file${i}.txt`), 'fixture'.repeat(100));
  const samples = { fingerprint: [], list: [], check: [], evidence: [] };
  let receipt;
  for (let i = 0; i < 8; i++) {
    for (const [name, run] of Object.entries({ fingerprint: () => core.fingerprint(root), list: () => core.projectChecks({ root, store }), check: () => core.projectChecks({ root, store, name: 'smoke' }), evidence: () => core.evidence({ store, id: receipt.id }) })) {
      const start = performance.now(); const result = await run();
      if (name === 'check') { if (result.status !== 'passed') throw new Error(JSON.stringify(result)); receipt = result; }
      if (i) samples[name].push(performance.now() - start);
    }
  }
  const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)];
  console.log(JSON.stringify({ protocol: `Windows Node; disposable unborn Git repo, ${fileCount} untracked files; 1 warmup, 7 samples; no model/inference`, node: process.version, platform: process.platform, mediansMs: Object.fromEntries(Object.entries(samples).map(([k,v]) => [k, median(v)])), samples, checkResultBytes: Buffer.byteLength(JSON.stringify(receipt)) }, null, 2));
} finally { await rm(base, { recursive: true, force: true }); }
