// @ts-nocheck -- untyped JavaScript kept in a .ts file so Pi's /reload re-reads it (see test/loader.test.mjs); it was never type-checked as .mjs.
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { execute, fingerprint, loadRecipes, projectChecks } from './core.ts';

async function gitRoot(dir) {
  const result = await execute('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { timeout: 10000 });
  return result.code === 0 ? realpath(result.output.trim()) : null;
}

const watched = (recipe, relative) => !recipe.watch || recipe.watch.some(prefix => relative === prefix || relative.startsWith(prefix.replace(/[\\/]?$/, '/')));

function note(result) {
  const seconds = (result.elapsedMs / 1000).toFixed(1);
  const head = `[autocheck] ${path.basename(result.root)} ${result.name}`;
  if (result.status === 'passed') return `${head} passed in ${seconds} s on the current sources (receipt ${result.id}); project_checks returns it without re-running.`;
  return `${head} FAILED (exit ${result.exitCode}, ${seconds} s, receipt ${result.id}):\n${result.output.slice(0, 1500)}`;
}

// After an edit, run the repository's onEdit recipes in the background so the explicit project_checks call,
// or the next tool result, already has the answer. Results are reused only for the identical source digest.
export function createAutocheck({ run = projectChecks, fingerprintOf = fingerprint, recipesOf = loadRecipes, rootOf = gitRoot, debounceMs = 750, maxAgeMs = 600000, now = Date.now } = {}) {
  const roots = new Map(); const dirs = new Map(); const unconfigured = new Set(); let notes = [];
  const state = root => roots.get(root) ?? roots.set(root, { timer: null, controller: null, running: null, runningName: null, halt: false, results: new Map() }).get(root);

  // Runs one recipe of a sweep and records its note. Returns false when the sweep must stop.
  async function runOne(root, s, name, signal) {
    s.runningName = name;
    s.running = run({ root, name, signal, speculative: true });
    let result;
    try { result = await s.running; } catch (error) {
      // CHECK_ACTIVE: an explicit or foreign check owns the repository; it will produce its own evidence.
      // An aborted sweep was superseded by a newer edit or an explicit call.
      if (error.code !== 'CHECK_ACTIVE' && !signal.aborted) notes.push(`[autocheck] ${path.basename(root)} ${name} could not run: ${error.message}`);
      return false;
    } finally { s.running = null; s.runningName = null; }
    if (result.status !== 'passed' && result.status !== 'failed') {
      // A newer edit already reschedules a superseded run; anything else (sources changed by a tool or the
      // recipe itself, timeout, uncertain exit) leaves no result, so the agent must hear about it.
      if (!signal.aborted) notes.push(`[autocheck] ${path.basename(root)} ${name} ended ${result.status} (receipt ${result.id}); nothing to reuse, so project_checks will run it again.`);
      return false;
    }
    s.results.set(name, { result, at: now() });
    notes.push(note(result));
    return true;
  }

  async function sweep(root, names) {
    const s = state(root);
    // A run cancelled by the previous edit still holds the lock until its process exits.
    if (s.running) await s.running.catch(() => { /* Its own sweep already handled the outcome. */ });
    const controller = new AbortController(); s.controller = controller; s.halt = false;
    for (const name of names) {
      if (controller.signal.aborted || s.halt || !(await runOne(root, s, name, controller.signal))) break;
    }
    if (s.controller === controller) s.controller = null;
  }

  async function edited(file) {
    const dir = path.dirname(file);
    if (!dirs.has(dir)) dirs.set(dir, await rootOf(dir));
    const root = dirs.get(dir);
    if (!root) return;
    let config;
    try { ({ config } = await recipesOf(root)); } catch (error) {
      // Nothing to run. Tell the agent once per repository, not the user on every edit.
      if (error.code !== 'NO_RECIPES') throw error;
      if (!unconfigured.has(root)) {
        unconfigured.add(root);
        notes.push(`[autocheck] ${path.basename(root)} has no .pi/checks.json, so edits run no checks. Add one before running a gate by hand a second time.`);
      }
      return;
    }
    const relative = path.relative(root, path.resolve(file)).split(path.sep).join('/');
    const names = Object.entries(config.checks).filter(([, recipe]) => recipe.onEdit && watched(recipe, relative)).map(([name]) => name);
    if (!names.length) return;
    const s = state(root);
    s.results.clear();
    notes = notes.filter(line => !line.startsWith(`[autocheck] ${path.basename(root)} `));
    s.controller?.abort();
    clearTimeout(s.timer);
    s.timer = setTimeout(() => { s.timer = null; void sweep(root, names); }, debounceMs);
  }

  async function reusable(root, s, name) {
    const hit = s.results.get(name);
    if (!hit || now() - hit.at > maxAgeMs || !hit.result.unchanged) return null;
    const [current, recipes] = await Promise.all([fingerprintOf(root), recipesOf(root)]);
    if (current.digest !== hit.result.after.digest || recipes.digest !== hit.result.recipeDigest) return null;
    notes = notes.filter(line => !line.includes(hit.result.id));
    return { ...hit.result, reused: { ageMs: now() - hit.at, basis: 'onEdit run on the identical HEAD/diff/untracked digest; ignored inputs not covered. Pass fresh=true to re-run.' } };
  }

  // Called before an explicit project_checks run. Returns a reusable result, or null after making sure no
  // speculative run still holds the repository lock. Reusing a result never interrupts the sweep in progress.
  async function claim(root, name, { fresh = false } = {}) {
    const s = roots.get(root);
    if (!s) return null;
    if (s.running && s.runningName === name) await s.running.catch(() => { /* The sweep records its own failure. */ });
    const hit = fresh ? null : await reusable(root, s, name);
    if (hit) return hit;
    clearTimeout(s.timer); s.timer = null;
    s.halt = true;
    if (s.running) {
      s.controller?.abort();
      await s.running.catch(() => { /* The sweep records its own failure; the explicit run proceeds either way. */ });
    }
    return null;
  }

  return {
    edited,
    claim,
    drainNotes() { const out = notes; notes = []; return out; },
    dispose() { for (const s of roots.values()) { clearTimeout(s.timer); s.controller?.abort(); } },
  };
}
