import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import fs from 'fs-extra';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { APPLICATION_SCHEMA } from '../storage.js';
import { fixture } from './helpers.js';

test('small images support watermarks and generated thumbnails', async t => {
  const f = await fixture(t);
  for (const [width, height] of [[1, 1], [16, 12]]) {
    const image = await sharp({ create: { width, height, channels: 3, background: 'red' } }).png().toBuffer();
    const form = f.form(image);
    form.append('autoWatermark', 'true');
    form.append('watermarkContent', 'hello');
    const result = await f.request('/api/upload', { method: 'POST', key: f.key, body: form });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.width, width);
    assert.equal(result.data.height, height);
    assert.equal((await fetch(result.data.thumbUrl)).status, 200);
  }
});

test('pagination rejects non-finite and out-of-range offsets without a database error', async t => {
  const f = await fixture(t);
  for (const endpoint of ['/api/images', '/api/v1/list']) {
    for (const page of ['Infinity', '1e309']) {
      const result = await f.request(`${endpoint}?page=${page}`, { key: f.key });
      assert.equal(result.status, 400, `${endpoint} page=${page}: ${JSON.stringify(result.data)}`);
    }
    const large = await f.request(`${endpoint}?page=9007199254740992`, { key: f.key });
    assert.ok([200, 400].includes(large.status));
    if (large.status === 200) {
      assert.ok(Number.isSafeInteger(large.data.currentPage));
      assert.ok(large.data.currentPage <= 1_000_000);
    }
  }
  assert.equal((await f.request('/api/stats')).status, 200);
});

test('branding rejects structured boolean input without enabling registration', async t => {
  const f = await fixture(t);
  for (const registrationEnabled of [{}, [], 1]) {
    assert.equal((await f.request('/api/settings/branding', { method: 'POST', key: f.key, body: { registrationEnabled } })).status, 400);
    assert.equal((await f.request('/api/settings/branding')).data.registrationEnabled, false);
  }
});

test('unknown APIs and missing image files return a real 404', async t => {
  const f = await fixture(t);
  const result = await f.request('/api/does-not-exist');
  assert.equal(result.status, 404);
  assert.equal(typeof result.data.message, 'string');
  assert.equal((await fetch(f.url + '/uploads/missing-image.png')).status, 404);
});

test('GIF uploads preserve all frames and animation timing', async t => {
  const f = await fixture(t);
  const gif = await sharp(Buffer.concat([Buffer.alloc(16 * 12 * 3, 255), Buffer.alloc(16 * 12 * 3, 0)]),
    { raw: { width: 16, height: 24, channels: 3, pageHeight: 12 } }).gif({ loop: 0, delay: [100, 200] }).toBuffer();
  const before = await sharp(gif, { animated: true }).metadata();
  assert.equal(before.pages, 2);
  const result = await f.request('/api/upload', { method: 'POST', key: f.key, body: f.form(gif, 'image', 'animated.gif', 'image/gif') });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const output = Buffer.from(await (await fetch(result.data.url)).arrayBuffer());
  const after = await sharp(output, { animated: true }).metadata();
  assert.equal(after.pages, 2);
  assert.equal(after.pageHeight, before.pageHeight);
  assert.deepEqual(after.delay, before.delay);
  assert.equal(after.loop, before.loop);
});


test('failed physical deletion retains a durable tombstone and hides public files until retry', async t => {
  const f = await fixture(t);
  const uploaded = await f.upload();
  assert.equal(uploaded.status, 200);
  const record = await f.db.get('SELECT * FROM images WHERE id = ?', uploaded.data.id);
  const originalPath = path.join(f.root, 'uploads', record.filename);
  const parent = path.dirname(originalPath);
  const originalMode = (await fs.stat(parent)).mode & 0o777;
  try {
    await fs.chmod(parent, 0o500);
    const deleted = await f.request('/api/images/delete', { method: 'POST', key: f.key, body: { ids: [record.id] } });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
    assert.equal(await f.db.get('SELECT id FROM images WHERE id = ?', record.id), undefined);
    assert.ok(await f.db.get('SELECT filePath FROM pending_deletions WHERE filePath = ?', record.filename));
    assert.equal(await fs.pathExists(originalPath), true);
    assert.equal((await fetch(uploaded.data.url)).status, 404);
    const caseAlias = new URL(uploaded.data.url);
    caseAlias.pathname = caseAlias.pathname.toUpperCase();
    assert.equal((await fetch(caseAlias)).status, 404);
    const encodedAlias = uploaded.data.url.replace(/\/([^/]+)$/, (_, name) => '/' + '%' + name.charCodeAt(0).toString(16) + name.slice(1));
    assert.equal((await fetch(encodedAlias)).status, 404);
  } finally {
    await fs.chmod(parent, originalMode);
  }
  assert.equal((await f.request('/api/images/delete', { method: 'POST', key: f.key, body: { ids: [record.id] } })).status, 200);
  assert.equal(await fs.pathExists(originalPath), false);
  assert.equal(await f.db.get('SELECT filePath FROM pending_deletions WHERE filePath = ?', record.filename), undefined);
});

test('new passwords reject UTF-8 input beyond the bcrypt 72-byte boundary', async t => {
  const f = await fixture(t);
  await f.request('/api/settings/branding', { method: 'POST', key: f.key, body: { registrationEnabled: true } });
  const password = '界'.repeat(24) + 'A';
  assert.equal(Buffer.byteLength(password), 73);
  assert.equal((await f.request('/api/auth/register', { method: 'POST', body: { username: 'unicode', password } })).status, 400);
  assert.equal((await f.request('/api/user/credentials', { method: 'POST', key: f.key,
    body: { oldPassword: 'admin', newUsername: 'admin', newPassword: password } })).status, 400);
  assert.equal((await f.request('/api/admin/users/admin', { method: 'POST', key: f.key,
    body: { username: 'admin', password } })).status, 400);
});

test('decoded image content must be a supported format even when MIME is spoofed', async t => {
  const f = await fixture(t);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="12"><rect width="16" height="12" fill="red"/></svg>');
  const result = await f.request('/api/upload', { method: 'POST', key: f.key, body: f.form(svg, 'image', 'fake.png', 'image/png') });
  assert.equal(result.status, 400);
  assert.equal((await f.db.get('SELECT count(*) AS n FROM images')).n, 0);
  assert.deepEqual(await f.incoming(), []);
});

test('AVIF without WebP conversion uses a matching extension and HTTP media type', async t => {
  const f = await fixture(t);
  const avif = await sharp(f.png).avif().toBuffer();
  const form = f.form(avif, 'image', 'photo.avif', 'image/avif');
  form.append('compressToWebp', 'false');
  const result = await f.request('/api/upload', { method: 'POST', key: f.key, body: form });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.format, 'avif');
  assert.match(result.data.url, /\.avif$/);
  const response = await fetch(result.data.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/avif');
  const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
  assert.equal(metadata.format, 'heif');
  assert.equal(metadata.compression, 'av1');
});


test('legacy AVIF records keep existing HEIF links while repairing their MIME type', async t => {
  const image = await sharp({ create: { width: 16, height: 12, channels: 3, background: 'red' } }).avif().toBuffer();
  const f = await fixture(t, { beforeStart: async root => {
    await fs.ensureDir(path.join(root, 'data'));
    await fs.ensureDir(path.join(root, 'uploads'));
    await fs.writeFile(path.join(root, 'uploads', 'legacy.heif'), image);
    const db = await open({ filename: path.join(root, 'data/db.sqlite'), driver: sqlite3.Database });
    try {
      await db.exec(APPLICATION_SCHEMA);
      await db.run('INSERT INTO images (id,userId,filename,mime,size,width,height,createdAt,autoDelete) VALUES (?,?,?,?,?,?,?,?,0)',
        'legacy-avif', 'admin', 'legacy.heif', 'application/octet-stream', image.length, 16, 12, Date.now());
    } finally { await db.close(); }
  } });
  const record = await f.db.get('SELECT * FROM images WHERE id = ?', 'legacy-avif');
  assert.equal(record.filename, 'legacy.heif');
  assert.equal(record.mime, 'image/avif');
  const response = await fetch(f.url + '/uploads/legacy.heif');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/avif');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
});
