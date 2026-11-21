import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { contained } from '../src/core.ts';
import { CASES, rng, pick, int } from './property-support.mjs';

// external: Windows 8.3 paths can alias a repository root.


const base = path.resolve(os.tmpdir(), 'rw-containment');
const realRoot = path.join(base, 'real', 'repo');
const aliasRoot = path.join(base, 'RUNNER~1', 'repo');
const outside = path.join(base, 'real', 'outside');
const links = [[path.join(realRoot, 'escape'), outside], [path.join(realRoot, 'deep', 'link'), path.join(outside, 'deep')]];
const within = (candidate, dir) => candidate === dir || candidate.startsWith(dir + path.sep);

function canonicalize(target) {
  let resolved = path.resolve(target);
  if (within(resolved, aliasRoot)) resolved = realRoot + resolved.slice(aliasRoot.length);
  for (const [link, destination] of links) if (within(resolved, link)) return destination + resolved.slice(link.length);
  return resolved;
}

const SEGMENTS = ['src', 'a.txt', '..', '.', 'escape', 'deep', 'link', '..x', 'x..y', 'repo', 'repo-other', ''];
const ABSOLUTE = [outside, path.join(outside, 'x'), realRoot, aliasRoot, path.join(aliasRoot, 'b'), path.dirname(realRoot), path.join(base, 'real', 'repo-other', 'x')];
const ROOTS = [aliasRoot, realRoot];


function expected(root, relative) {
  const location = canonicalize(path.resolve(root, relative));
  return within(location, realRoot) ? location : 'Path escapes project';
}

async function outcome(root, relative) {
  return contained(root, relative, { canonicalize }).catch(error => error.message);
}

test('containment accepts every relative path up to two segments through an alias or a root', async () => {
  const relatives = [''];
  for (const a of SEGMENTS) {
    relatives.push(a);
    for (const b of SEGMENTS) relatives.push(path.join(a, b));
  }
  for (const root of ROOTS) {
    for (const relative of relatives) {
      assert.equal(await outcome(root, relative), expected(root, relative), `root ${root} relative ${JSON.stringify(relative)}`);
    }
  }
});

test('containment decides random deep and absolute paths exactly as the canonical location does', async () => {
  for (let seed = 1; seed <= CASES; seed++) {
    const next = rng(seed);
    const root = pick(next, ROOTS);
    const relative = next() < 0.1
      ? pick(next, ABSOLUTE)
      : Array.from({ length: int(next, 0, 5) }, () => pick(next, SEGMENTS)).join(path.sep);
    assert.equal(await outcome(root, relative), expected(root, relative), `seed ${seed}: root ${root} relative ${JSON.stringify(relative)}`);
  }
});
