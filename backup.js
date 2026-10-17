import fs from 'fs-extra';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import * as tar from 'tar';
import sqlite3 from 'sqlite3';
import sharp from 'sharp';
import { open } from 'sqlite';
import { httpError } from './safety.js';
import { normalizeLegacyThumbnailPaths, APPLICATION_SCHEMA, imageFormat } from './storage.js';

export function safeRelative(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
    !value.includes('\\') && !value.includes(':') && !value.includes('\0') && !path.posix.isAbsolute(value) &&
    value.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.'));
}
const columns = {
  users: ['id', 'username', 'passwordHash', 'apiKey', 'level', 'createdAt'],
  images: ['id', 'userId', 'filename', 'thumbName', 'mime', 'size', 'width', 'height', 'createdAt', 'autoDelete', 'deleteAfterDays'],
  settings: ['key', 'value'],
  pending_deletions: ['filePath', 'createdAt']
};
async function syncDir(dir) {
  const handle = await fsp.open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function durableJson(filename, value) {
  const temp = `${filename}.tmp`;
  const handle = await fsp.open(temp, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temp, filename);
  await syncDir(path.dirname(filename));
}
export async function sqliteSnapshot(db, filename) {
  const native = db.getDatabaseInstance();
  let backup;
  await new Promise((resolve, reject) => {
    backup = native.backup(filename, err => err ? reject(err) : resolve());
  });
  try {
    await new Promise((resolve, reject) => backup.step(-1, err => err ? reject(err) : resolve()));
    if (!backup.completed) throw new Error('Incomplete SQLite backup');
  } finally {
    await new Promise((resolve, reject) => backup.finish(err => err ? reject(err) : resolve()));
  }
}

export class BackupManager {
  constructor(options) {
    Object.assign(this, options);
    this.rename ||= fs.rename;
    this.dataDir = path.dirname(this.dataFile);
    this.journal = path.join(this.dataDir, '.restore-journal.json');
    this.maxExpandedBytes = options.maxExpandedBytes ?? 4 * 1024 ** 3;
    this.maxEntries = options.maxEntries ?? 50000;
  }
  async create(authorize) {
    return this.gate.exclusive(async () => {
      await authorize?.();
      const stage = await fs.mkdtemp(path.join(this.dataDir, '.snapshot-'));
      const output = path.join(this.dataDir, `backup-${Date.now()}-${randomUUID()}.tar.gz`);
      try {
        await fs.ensureDir(path.join(stage, 'data'));
        const db = await this.getSqlite();
        await sqliteSnapshot(db, path.join(stage, 'data/db.sqlite'));
        // Only indexed files are included. Never follow symlinks or retain stale inputs.
        await fs.ensureDir(path.join(stage, 'uploads'));
        const copied = new Set();
        for (const image of await db.all('SELECT filename, thumbName FROM images')) {
          for (const rel of [image.filename, image.thumbName].filter(Boolean)) {
            if (!safeRelative(rel)) throw new Error('Unsafe image path');
            if (copied.has(rel)) continue;
            copied.add(rel);
            const source = path.join(this.uploadDir, rel);
            await this.regularFile(this.uploadDir, rel);
            await fs.ensureDir(path.dirname(path.join(stage, 'uploads', rel)));
            await fs.copyFile(source, path.join(stage, 'uploads', rel));
          }
        }
        await tar.c({ gzip: true, file: output, cwd: stage, portable: true, noMtime: true }, ['data', 'uploads']);
        return output;
      } catch (e) { await fs.remove(output); throw e; }
      finally { await fs.remove(stage); }
    });
  }
  async regularFile(root, rel) {
    let current = root;
    for (const [index, part] of rel.split('/').entries()) {
      current = path.join(current, part);
      const stat = await fs.lstat(current);
      const last = index === rel.split('/').length - 1;
      if (stat.isSymbolicLink() || !(last ? stat.isFile() : stat.isDirectory())) throw httpError(400, 'INVALID_IMAGE_FILE');
    }
  }
  async extract(archive, stage) {
    let bytes = 0;
    let entries = 0;
    let invalid;
    const seen = new Set();
    const unpack = tar.x({ cwd: stage, strict: true, preserveOwner: false, noChmod: true,
      maxMetaEntrySize: 1024 * 1024,
      filter: (raw, entry) => {
        const name = raw.replace(/\/$/, '');
        const directory = entry.type === 'Directory';
        const canonical = name.normalize('NFKC').toLowerCase();
        const allowed = safeRelative(name) && (directory ?
          name === 'data' || name === 'uploads' || name.startsWith('uploads/') :
          entry.type === 'File' && (name === 'data/db.sqlite' || name.startsWith('uploads/')));
        if (++entries > this.maxEntries || !allowed || seen.has(canonical) ||
            !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > (name === 'data/db.sqlite' ? 256 * 1024 ** 2 : 100 * 1024 ** 2)) {
          invalid ||= httpError(400, 'UNSAFE_ARCHIVE_ENTRY');
          return false;
        }
        seen.add(canonical);
        return true;
      }
    });
    await pipeline(fs.createReadStream(archive), createGunzip(), new Transform({
      transform: (chunk, encoding, callback) => {
        bytes += chunk.length;
        callback(bytes > this.maxExpandedBytes ? httpError(413, 'ARCHIVE_TOO_LARGE') : null, chunk);
      }
    }), unpack);
    if (invalid) throw invalid;
    if (!seen.has('data/db.sqlite')) throw httpError(400, 'MISSING_DATABASE');
    await fs.ensureDir(path.join(stage, 'uploads'));
  }
  async validate(stage) {
    const filename = path.join(stage, 'data/db.sqlite');
    const db = await open({ filename, driver: sqlite3.Database, mode: sqlite3.OPEN_READWRITE });
    let canonicalRows;
    try {
      await db.exec('PRAGMA trusted_schema=OFF');
      const result = await db.all('PRAGMA integrity_check');
      if (result.length !== 1 || result[0].integrity_check !== 'ok') throw httpError(400, 'INVALID_DATABASE');
      const objects = await db.all("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'");
      if (objects.some(x => !['table', 'index'].includes(x.type)) ||
        objects.some(x => x.type === 'table' && !Object.hasOwn(columns, x.name))) throw httpError(400, 'INVALID_SCHEMA');
      for (const [table, required] of Object.entries(columns)) {
        if (table === 'pending_deletions' && !objects.some(x => x.type === 'table' && x.name === table)) continue;
        if (!objects.some(x => x.type === 'table' && x.name === table)) throw httpError(400, 'INVALID_SCHEMA');
        const info = await db.all(`PRAGMA table_info(${table})`);
        if (info.some(x => !required.includes(x.name) && !(table === 'users' && x.name === 'sessionVersion')) ||
          required.some(name => !info.some(x => x.name === name)) ||
          info.filter(x => x.pk).length !== 1 ||
          !info.some(x => x.name === required[0] && x.pk === 1 && x.type.toUpperCase() === 'TEXT')) throw httpError(400, 'INVALID_SCHEMA');
      }
      let uniqueUsername = false;
      for (const index of await db.all('PRAGMA index_list(users)')) {
        if (!index.unique) continue;
        const indexed = await db.all('SELECT name FROM pragma_index_info(?)', index.name);
        if (indexed.length === 1 && indexed[0].name === 'username' && !index.partial) uniqueUsername = true;
      }
      if (!uniqueUsername) throw httpError(400, 'INVALID_USER_CONSTRAINTS');
      const userCols = await db.all('PRAGMA table_info(users)');
      if (!userCols.some(c => c.name === 'sessionVersion')) await db.exec('ALTER TABLE users ADD COLUMN sessionVersion INTEGER DEFAULT 1');
      const users = await db.all('SELECT * FROM users');
      if (!users.some(x => x.id === 'admin') || users.some(x =>
        typeof x.id !== 'string' || !x.id || typeof x.username !== 'string' || !x.username ||
        typeof x.apiKey !== 'string' || !x.apiKey || (x.passwordHash != null && typeof x.passwordHash !== 'string') ||
        !Number.isInteger(x.sessionVersion) || x.sessionVersion < 1 || !Number.isFinite(x.level))) throw httpError(400, 'INVALID_USERS');
      if (new Set(users.map(x => x.id)).size !== users.length || new Set(users.map(x => x.username)).size !== users.length || new Set(users.map(x => x.apiKey)).size !== users.length) throw httpError(400, 'DUPLICATE_USERS');
      await normalizeLegacyThumbnailPaths(db, path.join(stage, 'uploads'));
      const owners = new Set(users.map(x => x.id));
      const files = new Set();
      const canonicalFiles = new Set();
      const images = await db.all('SELECT * FROM images');
      for (const image of images) {
        if (!owners.has(image.userId) || typeof image.id !== 'string' || !image.id || !Number.isFinite(image.createdAt) || !Number.isFinite(image.size) || image.size < 0) throw httpError(400, 'INVALID_IMAGES');
        for (const rel of [image.filename, image.thumbName].filter(x => x != null)) {
          if (!safeRelative(rel) || files.has(rel)) throw httpError(400, 'INVALID_IMAGE_PATH');
          const canonical = rel.normalize('NFKC').toLowerCase();
          if (canonicalFiles.has(canonical)) throw httpError(400, 'DUPLICATE_IMAGE_PATH');
          canonicalFiles.add(canonical);
          files.add(rel);
          await this.regularFile(path.join(stage, 'uploads'), rel);
          const ext = path.extname(rel).toLowerCase();
          if (!['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.heif'].includes(ext)) throw httpError(400, 'INVALID_IMAGE_TYPE');
          const decoded = imageFormat(await sharp(path.join(stage, 'uploads', rel), { limitInputPixels: false }).metadata());
          const expectedExtensions = decoded.ext === 'jpeg' ? ['.jpg', '.jpeg'] : decoded.ext === 'avif' ? ['.avif', '.heif'] : [`.${decoded.ext}`];
          if (!expectedExtensions.includes(ext)) throw httpError(400, 'IMAGE_EXTENSION_MISMATCH');
          if (rel === image.filename) image.mime = decoded.mime;
        }
        if (!image.filename) throw httpError(400, 'MISSING_IMAGE_PATH');
      }
      // Reject unindexed payloads so a restore never imports arbitrary public files.
      const walk = async dir => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(full);
          else if (!entry.isFile() || !files.has(path.relative(path.join(stage, 'uploads'), full).split(path.sep).join('/'))) throw httpError(400, 'UNINDEXED_FILE');
        }
      };
      await walk(path.join(stage, 'uploads'));
      const settings = await db.all('SELECT * FROM settings');
      for (const setting of settings) {
        if (!['branding', 'backup'].includes(setting.key)) throw httpError(400, 'INVALID_SETTINGS');
        const value = JSON.parse(setting.value);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, 'INVALID_SETTINGS');
        const stringKeys = setting.key === 'branding' ? ['name', 'subtitle', 'icon'] :
          ['s3Endpoint', 's3Region', 's3Bucket', 's3AccessKey', 's3SecretKey', 'webhookUrl'];
        if (stringKeys.some(key => value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 4096))) throw httpError(400, 'INVALID_SETTINGS');
        if (setting.key === 'branding' && value.registrationEnabled !== undefined && typeof value.registrationEnabled !== 'boolean') throw httpError(400, 'INVALID_SETTINGS');
        for (const [key, max] of [['intervalHours', 720], ['keepCount', 365]]) {
          if (setting.key === 'backup' && value[key] !== undefined && (!Number.isFinite(value[key]) || value[key] < 1 || value[key] > max || (key === 'keepCount' && !Number.isInteger(value[key])))) throw httpError(400, 'INVALID_SETTINGS');
        }
      }
      canonicalRows = { users, images, settings };
      await db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { await db.close(); }
    // Never carry archive-controlled CHECK/COLLATE/ON CONFLICT or extra indexes
    // into the running app. Import only verified records into the canonical schema.
    const cleanFile = path.join(stage, 'data', 'canonical.sqlite');
    const clean = await open({ filename: cleanFile, driver: sqlite3.Database });
    try {
      await clean.exec(APPLICATION_SCHEMA);
      await clean.exec('BEGIN IMMEDIATE');
      for (const [table, rows] of Object.entries(canonicalRows)) {
        const names = table === 'users' ? [...columns.users.slice(0, 5), 'sessionVersion', 'createdAt'] : columns[table];
        for (const row of rows) await clean.run(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`, ...names.map(name => row[name] ?? null));
      }
      // Pending deletion files are deliberately absent from the live image archive.
      await clean.exec('COMMIT');
    } finally { await clean.close(); }
    for (const suffix of ['', '-wal', '-shm']) await fs.remove(filename + suffix);
    await fs.rename(cleanFile, filename);
  }
  async restore(archive, authorize, afterInstall) {
    const stage = await fs.mkdtemp(path.join(this.dataDir, '.restore-stage-'));
    let preparedUploads;
    try {
      try { await this.extract(archive, stage); await this.validate(stage); }
      catch (e) { throw e.status ? e : httpError(400, 'INVALID_BACKUP'); }
      // data/ and uploads/ can be distinct Docker mounts. Copy validated files
      // before the barrier, then perform every rename inside its own filesystem.
      preparedUploads = await fs.mkdtemp(path.join(this.uploadDir, '.restore-stage-'));
      await fs.copy(path.join(stage, 'uploads'), preparedUploads, { dereference: false });
      await this.gate.exclusive(async () => {
        await authorize?.();
        const id = randomUUID();
        const state = { id, oldEntries: (await fs.readdir(this.uploadDir)).filter(x => !x.startsWith('.')),
          newEntries: await fs.readdir(preparedUploads), phase: 'prepared' };
        const oldData = path.join(this.dataDir, `rollback-${id}`);
        const oldUploads = path.join(this.uploadDir, `.rollback-${id}`);
        await fs.ensureDir(oldData);
        await fs.ensureDir(oldUploads);
        await syncDir(this.uploadDir);
        await this.resetSqlite(); // Closing checkpoints the old WAL; never unlink it while open.
        await durableJson(this.journal, state);
        try {
          await this.rename(this.dataFile, path.join(oldData, 'db.sqlite'));
          for (const suffix of ['-wal', '-shm']) if (await fs.pathExists(this.dataFile + suffix)) await this.rename(this.dataFile + suffix, path.join(oldData, 'db.sqlite' + suffix));
          await this.onPhase?.('database-moved');
          for (const entry of state.oldEntries) {
            await this.rename(path.join(this.uploadDir, entry), path.join(oldUploads, entry));
            await this.onPhase?.('old-image-moved');
          }
          await syncDir(oldData);
          await syncDir(oldUploads);
          await syncDir(this.dataDir);
          await syncDir(this.uploadDir);
          await this.onPhase?.('images-moved');
          for (const entry of state.newEntries) {
            await this.rename(path.join(preparedUploads, entry), path.join(this.uploadDir, entry));
            await this.onPhase?.('new-image-installed');
          }
          await this.rename(path.join(stage, 'data/db.sqlite'), this.dataFile);
          await this.onPhase?.('installed');
          await this.getSqlite();
          await afterInstall?.();
          await syncDir(this.uploadDir);
          await syncDir(this.dataDir);
          // Preserve a durable rollback manifest; only an explicit committed marker
          // allows startup to keep the installed generation.
          state.phase = 'committed';
          await durableJson(this.journal, state);
          await this.onPhase?.('committed');
          await this.rename(this.journal, path.join(oldData, 'manifest.json'));
          await syncDir(oldData);
          await syncDir(this.dataDir);
        } catch (e) {
          try { await this.recover(); await this.getSqlite(); }
          catch (rollbackError) {
            // Fail closed. Startup will retry the journal before accepting traffic.
            console.error('Restore rollback failed:', rollbackError.message);
            this.gate.failed = true;
          }
          throw e;
        }
      });
    } finally {
      if (preparedUploads) await fs.remove(preparedUploads);
      await fs.remove(stage);
    }
  }
  async recover() {
    if (!await fs.pathExists(this.journal)) return;
    const state = await fs.readJson(this.journal);
    if (!/^[a-f0-9-]{36}$/.test(state.id) || !Array.isArray(state.oldEntries) || !Array.isArray(state.newEntries) ||
      [...state.oldEntries, ...state.newEntries].some(x => !safeRelative(x) || x.includes('/'))) throw new Error('Invalid restore journal');
    const oldData = path.join(this.dataDir, `rollback-${state.id}`);
    const oldUploads = path.join(this.uploadDir, `.rollback-${state.id}`);
    if (state.phase === 'committed') {
      await this.rename(this.journal, path.join(oldData, 'manifest.json'));
      return;
    }
    await this.resetSqlite();
    for (const entry of state.newEntries) {
      if (!state.oldEntries.includes(entry) || await fs.pathExists(path.join(oldUploads, entry))) await fs.remove(path.join(this.uploadDir, entry));
    }
    for (const entry of state.oldEntries) {
      if (await fs.pathExists(path.join(oldUploads, entry))) {
        await fs.remove(path.join(this.uploadDir, entry));
        await this.rename(path.join(oldUploads, entry), path.join(this.uploadDir, entry));
      }
    }
    if (await fs.pathExists(path.join(oldData, 'db.sqlite'))) {
      for (const suffix of ['', '-wal', '-shm']) await fs.remove(this.dataFile + suffix);
      for (const suffix of ['', '-wal', '-shm']) if (await fs.pathExists(path.join(oldData, 'db.sqlite' + suffix))) await this.rename(path.join(oldData, 'db.sqlite' + suffix), this.dataFile + suffix);
    }
    await syncDir(this.uploadDir);
    await syncDir(this.dataDir);
    await fs.remove(this.journal);
    await syncDir(this.dataDir);
  }
}
