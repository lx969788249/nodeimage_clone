import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { fixture, waitFor, slowUpload } from './helpers.js';

async function register(f, username = 'bob') {
  assert.equal((await f.request('/api/settings/branding', { method: 'POST', key: f.key, body: { registrationEnabled: true } })).status, 200);
  const result = await f.request('/api/auth/register', { method: 'POST', body: { username, password: 'before' } });
  assert.equal(result.status, 200);
  const status = await f.request('/api/user/status', { cookie: result.cookie });
  return { cookie: result.cookie, key: status.data.apiKey, id: status.data.id };
}

test('malformed login/register/credential inputs return 400; async DB rejection stays inside Express', async t => {
  const f = await fixture(t);
  for (const username of [123, {}, [], null]) {
    assert.equal((await f.request('/api/auth/login', { method: 'POST', body: { username, password: 'admin' } })).status, 400);
  }
  assert.equal((await f.request('/api/auth/login', { method: 'POST', body: '{bad', headers: { 'content-type': 'application/json' } })).status, 400);
  for (const endpoint of ['/api/auth/register', '/api/admin/users/admin']) {
    assert.equal((await f.request(endpoint, { method: 'POST', key: f.key, body: { username: {}, password: [] } })).status, 400);
  }
  assert.equal((await f.request('/api/user/password', { method: 'POST', key: f.key, body: { oldPassword: {}, newPassword: [], newUsername: 1 } })).status, 400);
  await f.db.exec('DROP TABLE settings');
  assert.equal((await f.request('/api/settings/branding')).status, 500);
  assert.equal((await f.request('/api/stats')).status, 200);
  assert.equal(f.child.exitCode, null);
  assert.doesNotMatch(f.output(), /UnhandledPromiseRejection|uncaughtException/);
});

test('slow upload cannot roll back password, sessionVersion, API key or concurrent image changes', async t => {
  const f = await fixture(t);
  const bob = await register(f);
  const slow = await slowUpload(f, { cookie: bob.cookie });
  await waitFor(async () => (await f.incoming()).length === 1);
  const good = await f.upload();
  assert.equal(good.status, 200);
  const changed = await f.request('/api/user/password', { method: 'POST', key: bob.key,
    body: { oldPassword: 'before', newPassword: 'after', newUsername: 'bob2' } });
  assert.equal(changed.status, 200);
  assert.equal((await slow.finish()).status, 401);
  const row = await f.db.get('SELECT * FROM users WHERE id = ?', bob.id);
  assert.equal(row.sessionVersion, 2);
  assert.equal(row.username, 'bob2');
  assert.equal(await bcrypt.compare('after', row.passwordHash), true);
  assert.equal((await f.request('/api/images', { cookie: bob.cookie })).status, 401);
  assert.equal((await f.request('/api/images', { key: bob.key, cookie: bob.cookie })).status, 200);
  assert.equal((await f.request('/api/images', { key: 'invalid', cookie: f.admin })).status, 401);
  const second = await slowUpload(f, { key: bob.key });
  await waitFor(async () => (await f.incoming()).length === 1);
  const rotated = await f.request('/api/user/regenerate-api-key', { method: 'POST', key: bob.key });
  assert.equal(rotated.status, 200);
  assert.equal((await second.finish()).status, 401);
  assert.equal((await f.request('/api/images', { key: bob.key })).status, 401);
  assert.equal((await f.request('/api/images', { key: rotated.data.apiKey })).status, 200);
  assert.equal((await f.request('/api/images', { key: f.key })).data.total, 1);
  assert.deepEqual(await f.incoming(), []);
  // Password and API-key writes only change their own columns.
  assert.equal((await f.db.get('SELECT apiKey FROM users WHERE id = ?', bob.id)).apiKey, rotated.data.apiKey);
});

test('slow API-key upload cannot resurrect a deleted account or deleted images', async t => {
  const f = await fixture(t);
  const bob = await register(f);
  const existing = await f.upload({ key: bob.key });
  assert.equal(existing.status, 200);
  const slow = await slowUpload(f, { key: bob.key });
  await waitFor(async () => (await f.incoming()).length === 1);
  assert.equal((await f.request('/api/admin/users/' + bob.id, { method: 'DELETE', key: f.key })).status, 200);
  assert.equal((await slow.finish()).status, 401);
  assert.equal(await f.db.get('SELECT * FROM users WHERE id = ?', bob.id), undefined);
  assert.equal((await f.db.get('SELECT count(*) AS n FROM images WHERE userId = ?', bob.id)).n, 0);
  assert.equal(await fs.pathExists(path.join(f.root, new URL(existing.data.url).pathname)), false);
  assert.deepEqual(await f.incoming(), []);
});

test('concurrent successful uploads, image deletion and branding write retain all unrelated rows', async t => {
  const f = await fixture(t);
  const first = await f.upload();
  const slow = await slowUpload(f);
  await waitFor(async () => (await f.incoming()).length === 1);
  const other = await f.upload();
  assert.equal(other.status, 200);
  assert.equal((await f.request('/api/images/delete', { method: 'POST', key: f.key, body: { ids: [first.data.id] } })).status, 200);
  assert.equal((await f.request('/api/settings/branding', { method: 'POST', key: f.key, body: { name: 'Concurrent brand' } })).status, 200);
  assert.equal((await slow.finish()).status, 200);
  const images = await f.db.all('SELECT id FROM images');
  assert.equal(images.length, 2);
  assert.equal(images.some(x => x.id === first.data.id), false);
  assert.equal(images.some(x => x.id === other.data.id), true);
  assert.equal((await f.request('/api/settings/branding')).data.name, 'Concurrent brand');
  const settings = await Promise.all([
    f.request('/api/settings/backup', { method: 'POST', key: f.key, body: { intervalHours: 12 } }),
    f.request('/api/settings/backup', { method: 'POST', key: f.key, body: { keepCount: 9 } })
  ]);
  assert.ok(settings.every(x => x.status === 200));
  const config = await f.request('/api/settings/backup', { key: f.key });
  assert.equal(config.data.intervalHours, 12); assert.equal(config.data.keepCount, 9);
  assert.deepEqual(await f.incoming(), []);
});

test('per-user and global admission reject before body reception; disconnect frees files and capacity', async t => {
  const f = await fixture(t);
  const bob = await register(f);
  const one = await slowUpload(f);
  const two = await slowUpload(f);
  await waitFor(async () => (await f.incoming()).length === 2);
  assert.equal((await f.upload()).status, 429);
  const three = await slowUpload(f, { key: bob.key });
  await waitFor(async () => (await f.incoming()).length === 3);
  assert.equal((await f.upload({ key: bob.key })).status, 429);
  assert.equal((await f.incoming()).length, 3);
  one.req.destroy(); two.req.destroy(); three.req.destroy();
  await waitFor(async () => (await f.incoming()).length === 0);
  assert.equal((await f.upload()).status, 200);
  assert.equal((await f.request('/api/stats')).data.total, 1);
});

test('multipart limits and processing failures clean disk inputs and admission slots', async t => {
  const f = await fixture(t);
  assert.equal((await f.upload({ key: f.key }, Buffer.alloc(20 * 1024 ** 2 + 1))).status, 413);
  assert.equal((await f.request('/api/upload', { method: 'POST', key: f.key, body: f.form(Buffer.from('x'), 'image', 'x.txt', 'text/plain') })).status, 400);
  assert.equal((await f.upload({ key: f.key }, Buffer.from('bad image'))).status, 400);
  assert.equal((await f.request('/api/upload', { method: 'POST', key: f.key, body: 'broken', headers: { 'content-type': 'multipart/form-data; boundary=x' } })).status, 400);
  assert.deepEqual(await f.incoming(), []);
  assert.equal((await f.upload()).status, 200);
});

test('daily limit checked atomically at commit for concurrent uploads', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 199; i++) await f.db.run('INSERT INTO images (id,userId,filename,size,createdAt) VALUES (?,?,?,?,?)', 'seed-' + i, 'admin', 'seed-' + i + '.png', 1, Date.now());
  const results = await Promise.all([f.upload(), f.upload()]);
  assert.deepEqual(results.map(x => x.status).sort(), [200, 429]);
  assert.equal((await f.request('/api/stats')).data.total, 200);
  assert.deepEqual(await f.incoming(), []);
});
