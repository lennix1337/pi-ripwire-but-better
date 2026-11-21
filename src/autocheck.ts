// @ts-nocheck -- untyped JavaScript kept in a .ts file so Pi's /reload re-reads it (see test/loader.test.mjs); it was never type-checked as .mjs.
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { execute, fingerprint, loadRecipes, page, projectChecks, tailStart } from './core.ts';

async function gitRoot(dir) {
  const result = await execute('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { timeout: 10000 });
  return result.code === 0 ? realpath(result.output.trim()) : null;
}

const watched = (recipe, relative) => !recipe.watch || recipe.watch.some(prefix => relative === prefix || relative.startsWith(prefix.replace(/[\\/]?$/, '/')));


function note(result, current) {
  const seconds = (result.elapsedMs / 1000).toFixed(1);
  const head = `[autocheck] ${path.basename(result.root)} ${result.name}`;
  if (current !== true) {
    const why = current === false ? 'sources that have changed since' : `sources it could not confirm are unchanged (${current})`;
    return `${head} ${result.status === 'passed' ? 'passed' : `FAILED (exit ${result.exitCode})`} on ${why} (receipt ${result.id}); it is no evidence about the current code, and project_checks runs it again.`;
  }
  if (result.status === 'passed') return `${head} passed in ${seconds} s on the current sources (receipt ${result.id}); project_checks returns it without re-running.`;
  // external: Test runners often print passing cases first and failures at the end of the log.
  return `${head} FAILED (exit ${result.exitCode}, ${seconds} s, receipt ${result.id}):\n${page(result.output, tailStart(result.output, 1500), 1500).output}`;
}



export function createAutocheck({ run = projectChecks, fingerprintOf = fingerprint, recipesOf = loadRecipes, rootOf = gitRoot, debounceMs = 750, maxAgeMs = 600000, now = Date.now } = {}) {

  const roots = new Map(); const dirs = new Map(); const unconfigured = new Set(); let notes = [];
  const state = root => roots.get(root) ?? roots.set(root, { timer: null, controller: null, running: null, runningName: null, halt: false, results: new Map() }).get(root);


  async function runOne(root, s, name, signal) {
    s.runningName = name;
    s.running = run({ root, name, signal, speculative: true });
    let result;
    try { result = await s.running; } catch (error) {
      // external: Another check can hold the repository lock and produce its own evidence.

      if (error.code !== 'CHECK_ACTIVE' && !signal.aborted) notes.push({ root, text: `[autocheck] ${path.basename(root)} ${name} could not run: ${error.message}` });
      return false;
    } finally { s.running = null; s.runningName = null; }
    if (result.status !== 'passed' && result.status !== 'failed') {
      // external: A timeout or uncertain exit leaves no conclusive result.

      if (!signal.aborted) notes.push({ root, text: `[autocheck] ${path.basename(root)} ${name} ended ${result.status} (receipt ${result.id}); nothing to reuse, so project_checks will run it again.` });
      return false;
    }
    // external: An edit can supersede a run while its process is finishing.
    if (signal.aborted) return false;
    s.results.set(name, { result, at: now() });
    notes.push({ root, result });
    return true;
  }

  async function sweep(root, names) {
    const s = state(root);
    // external: An explicit claim can arrive while a cancelled run still holds the lock.

    s.controller?.abort();
    const controller = new AbortController(); s.controller = controller; s.halt = false;
    // external: A cancelled process retains its lock until it exits.
    if (s.running) await s.running.catch(() => {  });
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

      if (error.code !== 'NO_RECIPES') throw error;
      if (!unconfigured.has(root)) {
        unconfigured.add(root);
        notes.push({ root, text: `[autocheck] ${path.basename(root)} has no .pi/checks.json, so edits run no checks. Add one before running a gate by hand a second time.` });
      }
      return;
    }
    const relative = path.relative(root, path.resolve(file)).split(path.sep).join('/');
    const names = Object.entries(config.checks).filter(([, recipe]) => recipe.onEdit && watched(recipe, relative)).map(([name]) => name);
    if (!names.length) return;
    const s = state(root);
    s.results.clear();
    notes = notes.filter(entry => entry.root !== root);
    s.controller?.abort();
    clearTimeout(s.timer);
    s.timer = setTimeout(() => { s.timer = null; void sweep(root, names); }, debounceMs);
  }

  async function reusable(root, s, name) {
    const hit = s.results.get(name);
    if (!hit || now() - hit.at > maxAgeMs || !hit.result.unchanged) return null;
    const [current, recipes] = await Promise.all([fingerprintOf(root), recipesOf(root)]);
    if (current.digest !== hit.result.after.digest || recipes.digest !== hit.result.recipeDigest) return null;
    notes = notes.filter(entry => entry.result?.id !== hit.result.id);
    return { ...hit.result, reused: { ageMs: now() - hit.at, basis: 'onEdit run on the identical HEAD/diff/untracked digest; ignored inputs not covered. Pass fresh=true to re-run.' } };
  }



  async function claim(root, name, { fresh = false } = {}) {
    const s = roots.get(root);
    if (!s) return null;
    if (s.running && s.runningName === name) await s.running.catch(() => {  });
    const hit = fresh ? null : await reusable(root, s, name);
    if (hit) return hit;
    clearTimeout(s.timer); s.timer = null;
    s.halt = true;
    if (s.running) {
      s.controller?.abort();
      await s.running.catch(() => {  });
    }
    return null;
  }

  return {
    edited,
    claim,
    // external: A shell command can change the source digest after a run finishes.

    async drainNotes() {
      const out = notes; notes = [];
      const digests = new Map();
      const current = root => digests.get(root) ?? digests.set(root, fingerprintOf(root).then(
        value => ({ digest: value.digest }), error => ({ error: error.message }))).get(root);
      return Promise.all(out.map(async entry => {
        if (!entry.result) return entry.text;
        const now = await current(entry.root);
        return note(entry.result, now.error ?? now.digest === entry.result.after?.digest);
      }));
    },
    dispose() { for (const s of roots.values()) { clearTimeout(s.timer); s.controller?.abort(); } },
  };
}
