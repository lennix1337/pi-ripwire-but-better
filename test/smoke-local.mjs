// Explicit developer smoke; not part of portable npm test. Never calls a model.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectChecks, navigate } from '../src/core.mjs';
const directory = process.argv[2];
if (!directory) throw new Error('Supply an external evidence directory');
await mkdir(directory, { recursive: true });
const results = [];
for (const [root, name] of [['C:/projetos/dentai-mono', 'ops-diagnostics'], ['C:/projetos/Genexus18MCP', 'lint-setup']]) {
  const listed = await projectChecks({ root });
  if (!listed.checks.some(check => check.name === name)) throw new Error('Expected focused recipe unavailable');
  const result = await projectChecks({ root, name });
  results.push(result);
  await writeFile(path.join(directory, 'real-project-checks.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ root, name, status: result.status, elapsedMs: result.elapsedMs, id: result.id }));
  if (result.status !== 'passed') throw new Error('Focused check did not pass; no retry');
}
const result = await navigate({ root: 'C:/projetos/pi-ripwire', action: 'task', query: 'How do project check recipes execute and persist evidence?' });
await writeFile(path.join(directory, 'navigation.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ action: result.action, status: result.status, elapsedMs: result.elapsedMs, totalBytes: result.totalBytes, previewBytes: Buffer.byteLength(result.output), nextOffset: result.nextOffset }));
if (result.status !== 'completed') throw new Error('Navigation did not complete');
