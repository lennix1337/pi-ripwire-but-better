import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { page, tailStart, evidence, execute, captureText } from '../src/core.ts';
import { CASES, rng, pick, int } from './property-support.mjs';

// One character of each UTF-8 width (1 to 4 bytes), a combining mark and line breaks: a page must never split any of them.
const ALPHABET = ['a', 'Z', ' ', '\n', '\t', 'é', 'ß', '€', '漢', '😀', '𝄞', 'e\u0301'];
const LIMITS = [4, 5, 7, 8, 16, 100, 4000, 6000, 12000];

const randomText = next => Array.from({ length: pick(next, [0, 1, 3, 40, 400, 1500]) }, () => pick(next, ALPHABET)).join('');
const randomLimit = next => (next() < 0.5 ? pick(next, LIMITS) : int(next, 4, 12000));

// Byte offsets where each code point starts, plus the end. Walks the string by code point, not by UTF-8 bit patterns.
function boundaries(text) {
  const marks = []; let at = 0;
  for (const ch of text) { marks.push(at); at += Buffer.byteLength(ch); }
  marks.push(at);
  return { marks, total: at };
}

// Model of the contract: the longest run of whole code points after `offset` that fits in `limit` bytes.
function modelEnd(marks, offset, limit) {
  let end = offset;
  for (const mark of marks) if (mark > offset && mark <= offset + limit) end = mark;
  return end;
}

test('pagination walks any UTF-8 text back to itself on character boundaries within the limit', () => {
  for (let seed = 1; seed <= CASES; seed++) {
    const next = rng(seed); const text = randomText(next);
    const { marks, total } = boundaries(text); const limit = randomLimit(next);
    let offset = 0; let restored = '';
    for (let pages = 0; ; pages++) {
      assert.ok(pages <= total + 1, `seed ${seed}: walk does not end`);
      const expected = modelEnd(marks, offset, limit);
      const got = page(text, offset, limit);
      assert.equal(got.totalBytes, total, `seed ${seed}: totalBytes`);
      assert.equal(got.offset, offset, `seed ${seed}: offset echoed`);
      assert.equal(got.output, Buffer.from(text).subarray(offset, expected).toString('utf8'), `seed ${seed} offset ${offset} limit ${limit}: maximal whole-character page`);
      assert.ok(Buffer.byteLength(got.output) <= limit, `seed ${seed} offset ${offset}: page over limit ${limit}`);
      assert.equal(got.nextOffset, expected < total ? expected : null, `seed ${seed} offset ${offset}: nextOffset`);
      restored += got.output;
      if (got.nextOffset === null) break;
      assert.ok(got.nextOffset > offset, `seed ${seed}: no progress at ${offset}`);
      offset = got.nextOffset;
    }
    assert.equal(restored, text, `seed ${seed} limit ${limit}: pages do not rebuild the text`);
  }
});

test('pagination rejects every offset inside a character', () => {
  for (let seed = 1; seed <= CASES; seed++) {
    const next = rng(seed); const text = randomText(next);
    const { marks, total } = boundaries(text); const starts = new Set(marks);
    const interior = Array.from({ length: total }, (_, i) => i).filter(i => !starts.has(i));
    for (let k = 0; k < 10 && interior.length; k++) {
      const offset = pick(next, interior);
      assert.throws(() => page(text, offset, 4000), /UTF-8 code point boundary/, `seed ${seed} offset ${offset}`);
    }
  }
});

// The page a check returns: the last `limit` bytes of the log, starting on a character.
test('the tail page starts on a character, fits the limit and reaches the end of the text', () => {
  let whole = 0; let moved = 0;
  for (let seed = 1; seed <= CASES; seed++) {
    const next = rng(seed); const text = randomText(next);
    const { marks, total } = boundaries(text); const limit = randomLimit(next);
    // Model of the contract: the earliest character start from which the rest of the text fits in `limit` bytes.
    const expected = marks.find(mark => total - mark <= limit);
    const start = tailStart(text, limit);
    assert.equal(start, expected, `seed ${seed} limit ${limit} of ${total} bytes: tail does not start at the earliest character that fits`);
    const got = page(text, start, limit);
    assert.equal(got.offset + Buffer.byteLength(got.output), total, `seed ${seed}: tail page stops before the end`);
    assert.equal(got.nextOffset, null, `seed ${seed}: nothing follows the tail page`);
    assert.equal(got.output, Buffer.from(text).subarray(expected).toString('utf8'), `seed ${seed} limit ${limit}: tail page is not the end of the text`);
    if (total <= limit) { whole++; assert.equal(start, 0, `seed ${seed}: a text shorter than one page is returned whole`); }
    else if (start !== total - limit) moved++;
  }
  // The generator must keep producing both shapes, or the property above proves less than it says.
  assert.ok(whole > 0, 'no generated text was shorter than one page');
  assert.ok(moved > 0, 'no generated cut fell inside a multi-byte character');
});

test('saved evidence pages the same bytes as the in-memory pager', async () => {
  const store = await mkdtemp(path.join(os.tmpdir(), 'rw-page-prop-'));
  try {
    for (let seed = 1; seed <= CASES; seed++) {
      const next = rng(seed); const text = randomText(next);
      const { marks } = boundaries(text);
      const id = randomUUID();
      await writeFile(path.join(store, `${id}.json`), JSON.stringify({ id }));
      await writeFile(path.join(store, `${id}.log`), text);
      for (let k = 0; k < 4; k++) {
        const offset = pick(next, marks); const limit = int(next, 4, 12000);
        const memory = page(text, offset, limit);
        const saved = await evidence({ store, id, offset, limit });
        assert.deepEqual(
          { output: saved.output, nextOffset: saved.nextOffset, totalBytes: saved.totalBytes },
          { output: memory.output, nextOffset: memory.nextOffset, totalBytes: memory.totalBytes },
          `seed ${seed} offset ${offset} limit ${limit}: saved and in-memory pagers disagree`,
        );
      }
    }
  } finally {
    await rm(store, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

// A process capture cut at the byte limit must stay a clean prefix: a character split by the cut is dropped, not decoded to U+FFFD.
test('bounded process capture never ends inside a character', async () => {
  const text = 'aé€😀'.repeat(2); // 1-, 2-, 3- and 4-byte characters: most limits cut one
  const total = Buffer.byteLength(text);
  for (let limit = 1; limit < total; limit++) {
    const result = await execute(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(text)})`], { limit });
    assert.equal(result.truncated, true, `limit ${limit}: capture reports truncation`);
    assert.ok(!result.output.includes('\uFFFD'), `limit ${limit}: capture invented a replacement character from a split one`);
    assert.ok(text.startsWith(result.output), `limit ${limit}: capture is not a prefix of the output`);
    assert.ok(Buffer.byteLength(result.output) <= limit, `limit ${limit}: capture over the limit`);
  }
});

test('captured output keeps the longest whole-character prefix at any cut', () => {
  for (let seed = 1; seed <= CASES; seed++) {
    const next = rng(seed); const text = randomText(next);
    const { marks, total } = boundaries(text); const bytes = Buffer.from(text);
    const cut = int(next, 0, total);
    const captured = bytes.subarray(0, cut);
    const whole = Math.max(...marks.filter(mark => mark <= cut));
    assert.equal(captureText(captured, true), bytes.subarray(0, whole).toString('utf8'), `seed ${seed} cut ${cut} of ${total}: partial character kept or whole one dropped`);
    assert.equal(captureText(captured, false), captured.toString('utf8'), `seed ${seed} cut ${cut}: an untruncated capture decodes unchanged`);
  }
});
