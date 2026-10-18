import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import { fixture } from './helpers.js';

test('local rotation keeps the newest snapshot when pre-upgrade date-prefixed archives exist', async t => {
  const f = await fixture(t);
  const dataDir = path.join(f.root, 'data');
  const oldNames = ['backup-20240101-1704067200000.tar.gz', 'backup-20240102-1704153600000.tar.gz'];
  for (let index = 0; index < oldNames.length; index++) {
    const filename = path.join(dataDir, oldNames[index]);
    await fs.writeFile(filename, 'isolated pre-upgrade backup fixture');
    const modified = new Date(Date.now() - (3 - index) * 86400000);
    await fs.utimes(filename, modified, modified);
  }
  assert.equal((await f.request('/api/settings/backup', { method: 'POST', key: f.key, body: { keepCount: 2 } })).status, 200);
  const result = await f.request('/api/backup/auto', { method: 'POST', key: f.key });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const archives = (await fs.readdir(dataDir)).filter(name => name.startsWith('backup-') && name.endsWith('.tar.gz'));
  assert.equal(archives.length, 2);
  assert.ok(archives.some(name => !oldNames.includes(name)), `new snapshot was incorrectly rotated out: ${archives.join(', ')}`);
  assert.ok(archives.includes(oldNames[1]));
  assert.ok(!archives.includes(oldNames[0]));
});
