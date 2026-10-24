import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, truncate } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { execute, fingerprint, evidence } from '../src/core.ts';

test('untracked filename/content boundaries cannot collide', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rw-audit-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  assert.equal((await execute('git', ['init'], { cwd: root })).code, 0);
  await writeFile(path.join(root, 'a'), 'bc');
  const first = await fingerprint(root);
  await rm(path.join(root, 'a'));
  await writeFile(path.join(root, 'ab'), 'c');
  assert.notEqual((await fingerprint(root)).digest, first.digest);
});

test('batched fingerprints preserve canonical ordering and reject oversized inputs', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rw-batch-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  assert.equal((await execute('git', ['init'], { cwd: root })).code, 0);
  const files = Array.from({ length: 25 }, (_, i) => `file${i}.txt`).sort();
  const expected = createHash('sha256').update(JSON.stringify(['unborn', '', '']));
  for (const file of files) {
    await writeFile(path.join(root, file), file);
    expected.update(JSON.stringify([file, createHash('sha256').update(file).digest('hex')]));
  }
  assert.equal((await fingerprint(root)).digest, expected.digest('hex'));
  await writeFile(path.join(root, 'oversized'), '');
  await truncate(path.join(root, 'oversized'), 65 * 1024 * 1024);
  await assert.rejects(fingerprint(root), /fingerprint budget/);
});

test('UTF-8 pagination rejects offsets inside a code point', async t => {
  const store = await mkdtemp(path.join(os.tmpdir(), 'rw-page-'));
  t.after(() => rm(store, { recursive: true, force: true }));
  const id = '00000000-0000-0000-0000-000000000001';
  await writeFile(path.join(store, `${id}.json`), '{}');
  await writeFile(path.join(store, `${id}.log`), 'A😀BéC');
  const first = await evidence({ store, id, limit: 4 });
  assert.equal(first.output, 'A');
  assert.equal(first.nextOffset, 1);
  const next = await evidence({ store, id, offset: first.nextOffset, limit: 4 });
  assert.equal(next.output, '😀');
  await assert.rejects(evidence({ store, id, offset: 2 }), /UTF-8/);
});

test('large evidence stays bounded and Unicode pages reconstruct the original', async t => {
  const store = await mkdtemp(path.join(os.tmpdir(), 'rw-bounded-'));
  t.after(() => rm(store, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const id = '00000000-0000-0000-0000-000000000002';
  const original = 'result😀é\n'.repeat(2000);
  await writeFile(path.join(store, `${id}.json`), '{}');
  await writeFile(path.join(store, `${id}.log`), original);
  let offset = 0; let restored = '';
  do {
    const page = await evidence({ store, id, offset });
    assert.ok(Buffer.byteLength(page.output) <= 6000);
    assert.equal(page.totalBytes, Buffer.byteLength(original));
    restored += page.output;
    assert.ok(page.nextOffset === null || page.nextOffset > offset);
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(restored, original);
  for (const offset of [Buffer.byteLength(original), Buffer.byteLength(original) + 10]) {
    const empty = await evidence({ store, id, offset });
    assert.equal(empty.output, '');
    assert.equal(empty.nextOffset, null);
  }
  await assert.rejects(evidence({ store, id, offset: Number.MAX_SAFE_INTEGER + 1 }), /bounds/);
});

test('ranged evidence matches canonical UTF-8 paging across boundaries', async t => {
  const store = await mkdtemp(path.join(os.tmpdir(), 'rw-range-'));
  t.after(() => rm(store, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const id = '00000000-0000-0000-0000-000000000004';
  await writeFile(path.join(store, `${id}.json`), '{}');
  for (const original of ['', 'aé中😀z'.repeat(8)]) {
    await writeFile(path.join(store, `${id}.log`), original);
    const bytes = Buffer.from(original);
    for (let offset = 0; offset <= bytes.length; offset++) {
      for (let limit = 4; limit <= 9; limit++) {
        if (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) {
          await assert.rejects(evidence({ store, id, offset, limit }), /UTF-8/);
        } else {
          let end = Math.min(bytes.length, offset + limit);
          while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
          const result = await evidence({ store, id, offset, limit });
          assert.equal(result.output, bytes.subarray(offset, end).toString('utf8'));
          assert.equal(result.nextOffset, end < bytes.length ? end : null);
          assert.equal(result.totalBytes, bytes.length);
        }
      }
    }
  }
});
