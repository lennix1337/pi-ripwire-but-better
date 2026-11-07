// @ts-nocheck -- untyped JavaScript kept in a .ts file so Pi's /reload re-reads it (see test/loader.test.mjs); it was never type-checked as .mjs.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, open, realpath, stat, readdir, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { profiles } from './profiles.ts';

export const actions = ['map', 'task', 'search', 'symbol', 'callers', 'callees', 'impact', 'exemplar', 'edit_check', 'quality', 'test_gate'];
const hash = value => createHash('sha256').update(value).digest('hex');
const maxLog = 4 * 1024 * 1024;
export const defaultStore = () => process.env.PI_RIPWIRE_EVIDENCE_DIR || path.join(os.homedir(), '.pi', 'agent', 'evidence', 'pi-ripwire');
// quality/test_gate/edit_check build a HEAD checkout; killing them mid-way is what leaves stale trees behind.
const slowActions = new Set(['quality', 'test_gate', 'edit_check']);
export const navigationTimeout = action => slowActions.has(action) ? 120000 : 60000;

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

const cacheBases = () => [...new Set([process.env.XDG_CACHE_HOME, process.env.TMPDIR, process.env.TMP, process.env.TEMP, os.tmpdir()].filter(Boolean).map(dir => path.resolve(dir)))];

// Ripwire checks HEAD out into <cache>/ripwire-qhead-<pid> and removes it on a normal exit. A killed run
// leaves it behind, and every later Ripwire call then slows by seconds (Genexus18MCP grep: 10-21 s with four
// stale trees, 0.6 s without). Only trees whose owning process is gone are removed.
export async function reapStaleHeadTrees({ bases = cacheBases(), alive = pidAlive } = {}) {
  const removed = [];
  for (const base of bases) {
    let caches;
    try { caches = (await readdir(base)).filter(name => /^ripwire-\d+$/.test(name)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const cache of caches) {
      for (const entry of await readdir(path.join(base, cache))) {
        const pid = /^ripwire-qhead-(\d+)$/.exec(entry)?.[1];
        if (!pid || alive(Number(pid))) continue;
        await rm(path.join(base, cache, entry), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        removed.push(path.join(base, cache, entry));
      }
    }
  }
  return removed;
}

// The output goes to a model, not a terminal: color codes are tokens that carry nothing (pwsh error records were ~18% escapes).
function plainOutputEnv() {
  const { FORCE_COLOR: _forced, ...env } = process.env;
  return { ...env, NO_COLOR: '1' };
}

// `stderr: false` drops diagnostics from the output, for callers that hash it as data.
export async function execute(command, args, { cwd, signal, timeout = 30000, limit = maxLog, stderr = true } = {}) {
  if (signal?.aborted) throw new Error('Cancelled before execution');
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env: plainOutputEnv(), shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', stderr ? 'pipe' : 'ignore'] });
    } catch (error) {
      error.notStarted = true;
      reject(error);
      return;
    }
    const chunks = []; let bytes = 0; let reason; let killTimer;
    const stop = why => {
      if (reason) return;
      reason = why;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
        killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }, 500);
      }
    };
    const collect = data => { const room = limit - bytes; if (room > 0) chunks.push(data.subarray(0, room)); bytes += data.length; if (bytes > limit) stop('output_limit'); };
    child.stdout.on('data', collect); child.stderr?.on('data', collect);
    const abort = () => stop('cancelled'); signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('timeout'), timeout);
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); };
    // A spawn failure (ENOENT, EACCES) fires before the process exists: pid is undefined and nothing ran.
    child.on('error', error => { cleanup(); if (child.pid === undefined) error.notStarted = true; reject(error); });
    child.on('close', (code, terminationSignal) => {
      cleanup(); resolve({ code, signal: terminationSignal, reason, output: Buffer.concat(chunks).toString('utf8'), bytes, truncated: bytes > limit });
    });
  });
}

export async function repositoryRoot(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) throw new Error('Use an absolute repository root');
  const root = await realpath(input);
  const result = await execute('git', ['-C', root, 'rev-parse', '--show-toplevel']);
  if (result.code !== 0) throw new Error(`Project must be a Git repository root: ${root} is not a Git repository; pass the root of one repository, not a folder that groups several`);
  const actual = await realpath(result.output.trim());
  if (actual !== root) throw new Error(`Use the single repository root: ${actual}`);
  return root;
}

export function ripwireArgs(root, action, query = '') {
  if (!actions.includes(action)) throw new Error('Unknown Ripwire action');
  if (typeof query !== 'string' || query.length > 2000 || /[\x00-\x1f]/.test(query)) throw new Error('Invalid query');
  const verbs = { task: 'for', search: 'grep', symbol: 'around', callers: 'callers', callees: 'callees', impact: 'impact', exemplar: 'exemplar', edit_check: 'edit-check' };
  if (verbs[action] && !query.trim()) throw new Error(`${action} requires query`);
  const args = [root];
  if (verbs[action]) args.push(`--${verbs[action]}=${query}`);
  if (action === 'map') args.push('--top-k=12', '--max-tokens=2200');
  if (action === 'task') args.push('--token-budget=2200');
  if (action === 'search') args.push('--limit=12');
  if (action === 'quality') args.push('--quality-delta');
  if (action === 'test_gate') args.push('--test-gate');
  args.push('--legend=compact');
  return args;
}

export async function fingerprint(root, { canonicalize = realpath } = {}) {
  const git = async args => {
    // Warnings such as core.autocrlf's go to stderr and disappear once Git refreshes the index; they are not source.
    const result = await execute('git', ['-C', root, ...args], { stderr: false });
    if (result.code !== 0 || result.truncated || result.reason) throw new Error('Cannot establish source fingerprint');
    return result.output;
  };
  const diffArgs = ['--binary', '--no-ext-diff', '--no-textconv'];
  // Independent read-only Git queries; no cached success or skipped source checks.
  const [revision, diff, staged, untracked] = await Promise.all([
    execute('git', ['-C', root, 'rev-parse', '--verify', '--quiet', 'HEAD']),
    git(['diff', ...diffArgs]),
    git(['diff', '--cached', ...diffArgs]),
    git(['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  if (![0, 1].includes(revision.code) || revision.reason) throw new Error('Cannot establish repository revision');
  const head = revision.code === 0 ? revision.output.trim() : 'unborn';
  const files = untracked.split('\0').filter(Boolean).sort();
  const state = createHash('sha256').update(JSON.stringify([head, diff, staged])); let bytes = 0;
  // Every untracked file is checked against the same root: canonicalise it once, not once per file.
  const canonicalRoot = await canonicalize(root);
  const containedRoot = target => target === root ? canonicalRoot : canonicalize(target);
  // Bound I/O concurrency and retain sorted hashing order and the input budget.
  for (let offset = 0; offset < files.length; offset += 8) {
    const batch = await Promise.all(files.slice(offset, offset + 8).map(async file => {
      const target = await contained(root, file, { canonicalize: containedRoot });
      return { file, target, info: await stat(target) };
    }));
    for (const { info } of batch) {
      bytes += info.size;
      if (bytes > 64 * 1024 * 1024 || !info.isFile()) throw new Error('Untracked inputs exceed fingerprint budget; use a clean snapshot');
    }
    const contents = await Promise.all(batch.map(async ({ target }) => hash(await readFile(target))));
    for (let i = 0; i < batch.length; i++) {
      // Frame filenames and contents so a+bc cannot collide with ab+c.
      state.update(JSON.stringify([batch[i].file, contents[i]]));
    }
  }
  return { head, digest: state.digest('hex'), scope: 'HEAD + staged/unstaged diffs + nonignored untracked contents; ignored build/dependency inputs not covered' };
}

export async function contained(root, relative, { canonicalize = realpath } = {}) {
  // Independent canonicalisations, requested together: one filesystem round trip instead of two in sequence.
  const [candidate, canonicalRoot] = await Promise.all([canonicalize(path.resolve(root, relative)), canonicalize(root)]);
  // Compare canonical to canonical: a root reached through a link or an 8.3 short name
  // would otherwise make every file inside it look like an escape.
  const rel = path.relative(canonicalRoot, candidate);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Path escapes project');
  return candidate;
}

async function save(store, id, output, receipt) {
  await mkdir(store, { recursive: true });
  await writeFile(path.join(store, `${id}.log`), output, { mode: 0o600 });
  await writeFile(path.join(store, `${id}.json`), JSON.stringify(receipt, null, 2), { mode: 0o600 });
}

export async function navigate({ root, action, query = '', signal, store = defaultStore(), binary = 'ripwire' }) {
  root = await repositoryRoot(root);
  const id = randomUUID(); const started = Date.now();
  const result = await execute(binary, ripwireArgs(root, action, query), { cwd: root, signal, timeout: navigationTimeout(action) });
  const receipt = { schema: 'pi-ripwire/v1', id, kind: 'navigation', root, action, status: result.reason || (result.code === 0 ? 'completed' : 'nonzero_exit'), exitCode: result.code, elapsedMs: Date.now() - started, capturedBytes: Buffer.byteLength(result.output), truncated: result.truncated, interpretation: 'CLI evidence only; nonzero quality/test-gate codes are not automatically execution failures' };
  if (result.reason) {
    try { receipt.reapedHeadTrees = (await reapStaleHeadTrees()).length; } catch (error) { receipt.reapError = error.message; }
  }
  await save(store, id, result.output, receipt);
  return { ...receipt, ...page(result.output, 0, 6000) };
}

export const residentActions = new Set(['search', 'task']);

/** search/task through a session-owned MCP server; a transport failure is reported, never replayed through the CLI. */
export async function navigateResident({ root, action, query = '', signal, store = defaultStore(), resident }) {
  root = await repositoryRoot(root);
  const id = randomUUID(); const started = Date.now();
  const result = await resident.navigate(root, action, query, { signal })
    .catch(error => ({ code: null, output: error.message, truncated: false, reason: 'transport_error' }));
  const receipt = { schema: 'pi-ripwire/v1', id, kind: 'navigation', root, action, transport: 'mcp-stdio', ...(result.metadata ? { protocol: result.metadata } : {}), status: result.reason || (result.code === 0 ? 'completed' : 'nonzero_exit'), exitCode: result.code, elapsedMs: Date.now() - started, capturedBytes: Buffer.byteLength(result.output), truncated: result.truncated, interpretation: 'Native MCP read result; protocol freshness retained. Not CLI-output parity or full project validation.' };
  await save(store, id, result.output, receipt);
  return { ...receipt, ...page(result.output, 0, 6000) };
}

function page(output, offset, limit) {
  const bytes = Buffer.from(output);
  if (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) throw new Error('Offset must be a UTF-8 code point boundary; use nextOffset');
  let end = Math.min(bytes.length, offset + limit);
  while (end > offset && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return { output: bytes.subarray(offset, end).toString('utf8'), offset, nextOffset: end < bytes.length ? end : null, totalBytes: bytes.length };
}

export async function evidence({ id, offset = 0, limit = 6000, store = defaultStore() }) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid evidence id');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 4 || limit > 12000) throw new Error('Invalid page bounds');
  let receipt; let file;
  try {
    receipt = JSON.parse(await readFile(path.join(store, `${id}.json`), 'utf8'));
    file = await open(path.join(store, `${id}.log`), 'r');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('No saved evidence for this id; use an id from a ripwire or project_checks receipt on this machine. Nothing was re-run.');
    throw error;
  }
  try {
    const { size } = await file.stat();
    // One lookahead byte identifies a UTF-8 boundary without loading the full log.
    const buffer = Buffer.alloc(Math.min(limit + 1, Math.max(0, size - offset)));
    let loaded = 0;
    while (loaded < buffer.length) {
      const { bytesRead } = await file.read(buffer, loaded, buffer.length - loaded, offset + loaded);
      if (!bytesRead) throw new Error('Evidence changed during read; inspect receipt before retrying');
      loaded += bytesRead;
    }
    if (loaded && (buffer[0] & 0xc0) === 0x80) throw new Error('Offset must be a UTF-8 code point boundary; use nextOffset');
    let end = Math.min(limit, loaded);
    while (end > 0 && end < loaded && (buffer[end] & 0xc0) === 0x80) end--;
    return { ...receipt, freshness: 'historical receipt; never auto-reused', output: buffer.subarray(0, end).toString('utf8'), offset, nextOffset: offset + end < size ? offset + end : null, totalBytes: size };
  } finally {
    await file.close();
  }
}

function validateEditTrigger(name, { onEdit, watch, parallel }) {
  if (parallel !== undefined && typeof parallel !== 'boolean') throw new Error(`parallel must be a boolean: ${name}`);
  if (onEdit !== undefined && typeof onEdit !== 'boolean') throw new Error(`onEdit must be a boolean: ${name}`);
  const relativePrefix = x => typeof x === 'string' && x && !path.isAbsolute(x) && !x.split(/[\\/]/).includes('..');
  if (watch !== undefined && (!Array.isArray(watch) || watch.length > 20 || !watch.every(relativePrefix))) throw new Error(`watch must list up to 20 relative path prefixes: ${name}`);
}

function validateRecipe(name, recipe) {
    if (!/^[a-z][a-z0-9_-]{0,50}$/.test(name) || !Array.isArray(recipe.argv) || !recipe.argv.length || recipe.argv.some(x => typeof x !== 'string' || !x || x.includes('\0')) || recipe.argv.length > 100) throw new Error(`Invalid recipe: ${name}`);
    if (!Number.isInteger(recipe.timeoutMs) || recipe.timeoutMs < 100 || recipe.timeoutMs > 600000) throw new Error(`Invalid timeout: ${name}`);
    if (typeof recipe.description !== 'string' || recipe.description.length > 300) throw new Error(`Missing bounded description: ${name}`);
  validateEditTrigger(name, recipe);
}

export async function loadRecipes(root, { canonicalize = realpath } = {}) {
  let raw; let origin = '.pi/checks.json';
  try {
    const filename = await contained(root, origin, { canonicalize });
    if ((await stat(filename)).size > 65536) throw new Error('Recipe file too large');
    raw = await readFile(filename, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    for (const profile of profiles) {
      const present = await Promise.all(profile.sentinels.map(async file => {
        try { return (await stat(await contained(root, file, { canonicalize }))).isFile(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      }));
      if (present.every(Boolean)) { raw = JSON.stringify({ version: 1, checks: profile.checks }); origin = `built-in:${profile.name}`; break; }
    }
    if (!raw) throw Object.assign(new Error('No recipes found. Add .pi/checks.json using the documented version 1 format. Nothing executed.'), { code: 'NO_RECIPES' });
  }
  const config = JSON.parse(raw);
  if (config.version !== 1 || !config.checks || typeof config.checks !== 'object' || Array.isArray(config.checks)) throw new Error('Expected recipe version 1 and checks object');
  const entries = Object.entries(config.checks);
  for (const [name, recipe] of entries) validateRecipe(name, recipe);
  // Working directories are independent of one another: check them together, then report the first failure in recipe order.
  const checked = await Promise.allSettled(entries.map(([, recipe]) => contained(root, recipe.cwd || '.', { canonicalize })));
  const failed = checked.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return { config, digest: hash(raw), origin };
}

// The exclusive marker is `lockPath`; parallel runs each hold `lockPath.<uuid>`. A starter creates its own marker first
// and then looks for a conflicting one, so two processes that start together both see the other and one backs off.
async function exclusiveHolder(lockPath) {
  let marker;
  try { marker = JSON.parse(await readFile(lockPath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; marker = {}; /* Unreadable or half-written marker: treat as a non-speculative uncertain run. */ }
  if (marker.speculative && !pidAlive(marker.pid)) {
    // onEdit recipes are declared side-effect free, so a speculative marker whose Pi process died is safe to clear.
    await unlink(lockPath);
    return null;
  }
  const error = new Error(marker.speculative ? `An automatic onEdit check (${marker.name}) is running for this repository; call again when it ends.` : heldMessage(marker, lockPath));
  error.code = 'CHECK_ACTIVE';
  return error;
}

async function parallelMarkers(lockPath, except = '') {
  const prefix = `${path.basename(lockPath)}.`;
  const names = (await readdir(path.dirname(lockPath))).filter(n => n.startsWith(prefix) && path.join(path.dirname(lockPath), n) !== except);
  return Promise.all(names.map(async n => {
    const file = path.join(path.dirname(lockPath), n);
    try { return { file, marker: JSON.parse(await readFile(file, 'utf8')) }; } catch (error) { return error.code === 'ENOENT' ? null : { file, marker: {} }; }
  })).then(found => found.filter(Boolean));
}

async function acquireLock(lockPath, { shared = false, name } = {}) {
  if (shared) {
    const own = `${lockPath}.${randomUUID()}`;
    const handle = await open(own, 'wx', 0o600);
    const held = await exclusiveHolder(lockPath);
    if (held) { await handle.close(); await unlink(own); throw held; }
    return Object.assign(handle, { path: own });
  }
  let handle;
  try { handle = await open(lockPath, 'wx', 0o600); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const held = await exclusiveHolder(lockPath);
    if (held) throw held;
    handle = await open(lockPath, 'wx', 0o600);
  }
  // A parallel run of this process finished before we got here (see scheduled); anything left is another process or an uncertain end.
  const others = await parallelMarkers(lockPath);
  if (others.length) {
    await handle.close(); await unlink(lockPath);
    const error = new Error(`${others.length} parallel check(s) ${others.map(o => `"${o.marker.name ?? 'unknown'}"`).join(', ')} hold this repository (running in another Pi process, or ended with an uncertain outcome: read project_evidence${others[0].marker.id ? ` id=${others[0].marker.id}` : ''}, then remove ${others[0].file}); call again when they end. Nothing was started.`);
    error.code = 'CHECK_ACTIVE';
    throw error;
  }
  return Object.assign(handle, { path: lockPath });
}

// Explicit runs of this process are queued (see queued), so a marker of this process, or of a process that is gone,
// was left by a run that ended without a recorded outcome; a live foreign pid is another Pi session or subagent.
function heldMessage(marker, lockPath) {
  const check = `Check "${marker.name ?? 'unknown'}"${marker.id ? ` (run ${marker.id})` : ''}`;
  const since = Number.isFinite(marker.started) ? ` since ${new Date(marker.started).toISOString()}` : '';
  if (Number.isInteger(marker.pid) && marker.pid !== process.pid && pidAlive(marker.pid)) {
    return `${check} is running in process ${marker.pid}${since}, another Pi session or subagent; call again when it ends. Nothing was started.`;
  }
  const evidence = marker.id ? `read project_evidence id=${marker.id}` : 'no receipt was recorded';
  return `${check} ended with its outcome uncertain${since}: ${evidence}. Its marker ${lockPath} blocks this repository until it is removed; remove it once you know what that run did, then call again. Nothing was started; never blindly replay.`;
}

// Pi runs a reply's tool calls together: over 14 days, 25 of 35 "check active" refusals were a second check of the same
// reply (typecheck + unit). Explicit checks of one repository from this process therefore take turns, in call order:
// recipes that declare `parallel` (they write nothing the source fingerprint sees) share a turn, every other one is alone in it.
const schedules = new Map();
function scheduled(lockPath, shared, run) {
  const state = schedules.get(lockPath) ?? { active: 0, exclusive: false, waiting: [] };
  schedules.set(lockPath, state);
  const pump = () => {
    while (state.waiting.length) {
      const job = state.waiting[0];
      if (job.shared ? state.exclusive : state.active > 0) break;
      state.waiting.shift(); state.active++; state.exclusive = !job.shared;
      job.run().then(job.resolve, job.reject).finally(() => {
        state.active--; if (!state.active) state.exclusive = false;
        if (!state.active && !state.waiting.length) schedules.delete(lockPath); else pump();
      });
    }
  };
  return new Promise((resolve, reject) => { state.waiting.push({ shared, run, resolve, reject }); pump(); });
}

function checkFailureMessage(error) {
  if (!error.notStarted) return error.message;
  const shellHint = process.platform === 'win32' ? ' Windows .cmd/.bat shims require an explicit shell recipe; commands run with shell:false.' : '';
  return `${error.message}; Nothing started. Check recipe argv[0], cwd and the Pi process PATH (not only the terminal PATH).${shellHint} No retry or shell fallback was attempted.`;
}

export async function projectChecks({ root, name = '', signal, store = defaultStore(), speculative = false }) {
  return projectChecksAt(await repositoryRoot(root), { name, signal, store, speculative });
}

// `root` must be a canonical repository root from repositoryRoot(); a caller that has resolved it does not start a second Git subprocess.
export async function projectChecksAt(root, { name = '', signal, store = defaultStore(), speculative = false }) {
  const { config, digest, origin } = await loadRecipes(root);
  if (!name) return { schema: 'pi-ripwire/v1', root, origin, checks: Object.entries(config.checks).map(([name, recipe]) => ({ name, ...recipe })), policy: 'Explicit execution only. Review repository recipes before running; commands are trusted project code, not a sandbox. No automatic retries or evidence reuse.' };
  if (!Object.hasOwn(config.checks, name)) throw new Error('Unknown named check; list checks first');
  const recipe = config.checks[name];
  await mkdir(store, { recursive: true });
  if (speculative && !recipe.onEdit) throw new Error(`Recipe ${name} is not marked onEdit`);
  const lockPath = path.join(store, `${hash(root)}.active`);
  const locked = () => runLocked({ root, name, signal, store, speculative, recipe, digest, origin, lockPath });
  return speculative ? locked() : scheduled(lockPath, recipe.parallel === true, locked);
}

async function runLocked({ root, name, signal, store, speculative, recipe, digest, origin, lockPath }) {
  // A call cancelled while it waited for the one before it never starts and leaves no receipt.
  if (signal?.aborted) throw new Error('Cancelled before execution; nothing was started');
  const lock = await acquireLock(lockPath, { shared: recipe.parallel === true && !speculative, name });
  const id = randomUUID(); const started = Date.now();
  let receipt; let output = ''; let completed = false; let executionStarted = false;
  try {
    await lock.writeFile(JSON.stringify({ id, pid: process.pid, root, name, started, speculative }));
    const before = await fingerprint(root);
    receipt = { schema: 'pi-ripwire/v1', kind: 'check', id, root, name, origin, argv: recipe.argv, recipeDigest: digest, source: before, runtime: { node: process.version, platform: process.platform }, status: 'running', ...(speculative && { trigger: 'onEdit' }) };
    await save(store, id, '', receipt);
    const cwd = await contained(root, recipe.cwd || '.');
    if (signal?.aborted) throw new Error('Cancelled before execution');
    executionStarted = true;
    const result = await execute(recipe.argv[0], recipe.argv.slice(1), { cwd, signal, timeout: recipe.timeoutMs });
    output = result.output;
    const after = await fingerprint(root);
    const unchanged = before.digest === after.digest && digest === (await loadRecipes(root)).digest;
    receipt = { ...receipt, status: result.reason || (result.signal ? 'outcome_uncertain' : !unchanged ? 'source_changed' : result.code === 0 ? 'passed' : 'failed'), exitCode: result.code, elapsedMs: Date.now() - started, unchanged, after, truncated: result.truncated, interpretation: 'Only this named check; ignored inputs and full product flow not validated' };
    // A speculative run we cancelled has exited (execute resolves on close), so its marker carries no uncertainty.
    await save(store, id, output, receipt); completed = (!result.reason && result.signal === null) || (speculative && result.reason === 'cancelled');
    return { ...receipt, ...page(output, 0, 4000) };
  } catch (error) {
    if (error.notStarted) executionStarted = false;
    if (receipt) {
      const message = checkFailureMessage(error);
      await save(store, id, output, { ...receipt, status: executionStarted ? 'outcome_uncertain' : 'not_started', elapsedMs: Date.now() - started, error: message });
      throw new Error(`${message}; inspect project_evidence id=${id} before retrying`, { cause: error });
    }
    throw error;
  } finally {
    await lock.close();
    // Keep the marker if execution/state capture did not complete. User inspects it before removal.
    if (completed || !executionStarted) await unlink(lock.path);
  }
}
