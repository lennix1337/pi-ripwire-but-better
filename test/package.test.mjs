import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = file => readFile(new URL(file, root), 'utf8');

test('package metadata and README link to the published scoped npm package', async () => {
  const pkg = JSON.parse(await read('package.json'));
  const lock = JSON.parse(await read('package-lock.json'));
  const readme = await read('README.md');
  const npm = `https://www.npmjs.com/package/${pkg.name}`;
  const repo = 'https://github.com/lennix1337/pi-ripwire-but-better';
  assert.equal(pkg.homepage, npm);
  assert.equal(pkg.repository.url, `git+${repo}.git`);
  assert.equal(typeof pkg.bugs === 'string' ? pkg.bugs : pkg.bugs.url, `${repo}/issues`);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.ok(readme.includes(`](${npm})`));
  assert.ok(readme.includes(`](${repo})`));
  assert.ok(readme.includes(`pi install npm:${pkg.name}`));
  assert.doesNotMatch(readme, /release not yet published|public npm release is not available yet/);
});
