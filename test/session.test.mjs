import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { loadExtensions } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';
import { execute } from '../src/core.ts';

async function flow(t, optchat) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rw-session-'));
  const old = { OPTCHAT_HOME: process.env.OPTCHAT_HOME, PI_RIPWIRE_EVIDENCE_DIR: process.env.PI_RIPWIRE_EVIDENCE_DIR };
  process.env.OPTCHAT_HOME = path.join(dir, 'optchat'); process.env.PI_RIPWIRE_EVIDENCE_DIR = path.join(dir, 'evidence');
  t.after(async () => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await rm(dir, { recursive: true, force: true }); });
  const root = path.join(dir, 'repo'); await mkdir(path.join(root, '.pi'), { recursive: true });
  await writeFile(path.join(root, '.pi/checks.json'), JSON.stringify({ version: 1, checks: { smoke: { description: 'Offline fixture', argv: [process.execPath, '-e', "console.log('native-tool-result')"], timeoutMs: 3000 } } }));
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]) assert.equal((await execute('git', args, { cwd: root })).code, 0);
  const paths = [fileURLToPath(new URL('../src/index.ts', import.meta.url))];
  if (optchat) {
    const profiles = await import(pathToFileURL(path.join(optchat, 'src/profiles.ts')).href);
    profiles.createProfile('fixture'); const profile = profiles.profilePath('fixture');
    profiles.saveConfig(profile, { ...profiles.loadConfig(profile), syncStatus: false, syncOptMem: false, compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' }, subagent: { provider: 'fixture', model: 'fixture', thinking: 'off' } });
    paths.unshift(path.join(optchat, 'src/index.ts'));
  }
  const loaded = await loadExtensions(paths, root); assert.deepEqual(loaded.errors, []);
  const runtime = await ModelRuntime.create({ authPath: path.join(dir, 'auth.json'), modelsPath: null, modelsStorePath: path.join(dir, 'models.json'), refreshOnCreate: false });
  const requests = []; let round = 0;
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const prompt = context.messages.at(-1)?.content;
      const text = typeof prompt === 'string' ? prompt : Array.isArray(prompt) ? prompt.filter(x => x.type === 'text').map(x => x.text).join('') : '';
      const compacting = text.includes('\n\nCompaction:');
      if (!compacting) requests.push(JSON.stringify(context));
      const content = compacting ? [{ type: 'text', text: 'talk: offline fixture evidence' }] : round++ === 0 ? [{ type: 'toolCall', id: 'check-fixture', name: 'project_checks', arguments: { root, name: 'smoke' } }] : [{ type: 'text', text: 'fixture-finished' }];
      const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: !compacting && round === 1 ? 'toolUse' : 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, content };
      const stream = createAssistantMessageEventStream(); queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(); }); return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: path.join(dir, 'agent'), settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionsOverride: () => loaded });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: root, modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: SessionManager.create(root, path.join(dir, 'sessions')) });
  const errors = [];
  try {
    if (optchat) { session.extensionRunner.setFlagValue('optchat-profile', 'fixture'); session.extensionRunner.setFlagValue('optchat-connect', 'off'); }
    await session.bindExtensions({ mode: 'print', uiContext: session.extensionRunner.getUIContext(), onError: error => errors.push(error.error) });
    assert.ok(session.getActiveToolNames().includes('project_checks'));
    await session.prompt('Run the offline fixture check.');
    assert.equal(requests.length, 2);
    assert.match(requests[1], /native-tool-result/); assert.match(requests[1], /passed/);
    const result = session.state.messages.find(message => message.role === 'toolResult' && message.toolName === 'project_checks');
    assert.ok(result); assert.equal(result.isError, false);
    const receipt = JSON.parse(result.content[0].text); assert.equal(receipt.status, 'passed'); assert.ok(receipt.source.digest);
    if (optchat) { assert.match(requests[0], /You are OptChat/); assert.ok(session.getActiveToolNames().includes('zoom')); }
    assert.deepEqual(errors, []);
  } finally { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
}

test('Pi SDK model-tool-execution-result loop works with no network or inference', t => flow(t));

// `edits` is the first assistant message: one tool batch, which Pi executes concurrently.
async function onEditFlow(t, edits) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rw-onedit-'));
  const old = process.env.PI_RIPWIRE_EVIDENCE_DIR; process.env.PI_RIPWIRE_EVIDENCE_DIR = path.join(dir, 'evidence');
  t.after(async () => { if (old === undefined) delete process.env.PI_RIPWIRE_EVIDENCE_DIR; else process.env.PI_RIPWIRE_EVIDENCE_DIR = old; await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  const root = path.join(dir, 'repo'); await mkdir(path.join(root, '.pi'), { recursive: true });
  const counter = path.join(dir, 'runs.txt');
  await writeFile(path.join(root, '.pi/checks.json'), JSON.stringify({ version: 1, checks: { types: { description: 'Counts its runs', onEdit: true, argv: [process.execPath, '-e', `require('fs').appendFileSync(${JSON.stringify(counter)}, 'x'); console.log('types-ok')`], timeoutMs: 10000 } } }));
  await mkdir(path.join(root, 'src')); await writeFile(path.join(root, 'src/a.ts'), 'export const a = 0;\n');
  for (const args of [['init'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]) assert.equal((await execute('git', args, { cwd: root })).code, 0);
  const loaded = await loadExtensions([fileURLToPath(new URL('../src/index.ts', import.meta.url))], root); assert.deepEqual(loaded.errors, []);
  const runtime = await ModelRuntime.create({ authPath: path.join(dir, 'auth.json'), modelsPath: null, modelsStorePath: path.join(dir, 'models.json'), refreshOnCreate: false });
  const script = [edits, [{ type: 'toolCall', id: 'check-1', name: 'project_checks', arguments: { root, name: 'types' } }]];
  let round = 0;
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model) {
      const step = script[round++];
      const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: step ? 'toolUse' : 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, content: step ?? [{ type: 'text', text: 'done' }] };
      // The second step waits past the 0.75 s debounce, as a model thinking between tool calls would.
      const stream = createAssistantMessageEventStream(); setTimeout(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(); }, round === 2 ? 4000 : 0); return stream;
    },
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: path.join(dir, 'agent'), settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionsOverride: () => loaded });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: root, modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager, sessionManager: SessionManager.create(root, path.join(dir, 'sessions')) });
  try {
    await session.bindExtensions({ mode: 'print', uiContext: session.extensionRunner.getUIContext(), onError: error => assert.fail(error.error) });
    await session.prompt('Edit then check.');
    const result = session.state.messages.find(message => message.role === 'toolResult' && message.toolName === 'project_checks');
    const receipt = JSON.parse(result.content[0].text);
    assert.equal(receipt.status, 'passed'); assert.equal(receipt.trigger, 'onEdit'); assert.ok(receipt.reused);
    assert.equal((await readFile(counter, 'utf8')).length, 1, 'the check ran once, in the background');
  } finally { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
}

test('an edit by the model triggers the onEdit check, and the explicit call reuses its receipt', t => onEditFlow(t, [
  { type: 'toolCall', id: 'edit-1', name: 'write', arguments: { path: 'src/a.ts', content: 'export const a = 1;\n' } },
]));

// Seen live 2026-10-24: two edits in one batch produced no autocheck; the same edits one per turn did.
test('two edits in one parallel tool batch still trigger the onEdit check', t => onEditFlow(t, [
  { type: 'toolCall', id: 'edit-1', name: 'edit', arguments: { path: 'src/a.ts', edits: [{ oldText: 'a = 0;', newText: 'a = 0; // probe' }] } },
  { type: 'toolCall', id: 'edit-2', name: 'edit', arguments: { path: 'src/a.ts', edits: [{ oldText: 'a = 0; // probe', newText: 'a = 0;' }] } },
]));
test('real OptChat projection preserves the native tool evidence', { skip: !process.env.PI_RIPWIRE_OPTCHAT }, t => flow(t, process.env.PI_RIPWIRE_OPTCHAT));
