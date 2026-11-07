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
  // Property tests (test/property-*.test.mjs): each mutant reverts one guard or one past bug.
  ['page-utf8-backoff', 'src/core.ts', 'while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;', '', 'pagination walks any UTF-8', 'property-pagination'],
  ['page-offset-guard', 'src/core.ts', "if (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) throw new Error('Offset must be a UTF-8 code point boundary; use nextOffset');", '', 'pagination rejects every offset', 'property-pagination'],
  ['page-limit-overrun', 'src/core.ts', 'let end = Math.min(bytes.length, offset + limit);', 'let end = Math.min(bytes.length, offset + limit + 1);', 'pagination walks any UTF-8', 'property-pagination'],
  ['evidence-utf8-backoff', 'src/core.ts', 'while (end > 0 && end < loaded && (buffer[end] & 0xc0) === 0x80) end--;', '', 'saved evidence pages', 'property-pagination'],
  ['containment-alias-root', 'src/core.ts', 'canonicalize(root)])', 'path.resolve(root)])', 'containment accepts every relative path', 'property-containment'],
  ['containment-dotdot-name', 'src/core.ts', "rel.startsWith(`..${path.sep}`)", "rel.startsWith('..')", 'containment accepts every relative path', 'property-containment'],
  ['containment-ancestor', 'src/core.ts', "rel === '..' || ", '', 'containment accepts every relative path', 'property-containment'],
  ['arguments-allow-list-trim', 'src/core.ts', 'if (!actions.includes(action))', 'if (!actions.includes(String(action).trim()))', 'ripwire refuses every hostile', 'property-arguments'],
  ['arguments-control-range', 'src/core.ts', '/[\\x00-\\x1f]/.test(query)', '/[\\x00-\\x08]/.test(query)', 'ripwire refuses every hostile', 'property-arguments'],
  ['arguments-blank-query', 'src/core.ts', 'if (verbs[action] && !query.trim())', 'if (false)', 'ripwire length bound', 'property-arguments'],
  ['arguments-length-bound', 'src/core.ts', 'query.length > 2000', 'query.length > 2001', 'ripwire length bound', 'property-arguments'],
  ['capture-split-kept', 'src/core.ts', 'return bytes.length - i < width ? i : bytes.length;', 'return bytes.length;', 'captured output keeps', 'property-pagination'],
  ['capture-width-four', 'src/core.ts', 'byte >= 0xf0 ? 4', 'byte >= 0xf0 ? 3', 'captured output keeps', 'property-pagination'],
  ['capture-lookback', 'src/core.ts', 'i >= Math.max(0, bytes.length - 4)', 'i >= Math.max(0, bytes.length - 1)', 'captured output keeps', 'property-pagination'],
  ['resident-chunk-decoder', 'src/resident.ts', 'buffer += decoder.write(data);', 'buffer += data.toString();', 'resident frames decode', 'property-resident'],
  ['resident-line-consume', 'src/resident.ts', 'buffer = buffer.slice(end + 1);', 'buffer = buffer.slice(end);', 'resident frames decode', 'property-resident'],
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
