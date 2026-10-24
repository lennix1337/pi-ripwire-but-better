import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

test('fresh Pi package discovery finds the resident skill without this conversation', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rw-discovery-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: path.join(dir, 'agent'), noExtensions: true, noContextFiles: true, noPromptTemplates: true, settingsManager: SettingsManager.inMemory({ packages: [repo] }) });
  await loader.reload();
  const { skills } = loader.getSkills();
  const skill = skills.find(item => item.name === 'ripwire-resident');
  assert.ok(skill, 'packaged skill must be discoverable in an isolated fresh profile');
  assert.ok(skill.filePath.startsWith(repo));
  assert.match(skill.description, /resident|MCP/);
});
