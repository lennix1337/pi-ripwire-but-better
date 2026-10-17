import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
const settings = JSON.parse(await readFile(path.join(os.homedir(), '.pi/agent/settings.json'), 'utf8'));
const selected = settings.packages.filter(item => typeof item === 'string' && /[\\/]pi-ripwire$/.test(item));
assert.equal(selected.length, 1, 'exactly one package is configured');
const temp = await mkdtemp(path.join(os.tmpdir(), 'rw-discovery-'));
try {
  const loader = new DefaultResourceLoader({ cwd: temp, agentDir: temp, settingsManager: SettingsManager.inMemory({ packages: selected }), noSkills: true, noContextFiles: true, noPromptTemplates: true });
  await loader.reload();
  const result = loader.getExtensions(); assert.deepEqual(result.errors, []);
  const extensions = result.extensions.filter(extension => extension.tools.has('project_checks'));
  assert.equal(extensions.length, 1);
  assert.deepEqual([...extensions[0].tools.keys()], ['ripwire', 'project_checks', 'project_evidence']);
  console.log(JSON.stringify({ status: 'verified', configuredPackage: selected[0], tools: [...extensions[0].tools.keys()], inference: false }));
} finally { await rm(temp, { recursive: true, force: true }); }
