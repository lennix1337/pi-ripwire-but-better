import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { navigationPreview } from '../src/navigation-preview.ts';

const output = await readFile(new URL('./fixtures/grep-v1.xml', import.meta.url), 'utf8');
const receipt = { id: 'fixture', action: 'search', status: 'completed', exitCode: 0, offset: 0,
  output, totalBytes: Buffer.byteLength(output), nextOffset: null, protocol: { freshness: 'reindexed' } };

test('known CLI/MCP legend compacts with exact body, receipt metadata and recovery preserved', () => {
  const before = JSON.stringify(receipt);
  const result = navigationPreview(receipt);
  assert.equal(result.output, output.slice(output.indexOf('-->') + 3));
  assert.equal(result.protocol, receipt.protocol);
  assert.equal(result.totalBytes, receipt.totalBytes);
  assert.equal(result.nextOffset, null);
  assert.match(result.legend, /exhaustive literal only/);
  assert.match(result.legend, /unindexed outside complete\/hits\/total/);
  assert.match(result.recovery, /project_evidence id=fixture/);
  assert.ok(JSON.stringify(result).length < before.length * 0.75);
  assert.equal(JSON.stringify(receipt), before);
});

test('unknown legends, warnings, errors, partial headers and continuation pages are unchanged', () => {
  const changes = [{ status: 'timeout' }, { status: 'output_limit' }, { status: 'nonzero_exit' },
    { exitCode: 1 }, { action: 'task' }, { offset: 100 },
    { output: output.replace('schema=ripwire.grep/v1', 'schema=ripwire.grep/v2') },
    { output: output.replace(' -->', ' New warning. -->') },
    { output: 'warning: stale\n' + output }, { output: output.slice(0, 100) }];
  for (const change of changes) {
    const original = { ...receipt, ...change };
    assert.equal(navigationPreview(original), original);
  }
});

test('known conditional legend fields retain their condensed interpretation', () => {
  const extended = output.replace(' unindexed_files_scanned=', ' line_bytes=N: whole line N bytes; text is a cut prefix. unindexed_files_scanned=')
    .replace(' corpus_pruned_dirs=', ' enc defs=N: the enclosing name has N defs, the row unions them (only above 1). corpus_pruned_dirs=')
    .replace(' -->', ' unindexed count=N: off-index hits, equal to unindexed_hits=; paged by the same window as the f rows. -->');
  const result = navigationPreview({ ...receipt, output: extended });
  assert.equal(result.output, extended.slice(extended.indexOf('-->') + 3));
  assert.match(result.legend, /line_bytes=whole bytes of cut line/);
  assert.match(result.legend, /defs>1 unions/);
});
