import { mkdtempSync, cpSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const cases = [
  ['repository-root', 'src/core.ts', 'if (actual !== root)', 'if (false)', 'enforce exactly one repository root', 'core'],
  ['repository-required', 'src/core.ts', "if (result.code !== 0) throw new Error(`Project must be a Git repository root: ${root} is not a Git repository; pass the root of one repository, not a folder that groups several`);", "if (result.code !== 0) return root;", 'enforce exactly one repository root', 'core'],
  ['action-allow-list', 'src/core.ts', 'if (!actions.includes(action))', 'if (false)', 'fixed arguments keep hostile', 'core'],
  ['evidence-bounds', 'src/core.ts', 'limit > 12000', 'limit > 120000', 'large evidence stays bounded', 'audit'],
  ['utf8-pagination', 'src/core.ts', "if (loaded && (buffer[0] & 0xc0) === 0x80)", 'if (false)', 'UTF-8 pagination rejects offsets', 'audit'],
  ['read-only-hint', 'src/index.ts', "name: 'ripwire', label: 'Ripwire', annotations: { readOnlyHint: true }", "name: 'ripwire', label: 'Ripwire', annotations: { readOnlyHint: false }", 'navigation and evidence reads declare readOnlyHint', 'loader'],
];

for (const [name, file, before, after, pattern, test] of cases) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-ripwire-mutant-'));
  try {
    cpSync(join(root, 'src'), join(dir, 'src'), { recursive: true });
    cpSync(join(root, 'test'), join(dir, 'test'), { recursive: true });
    cpSync(join(root, 'package.json'), join(dir, 'package.json'));
    symlinkSync(resolve(root, 'node_modules'), join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const target = join(dir, file); const source = readFileSync(target, 'utf8');
    assert.equal(source.split(before).length, 2, `unique mutation ${name}`);
    writeFileSync(target, source.replace(before, after));
    const result = spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`, `test/${test}.test.mjs`], { cwd: dir, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.error, undefined, `${name}: process must run, not time out`);
    assert.notEqual(result.status, 0, `${name}: survived`);
    assert.match(result.stdout + result.stderr, /AssertionError/, `${name}: must fail an assertion, not crash`);
    console.log(`${name}: killed by assertion`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
console.log(`${cases.length}/${cases.length} boundary mutants killed; disposable copies only`);
