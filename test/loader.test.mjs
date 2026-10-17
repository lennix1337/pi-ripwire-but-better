import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadExtensions } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';

test('real Pi loader registers exactly three tools without prompt hooks', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const loaded = await loadExtensions([fileURLToPath(new URL('../src/index.ts', import.meta.url))], root);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const extension = loaded.extensions[0];
  assert.deepEqual([...extension.tools.keys()], ['ripwire', 'project_checks', 'project_evidence']);
  assert.equal(extension.handlers.size, 0);
  const info = extension.tools.get('ripwire');
  const tool = info.definition;
  const result = await tool.execute('loader-test', { root: root + '/src', action: 'map' }, undefined, undefined, {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /single repository root/);
});
