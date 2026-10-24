import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { evidence } from '../src/core.ts';

const baseline = await import(pathToFileURL(process.argv[2]).href);
const store = await mkdtemp(path.join(os.tmpdir(), 'rw-page-bench-'));
const id = '00000000-0000-0000-0000-000000000003';
try {
  await writeFile(path.join(store, `${id}.json`), '{}');
  const results = [];
  for (const size of [6000, 4 * 1024 * 1024]) {
    await writeFile(path.join(store, `${id}.log`), 'x'.repeat(size));
    const options = { store, id, offset: 100, limit: 6000 };
    assert.deepEqual(await evidence(options), await baseline.evidence(options));
    for (const reverse of [false, true]) {
      const times = { before: [], after: [] };
      const variants = [['before', baseline.evidence], ['after', evidence]];
      if (reverse) variants.reverse();
      for (let i = 0; i < 35; i++) {
        for (const [name, run] of variants) {
          const start = performance.now(); await run(options);
          if (i >= 5) times[name].push(performance.now() - start);
        }
      }
      const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
      const beforeMs = median(times.before); const afterMs = median(times.after);
      results.push({ size, reverse, samples: 30, beforeMs, afterMs, improvementPercent: 100 * (1 - afterMs / beforeMs) });
    }
  }
  console.log(JSON.stringify({ protocol: 'paired warm local evidence reads; equal results; no inference', results }, null, 2));
} finally { await rm(store, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
