import fs from 'fs-extra';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

// Keep a separate SQLite EXCLUSIVE transaction open on each storage volume.
// Kernel-backed SQLite locks release on process death; there is no stale PID file
// to delete, and a second instance must fail before any cleanup or recovery.
export async function acquireStorageLocks(roots) {
  const connections = [];
  const close = async () => {
    while (connections.length) await connections.pop().close();
  };
  try {
    const realRoots = [];
    for (const root of roots) {
      await fs.ensureDir(root);
      realRoots.push(await fs.realpath(root));
    }
    for (const root of [...new Set(realRoots)].sort()) {
      const db = await open({ filename: path.join(root, '.nodeimage-instance.sqlite'), driver: sqlite3.Database });
      connections.push(db);
      await db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
    }
    return close;
  } catch (err) {
    await close();
    throw new Error(['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(err.code) ? 'STORAGE_IN_USE: another instance owns data or uploads' : 'STORAGE_LOCK_FAILED', { cause: err });
  }
}

// Older records stored a basename while the thumbnail already lived in thumbs/.
// Preserve an existing exact path, and repair only a missing basename reference.
export async function normalizeLegacyThumbnailPaths(db, uploadRoot) {
  for (const image of await db.all('SELECT id, thumbName FROM images WHERE thumbName IS NOT NULL')) {
    const name = image.thumbName;
    if (typeof name !== 'string' || !name || name.length > 1024 || name.startsWith('thumbs/') || /[\\:\0]/.test(name) || name.split('/').some(part => !part || part.startsWith('.'))) continue;
    if (!await fs.pathExists(path.join(uploadRoot, name)) && await fs.pathExists(path.join(uploadRoot, 'thumbs', name))) {
      await db.run('UPDATE images SET thumbName = ? WHERE id = ?', `thumbs/${name}`, image.id);
    }
  }
}

export const APPLICATION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT UNIQUE, passwordHash TEXT, apiKey TEXT,
    level INTEGER, sessionVersion INTEGER DEFAULT 1, createdAt INTEGER
  );
  CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY, userId TEXT, filename TEXT, thumbName TEXT, mime TEXT,
    size INTEGER, width INTEGER, height INTEGER, createdAt INTEGER,
    autoDelete INTEGER, deleteAfterDays INTEGER
  );
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS pending_deletions (filePath TEXT PRIMARY KEY, createdAt INTEGER);
`;

export function imageFormat(metadata) {
  if (metadata.format === 'heif' && (metadata.compression === 'av1' || metadata.mediaType === 'image/avif')) return { ext: 'avif', mime: 'image/avif' };
  const formats = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' };
  if (!formats[metadata.format]) throw Object.assign(new Error('UNSUPPORTED_IMAGE_FORMAT'), { status: 400 });
  return { ext: metadata.format, mime: formats[metadata.format] };
}
export const canonicalPath = value => value.normalize('NFKC').toLowerCase();
