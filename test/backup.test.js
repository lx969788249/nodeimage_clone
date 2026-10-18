import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import * as tar from 'tar';
import { gzipSync } from 'node:zlib';
import { fixture, slowUpload, waitFor } from './helpers.js';
import { BackupManager } from '../backup.js';
import { OperationGate } from '../safety.js';

async function manager(f, options = {}) {
  await f.stop();
  let connection;
  const getSqlite = async () => connection ||= await open({ filename: path.join(f.root, 'data/db.sqlite'), driver: sqlite3.Database });
  const resetSqlite = async () => { if (connection) await connection.close(); connection = null; };
  return new BackupManager({ storageRoot: f.root, dataFile: path.join(f.root, 'data/db.sqlite'), uploadDir: path.join(f.root, 'uploads'),
    gate: new OperationGate(), getSqlite, resetSqlite, ...options });
}
function rawArchive(entries) {
  const blocks = [];
  for (const { name, type = 'File', content = Buffer.from('bad'), linkpath, declaredSize } of entries) {
    const size = type === 'File' ? (declaredSize ?? content.length) : 0;
    const header = new tar.Header({ path: name, type, size, linkpath, mode: 0o600 }); header.encode();
    blocks.push(header.block);
    if (size && declaredSize === undefined) blocks.push(content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
async function backup(f) {
  const response = await f.request('/api/backup', { key: f.key });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data[0], 0x1f);
  return response.data;
}

test('manual and automatic backups include committed WAL rows, files and settings; valid restore preserves rollback', async t => {
  const f = await fixture(t);
  assert.equal((await f.upload()).status, 200);
  assert.equal((await f.request('/api/settings/branding', { method: 'POST', key: f.key, body: { name: 'WAL brand' } })).status, 200);
  assert.ok((await fs.stat(path.join(f.root, 'data/db.sqlite-wal'))).size > 0);
  const archive = await backup(f);
  assert.equal((await f.request('/api/backup/auto', { method: 'POST', key: f.key })).status, 200);
  const local = (await fs.readdir(path.join(f.root, 'data'))).filter(x => x.startsWith('backup-'));
  assert.ok(local.length >= 1);
  const extracted = await fs.mkdtemp(path.join(os.tmpdir(), 'nodeimage-verify-'));
  t.after(() => fs.remove(extracted));
  const filename = path.join(extracted, 'archive.tar.gz'); await fs.writeFile(filename, archive);
  await tar.x({ file: filename, cwd: extracted });
  const snapshot = await open({ filename: path.join(extracted, 'data/db.sqlite'), driver: sqlite3.Database });
  assert.equal((await snapshot.get('SELECT count(*) AS n FROM images')).n, 1);
  assert.equal(JSON.parse((await snapshot.get("SELECT value FROM settings WHERE key='branding'")).value).name, 'WAL brand');
  const image = await snapshot.get('SELECT * FROM images');
  assert.ok(await fs.pathExists(path.join(extracted, 'uploads', image.filename)));
  await snapshot.close();
  assert.equal((await f.upload()).status, 200);
  await f.closeDb();
  const restored = await f.request('/api/backup/restore', { method: 'POST', key: f.key, body: f.form(archive, 'backup', 'backup.tar.gz', 'application/gzip') });
  assert.equal(restored.status, 200, JSON.stringify(restored.data));
  assert.equal((await f.request('/api/stats')).data.total, 1);
  assert.equal((await f.request('/api/images', { cookie: f.admin })).status, 401);
  assert.equal((await f.request('/api/settings/branding')).data.name, 'WAL brand');
  assert.ok((await fs.readdir(path.join(f.root, 'data'))).some(x => x.startsWith('rollback-')));
  assert.ok((await fs.readdir(path.join(f.root, 'uploads'))).some(x => x.startsWith('.rollback-')));
  assert.equal(await fs.pathExists(path.join(f.root, 'data/.restore-journal.json')), false);
  assert.deepEqual(await f.incoming(), []);
});

test('backup waits for an admitted upload and rejects new work while draining', async t => {
  const f = await fixture(t);
  const slow = await slowUpload(f);
  await waitFor(async () => (await f.incoming()).length === 1);
  const pending = f.request('/api/backup', { key: f.key });
  await waitFor(async () => (await f.request('/api/stats')).status === 503);
  assert.equal((await f.upload()).status, 503);
  assert.equal((await slow.finish()).status, 200);
  assert.equal((await pending).status, 200);
  assert.equal((await f.request('/api/stats')).data.total, 1);
});

test('bad archives never change existing rows, image bytes, or credentials', async t => {
  const f = await fixture(t);
  const uploaded = await f.upload(); assert.equal(uploaded.status, 200);
  const image = await f.db.get('SELECT * FROM images');
  const before = await fs.readFile(path.join(f.root, 'uploads', image.filename));
  const user = await f.db.get('SELECT * FROM users WHERE id = ?', 'admin');
  const archives = [Buffer.from('not gzip'),
    rawArchive([{ name: '../outside' }]), rawArchive([{ name: '/tmp/outside' }]),
    rawArchive([{ name: 'uploads/link', type: 'SymbolicLink', linkpath: '/tmp' }]),
    rawArchive([{ name: 'uploads/link', type: 'Link', linkpath: '../../outside' }]),
    rawArchive([{ name: 'data/db.sqlite', content: Buffer.from('not sqlite') }]),
    rawArchive([{ name: 'data/db.sqlite', declaredSize: 300 * 1024 ** 2 }]),
    rawArchive([{ name: 'data/db.sqlite' }, { name: 'data/db.sqlite' }])];
  for (const archive of archives) {
    const result = await f.request('/api/backup/restore', { method: 'POST', key: f.key, body: f.form(archive, 'backup', 'bad.tar.gz') });
    assert.equal(result.status, 400, JSON.stringify(result.data));
    assert.equal((await f.request('/api/stats')).data.total, 1);
    assert.deepEqual(await fs.readFile(path.join(f.root, 'uploads', image.filename)), before);
    assert.deepEqual(await f.db.get('SELECT * FROM users WHERE id = ?', 'admin'), user);
    assert.deepEqual(await f.incoming(), []);
  }
});

for (const phase of ['database-moved', 'images-moved', 'installed']) {
  test(`restore rolls back database and image set on failure at ${phase}`, async t => {
    const f = await fixture(t);
    await f.upload();
    const archive = await backup(f);
    await f.upload();
    const oldRows = await f.db.all('SELECT * FROM images ORDER BY id');
    const oldUser = await f.db.get("SELECT * FROM users WHERE id='admin'");
    const archiveFile = path.join(f.root, 'test-backup.tar.gz'); await fs.writeFile(archiveFile, archive);
    const m = await manager(f, { onPhase: at => { if (at === phase) throw new Error('Injected switch failure'); } });
    await assert.rejects(m.restore(archiveFile), /Injected switch failure/);
    const db = await m.getSqlite();
    assert.deepEqual(await db.all('SELECT * FROM images ORDER BY id'), oldRows);
    assert.deepEqual(await db.get("SELECT * FROM users WHERE id='admin'"), oldUser);
    for (const image of oldRows) assert.ok(await fs.pathExists(path.join(f.root, 'uploads', image.filename)));
    assert.equal(await fs.pathExists(m.journal), false);
    await m.resetSqlite();
  });
}

test('expanded-byte and entry-count bounds reject before switching', async t => {
  const f = await fixture(t);
  const archive = await backup(f);
  const archiveFile = path.join(f.root, 'test-backup.tar.gz'); await fs.writeFile(archiveFile, archive);
  const m = await manager(f, { maxExpandedBytes: 1024 });
  await assert.rejects(m.restore(archiveFile), e => e.status === 413);
  m.maxExpandedBytes = 4 * 1024 ** 3; m.maxEntries = 1;
  await assert.rejects(m.restore(archiveFile), e => e.status === 400);
  assert.equal((await (await m.getSqlite()).get('SELECT count(*) AS n FROM users')).n, 1);
  await m.resetSqlite();
});

test('legacy database migration preserves password/key/version and repairs only legacy thumbnail paths', async t => {
  const f = await fixture(t, { beforeStart: async root => {
    await fs.ensureDir(path.join(root, 'data'));
    await fs.ensureDir(path.join(root, 'uploads/thumbs'));
    const db = await open({ filename: path.join(root, 'data/db.sqlite'), driver: sqlite3.Database });
    await db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE, passwordHash TEXT, apiKey TEXT, level INTEGER, createdAt INTEGER);
      CREATE TABLE images (id TEXT PRIMARY KEY,userId TEXT,filename TEXT,thumbName TEXT,mime TEXT,size INTEGER,width INTEGER,height INTEGER,createdAt INTEGER,autoDelete INTEGER,deleteAfterDays INTEGER);
      CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT);`);
    await db.run('INSERT INTO users VALUES (?,?,?,?,?,?)', 'admin', 'admin', null, 'legacy-key', 1, 123);
    await db.run('INSERT INTO images VALUES (?,?,?,?,?,?,?,?,?,?,?)', 'old', 'admin', 'old.png', 'old_thumb.webp', 'image/png', 3, 1, 1, 123, 0, null);
    await db.close();
    await fs.writeFile(path.join(root, 'uploads/old.png'), 'old');
    await fs.writeFile(path.join(root, 'uploads/thumbs/old_thumb.webp'), 'thumb');
  } });
  const user = await f.db.get("SELECT * FROM users WHERE id='admin'");
  assert.equal(user.apiKey, 'legacy-key'); assert.equal(user.sessionVersion, 1); assert.equal(user.createdAt, 123);
  assert.equal((await f.db.get("SELECT * FROM images WHERE id='old'")).thumbName, 'thumbs/old_thumb.webp');
  assert.ok(await fs.pathExists(path.join(f.root, 'uploads/old.png')));
  assert.equal((await f.request('/api/images', { key: 'legacy-key' })).status, 200);
});

for (const phase of ['database-moved', 'old-image-moved', 'images-moved', 'new-image-installed', 'installed', 'committed']) {
  test(`SIGKILL at ${phase}: startup ${phase === 'committed' ? 'keeps committed restore' : 'rolls back before serving'}`, async t => {
    const { spawn } = await import('node:child_process');
    const { once } = await import('node:events');
    const f = await fixture(t);
    await f.upload(); const archive = await backup(f); await f.upload();
    const previous = await f.db.all('SELECT * FROM images ORDER BY id');
    const archiveFile = path.join(f.root, 'test-backup.tar.gz'); await fs.writeFile(archiveFile, archive);
    await f.stop();
    const worker = spawn(process.execPath, [new URL('./fixtures/restore-worker.js', import.meta.url).pathname, f.root, archiveFile, phase], { stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = ''; worker.stderr.on('data', x => { errors += x; });
    const [code, signal] = await once(worker, 'exit');
    assert.equal(signal, 'SIGKILL', `code=${code} ${errors}`);
    assert.ok(await fs.pathExists(path.join(f.root, 'data/.restore-journal.json')));
    const restarted = await fixture(t, { root: f.root });
    const rows = await restarted.db.all('SELECT * FROM images ORDER BY id');
    if (phase === 'committed') assert.equal(rows.length, 1);
    else assert.deepEqual(rows, previous);
    for (const image of rows) assert.ok(await fs.pathExists(path.join(f.root, 'uploads', image.filename)));
    assert.equal(await fs.pathExists(path.join(f.root, 'data/.restore-journal.json')), false);
    assert.equal((await restarted.request('/api/stats')).status, 200);
  });
}

test('restore rejects wrong schema, missing files, orphan owners, unsafe DB paths, and unindexed payloads', async t => {
  const f = await fixture(t);
  await f.upload();
  const archive = await backup(f);
  const initial = await f.db.all('SELECT * FROM images');
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'nodeimage-invalid-db-'));
  t.after(() => fs.remove(stage));
  const original = path.join(stage, 'original.tar.gz'); await fs.writeFile(original, archive);
  const variants = [
    async (db, dir) => db.exec('CREATE TABLE unexpected (id INTEGER)'),
    async db => db.exec("UPDATE images SET filename='../escape'"),
    async db => db.exec("UPDATE images SET userId='deleted-owner'"),
    async (db, dir) => { const image = await db.get('SELECT * FROM images'); await fs.remove(path.join(dir, 'uploads', image.filename)); },
    async (db, dir) => fs.writeFile(path.join(dir, 'uploads/arbitrary.html'), 'unexpected'),
    async db => db.run('INSERT OR REPLACE INTO settings VALUES (?,?)', 'backup', JSON.stringify({ intervalHours: -1 })),
    async db => db.exec(`ALTER TABLE users RENAME TO old_users;
      CREATE TABLE users (id TEXT PRIMARY KEY,username TEXT,passwordHash TEXT,apiKey TEXT,level INTEGER,sessionVersion INTEGER,createdAt INTEGER);
      INSERT INTO users SELECT * FROM old_users;
      DROP TABLE old_users;`)
  ];
  for (let i = 0; i < variants.length; i++) {
    const dir = path.join(stage, String(i)); await fs.ensureDir(dir); await tar.x({ file: original, cwd: dir });
    const db = await open({ filename: path.join(dir, 'data/db.sqlite'), driver: sqlite3.Database });
    await variants[i](db, dir); await db.close();
    const invalid = path.join(stage, `invalid-${i}.tar.gz`); await tar.c({ cwd: dir, file: invalid, gzip: true }, ['data', 'uploads']);
    const result = await f.request('/api/backup/restore', { method: 'POST', key: f.key, body: f.form(await fs.readFile(invalid), 'backup', 'invalid.tar.gz') });
    assert.equal(result.status, 400, JSON.stringify(result.data));
    assert.deepEqual(await f.db.all('SELECT * FROM images'), initial);
  }
});

test('restore drains a slow upload before swapping; late request cannot write into restored image set', async t => {
  const f = await fixture(t);
  await f.upload(); const archive = await backup(f);
  const slow = await slowUpload(f);
  await waitFor(async () => (await f.incoming()).length === 1);
  await f.closeDb();
  const pending = f.request('/api/backup/restore', { method: 'POST', key: f.key, body: f.form(archive, 'backup', 'good.tar.gz') });
  await waitFor(async () => (await f.request('/api/stats')).status === 503);
  assert.equal((await slow.finish()).status, 200);
  const result = await pending; assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal((await f.request('/api/stats')).data.total, 1);
  const rollback = (await fs.readdir(path.join(f.root, 'data'))).find(x => x.startsWith('rollback-'));
  const db = await open({ filename: path.join(f.root, 'data', rollback, 'db.sqlite'), driver: sqlite3.Database });
  assert.equal((await db.get('SELECT count(*) AS n FROM images')).n, 2);
  await db.close();
  assert.deepEqual(await f.incoming(), []);
});

test('rollback I/O failure keeps a recovery journal and closes admission until restart recovery', async t => {
  const f = await fixture(t);
  await f.upload(); const archive = await backup(f); await f.upload();
  const archiveFile = path.join(f.root, 'test-backup.tar.gz'); await fs.writeFile(archiveFile, archive);
  const m = await manager(f);
  const realReset = m.resetSqlite;
  m.onPhase = at => {
    if (at === 'installed') {
      m.resetSqlite = async () => { throw new Error('Injected rollback I/O error'); };
      throw new Error('Injected install error');
    }
  };
  await assert.rejects(m.restore(archiveFile), /Injected install error/);
  assert.equal(m.gate.failed, true);
  assert.throws(() => m.gate.enter(), e => e.status === 503 && e.message === 'RECOVERY_REQUIRED');
  await assert.rejects(m.gate.exclusive(async () => {}), e => e.status === 503);
  assert.ok(await fs.pathExists(m.journal));
  m.resetSqlite = realReset;
  await m.recover();
  assert.equal((await (await m.getSqlite()).get('SELECT count(*) AS n FROM images')).n, 2);
  await m.resetSqlite();
});

test('separate data/uploads mount semantics: every switch rename stays inside its own filesystem', async t => {
  const f = await fixture(t);
  await f.upload(); const archive = await backup(f); await f.upload();
  const archiveFile = path.join(f.root, 'test-backup.tar.gz'); await fs.writeFile(archiveFile, archive);
  const calls = [];
  const mount = name => name.startsWith(path.join(f.root, 'uploads') + path.sep) ? 'uploads' : 'data';
  const m = await manager(f, { rename: async (from, to) => {
    calls.push([from, to]);
    if (mount(from) !== mount(to)) throw Object.assign(new Error('Cross-device rename'), { code: 'EXDEV' });
    return fs.rename(from, to);
  } });
  await m.restore(archiveFile);
  assert.equal((await (await m.getSqlite()).get('SELECT count(*) AS n FROM images')).n, 1);
  assert.ok(calls.some(([from, to]) => from.startsWith(path.join(f.root, 'uploads/.restore-stage-')) && to.startsWith(path.join(f.root, 'uploads') + path.sep)));
  assert.equal((await fs.readdir(path.join(f.root, 'uploads'))).some(x => x.startsWith('.restore-stage-')), false);
  await m.resetSqlite();
});

test('old archive without sessionVersion and with flat original/bare thumbnail restores in isolation', async t => {
  const f = await fixture(t);
  await f.upload(); const archive = await backup(f);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nodeimage-legacy-archive-'));
  t.after(() => fs.remove(dir));
  const original = path.join(dir, 'original.tar.gz'); await fs.writeFile(original, archive);
  await tar.x({ file: original, cwd: dir });
  const db = await open({ filename: path.join(dir, 'data/db.sqlite'), driver: sqlite3.Database });
  const image = await db.get('SELECT * FROM images');
  const user = await db.get("SELECT * FROM users WHERE id='admin'");
  await fs.move(path.join(dir, 'uploads', image.filename), path.join(dir, 'uploads/legacy.webp'));
  await fs.move(path.join(dir, 'uploads', image.thumbName), path.join(dir, 'uploads/thumbs/legacy_thumb.webp'));
  await db.run("UPDATE images SET filename='legacy.webp', thumbName='legacy_thumb.webp'");
  await db.exec('ALTER TABLE users DROP COLUMN sessionVersion'); await db.close();
  const legacy = path.join(dir, 'legacy.tar.gz'); await tar.c({ cwd: dir, file: legacy, gzip: true }, ['data', 'uploads']);
  await f.closeDb();
  const result = await f.request('/api/backup/restore', { method: 'POST', key: f.key, body: f.form(await fs.readFile(legacy), 'backup', 'legacy.tar.gz') });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const restored = await open({ filename: path.join(f.root, 'data/db.sqlite'), driver: sqlite3.Database });
  const current = await restored.get("SELECT * FROM users WHERE id='admin'");
  assert.equal(current.apiKey, user.apiKey); assert.equal(current.passwordHash, user.passwordHash); assert.equal(current.sessionVersion, 1);
  const record = await restored.get('SELECT * FROM images');
  assert.equal(record.filename, 'legacy.webp'); assert.equal(record.thumbName, 'thumbs/legacy_thumb.webp');
  assert.ok(await fs.pathExists(path.join(f.root, 'uploads/legacy.webp')));
  await restored.close();
});
