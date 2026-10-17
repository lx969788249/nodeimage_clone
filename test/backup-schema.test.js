import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import * as tar from 'tar';
import { fixture } from './helpers.js';
import { BackupManager } from '../backup.js';
import { OperationGate } from '../safety.js';

async function transformedArchive(t, f, transform) {
  const response = await f.request('/api/backup', { key: f.key });
  assert.equal(response.status, 200);
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'nodeimage-schema-test-'));
  t.after(() => fs.remove(stage));
  const source = path.join(stage, 'source.tar.gz');
  await fs.writeFile(source, response.data);
  await tar.x({ file: source, cwd: stage });
  const db = await open({ filename: path.join(stage, 'data/db.sqlite'), driver: sqlite3.Database });
  try { await transform(db, stage); } finally { await db.close(); }
  const output = path.join(stage, 'changed.tar.gz');
  await tar.c({ file: output, cwd: stage, gzip: true }, ['data', 'uploads']);
  return fs.readFile(output);
}

test('restored rows use the application schema rather than incompatible source indexes', async t => {
  const f = await fixture(t);
  assert.equal((await f.upload()).status, 200);
  const archive = await transformedArchive(t, f, db => db.exec('CREATE UNIQUE INDEX one_image_per_owner ON images(userId)'));
  await f.closeDb();
  const restored = await f.request('/api/backup/restore', { method: 'POST', key: f.key,
    body: f.form(archive, 'backup', 'extra-index.tar.gz') });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  const uploaded = await f.upload();
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.data));
  assert.equal((await f.request('/api/stats')).data.total, 2);
});

test('restoring legacy rows discards source CHECK constraints while preserving credentials', async t => {
  const f = await fixture(t);
  const archive = await transformedArchive(t, f, db => db.exec(`
    ALTER TABLE users RENAME TO source_users;
    CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE CHECK(username = 'admin'),
      passwordHash TEXT, apiKey TEXT, level INTEGER, sessionVersion INTEGER DEFAULT 1, createdAt INTEGER);
    INSERT INTO users SELECT * FROM source_users;
    DROP TABLE source_users;
  `));
  await f.closeDb();
  const restored = await f.request('/api/backup/restore', { method: 'POST', key: f.key,
    body: f.form(archive, 'backup', 'extra-check.tar.gz') });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.equal((await f.request('/api/settings/branding', { method: 'POST', key: f.key,
    body: { registrationEnabled: true } })).status, 200);
  const registered = await f.request('/api/auth/register', { method: 'POST',
    body: { username: 'restored-user', password: 'regression-password' } });
  assert.equal(registered.status, 200, JSON.stringify(registered.data));
  assert.equal((await f.request('/api/images', { key: f.key })).status, 200);
  await f.login('admin', 'admin');
});

test('restore rejects indexed active web content without replacing the live image set', async t => {
  const f = await fixture(t);
  await f.upload();
  const rows = await f.db.all('SELECT * FROM images');
  const archive = await transformedArchive(t, f, async (db, stage) => {
    const image = await db.get('SELECT * FROM images');
    await fs.remove(path.join(stage, 'uploads', image.filename));
    await fs.writeFile(path.join(stage, 'uploads/restored.html'), '<!doctype html><p>isolated regression fixture</p>');
    await db.run("UPDATE images SET filename='restored.html', mime='text/html'");
  });
  const restored = await f.request('/api/backup/restore', { method: 'POST', key: f.key,
    body: f.form(archive, 'backup', 'active-payload.tar.gz') });
  assert.equal(restored.status, 400, JSON.stringify(restored.data));
  assert.deepEqual(await f.db.all('SELECT * FROM images'), rows);
  assert.equal(await fs.pathExists(path.join(f.root, 'uploads/restored.html')), false);
});

test('restore rejects fractional retention before switching the live database or image set', async t => {
  const f = await fixture(t);
  await f.upload();
  const archive = await transformedArchive(t, f, db => db.run(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', 'backup', JSON.stringify({ keepCount: 1.5 })));
  await f.upload();
  const rows = await f.db.all('SELECT * FROM images ORDER BY id');
  assert.equal(rows.length, 2);
  const restored = await f.request('/api/backup/restore', { method: 'POST', key: f.key,
    body: f.form(archive, 'backup', 'fractional-retention.tar.gz') });
  assert.equal(restored.status, 400, JSON.stringify(restored.data));
  assert.deepEqual(await f.db.all('SELECT * FROM images ORDER BY id'), rows);
  assert.equal((await f.request('/api/stats')).data.total, 2);
  assert.equal((await f.request('/api/settings/backup', { key: f.key })).status, 200);
  for (const image of rows) {
    assert.ok(await fs.pathExists(path.join(f.root, 'uploads', image.filename)));
    assert.ok(await fs.pathExists(path.join(f.root, 'uploads', image.thumbName)));
  }
});

test('restore rejects an allowed image extension that disagrees with the archived image bytes', async t => {
  const f = await fixture(t);
  await f.upload();
  const rows = await f.db.all('SELECT * FROM images');
  const archive = await transformedArchive(t, f, async (db, stage) => {
    const image = await db.get('SELECT * FROM images');
    assert.match(image.filename, /\.webp$/);
    await fs.move(path.join(stage, 'uploads', image.filename), path.join(stage, 'uploads/wrong-format.png'));
    await db.run("UPDATE images SET filename='wrong-format.png', mime='image/png'");
  });
  const restored = await f.request('/api/backup/restore', { method: 'POST', key: f.key,
    body: f.form(archive, 'backup', 'wrong-extension.tar.gz') });
  assert.equal(restored.status, 400, JSON.stringify(restored.data));
  assert.deepEqual(await f.db.all('SELECT * FROM images'), rows);
  assert.equal((await f.request('/api/stats')).data.total, 1);
  assert.equal(await fs.pathExists(path.join(f.root, 'uploads/wrong-format.png')), false);
});

test('rollback interrupted during image recovery and again during database recovery remains retryable', async t => {
  const f = await fixture(t);
  await f.upload();
  const response = await f.request('/api/backup', { key: f.key });
  assert.equal(response.status, 200);
  await f.upload();
  const rows = await f.db.all('SELECT * FROM images ORDER BY id');
  const files = new Map();
  for (const row of rows) {
    for (const name of [row.filename, row.thumbName]) files.set(name, await fs.readFile(path.join(f.root, 'uploads', name)));
  }
  const archive = path.join(f.root, 'rollback-test.tar.gz');
  await fs.writeFile(archive, response.data);
  await f.stop();
  let connection;
  const getSqlite = async () => connection ||= await open({ filename: path.join(f.root, 'data/db.sqlite'), driver: sqlite3.Database });
  const resetSqlite = async () => { if (connection) await connection.close(); connection = null; };
  let recoveredImages = 0;
  const manager = new BackupManager({ dataFile: path.join(f.root, 'data/db.sqlite'), uploadDir: path.join(f.root, 'uploads'),
    getSqlite, resetSqlite, gate: new OperationGate(),
    onPhase: phase => { if (phase === 'installed') throw new Error('Injected installation failure'); },
    rename: async (source, target) => {
      if (source.includes(`${path.sep}.rollback-`) && ++recoveredImages === 2) throw new Error('Injected image recovery failure');
      return fs.rename(source, target);
    }
  });
  t.after(resetSqlite);
  await assert.rejects(manager.restore(archive), /Injected installation failure/);
  assert.equal(manager.gate.failed, true);
  assert.equal(recoveredImages, 2);
  manager.rename = async (source, target) => {
    if (source.includes(`${path.sep}rollback-`) && path.basename(source) === 'db.sqlite') throw new Error('Injected database recovery failure');
    return fs.rename(source, target);
  };
  await assert.rejects(manager.recover(), /Injected database recovery failure/);
  assert.ok(await fs.pathExists(manager.journal));
  manager.rename = fs.rename;
  await manager.recover();
  await manager.recover();
  assert.deepEqual(await (await getSqlite()).all('SELECT * FROM images ORDER BY id'), rows);
  for (const [name, content] of files) assert.deepEqual(await fs.readFile(path.join(f.root, 'uploads', name)), content);
  assert.equal(await fs.pathExists(manager.journal), false);
});
