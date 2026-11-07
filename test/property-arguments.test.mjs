import test from 'node:test';
import assert from 'node:assert/strict';
import { actions, ripwireArgs } from '../src/core.ts';
import { CASES, rng, pick } from './property-support.mjs';

// The allow-list is a security boundary: a new action must be added here on purpose.
const ALLOWED = ['map', 'task', 'search', 'symbol', 'callers', 'callees', 'impact', 'exemplar', 'edit_check', 'quality', 'test_gate'];
const VERB_FLAG = { task: 'for', search: 'grep', symbol: 'around', callers: 'callers', callees: 'callees', impact: 'impact', exemplar: 'exemplar', edit_check: 'edit-check' };
const FIXED_FLAGS = { map: ['--top-k=12', '--max-tokens=2200'], task: ['--token-budget=2200'], search: ['--limit=12'], quality: ['--quality-delta'], test_gate: ['--test-gate'] };
const HOSTILE_ACTIONS = ['shell', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', ' map', 'map ', 'MAP', 'Search', 'edit-check', 'search\u0000', ''];
const ROOTS = ['/repo', 'C:\\repo', '/tmp/a b', '/x; rm -rf /'];
const PLAIN = ['a', 'Z', '9', ' ', '-', '=', ';', '&', '|', '`', '$', '"', "'", '\\', '/', '\u00e9', '\ud83d\ude00', '\u2028', '\u007f'];
const CONTROL = ['\n', '\t', '\r', '\u0000', '\u001f'];

const randomAction = next => (next() < 0.7 ? pick(next, ALLOWED) : pick(next, HOSTILE_ACTIONS));

// About one query in five carries a single control character, so most accepted cases stay accepted.
const randomQuery = next => {
  const chars = Array.from({ length: pick(next, [0, 1, 5, 40, 200, 2000, 2001]) }, () => pick(next, PLAIN));
  if (chars.length && next() < 0.2) chars[Math.floor(next() * chars.length)] = pick(next, CONTROL);
  return chars.join('');
};

// Model: the first refusal that applies (action, then query, then blank verb), or null when accepted.
function refusal(action, query) {
  if (!ALLOWED.includes(action)) return 'Unknown Ripwire action';
  if (typeof query !== 'string' || query.length > 2000 || query.split('').some(c => c.charCodeAt(0) < 0x20)) return 'Invalid query';
  if (VERB_FLAG[action] && query.trim() === '') return `${action} requires query`;
  return null;
}

// Model of accepted argv: the root, the query in one `--flag=` slot, the fixed flags for the action, then the legend.
function argv(root, action, query) {
  return [root, ...(VERB_FLAG[action] ? [`--${VERB_FLAG[action]}=${query}`] : []), ...(FIXED_FLAGS[action] ?? []), '--legend=compact'];
}

test('ripwire admits exactly the listed actions and keeps any query inside one data slot', () => {
  assert.deepEqual([...actions], ALLOWED);
  for (let seed = 1; seed <= CASES; seed++) {
    const next = rng(seed);
    const root = pick(next, ROOTS); const action = randomAction(next); const query = randomQuery(next);
    const want = refusal(action, query);
    const shown = `seed ${seed} action ${JSON.stringify(action)} query length ${query.length}`;
    if (want) assert.throws(() => ripwireArgs(root, action, query), { message: want }, shown);
    else assert.deepEqual(ripwireArgs(root, action, query), argv(root, action, query), shown);
  }
});

test('ripwire refuses every hostile action name and every C0 control character in a query', () => {
  for (const action of HOSTILE_ACTIONS) assert.throws(() => ripwireArgs('/repo', action, 'x'), { message: 'Unknown Ripwire action' }, JSON.stringify(action));
  for (let code = 0; code < 32; code++) {
    const query = `a${String.fromCharCode(code)}b`;
    assert.throws(() => ripwireArgs('/repo', 'search', query), { message: 'Invalid query' }, `control ${code}`);
    assert.throws(() => ripwireArgs('/repo', 'map', query), { message: 'Invalid query' }, `control ${code} on a query-less action`);
  }
  assert.deepEqual(ripwireArgs('/repo', 'search', '\u007f'), argv('/repo', 'search', '\u007f'), 'DEL is not a C0 control character');
});

test('ripwire length bound is 2000 characters, and a verb needs a non-blank query', () => {
  assert.deepEqual(ripwireArgs('/repo', 'search', 'a'.repeat(2000)), argv('/repo', 'search', 'a'.repeat(2000)));
  assert.throws(() => ripwireArgs('/repo', 'search', 'a'.repeat(2001)), { message: 'Invalid query' });
  for (const blank of ['', ' ', '\u00a0', '\u2028']) assert.throws(() => ripwireArgs('/repo', 'task', blank), { message: 'task requires query' }, JSON.stringify(blank));
  assert.deepEqual(ripwireArgs('/repo', 'map', ''), argv('/repo', 'map', ''), 'map ignores its query');
});
