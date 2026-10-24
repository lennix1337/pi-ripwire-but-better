import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execute } from '../src/core.ts';

// A committed Git repository with .pi/checks.json and the given files, plus an evidence store outside it.
export async function fixtureRepo(t, checks, files = { 'source.txt': 'initial' }) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'pi-ripwire-'));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const root = path.join(base, 'repo'); const store = path.join(base, 'store');
  await mkdir(path.join(root, '.pi'), { recursive: true });
  await writeFile(path.join(root, '.pi/checks.json'), JSON.stringify({ version: 1, checks }));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]) {
    assert.equal((await execute('git', args, { cwd: root })).code, 0);
  }
  return { root: await realpath(root), store };
}
