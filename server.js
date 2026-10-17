import express from 'express';
import session from 'express-session';
import multer from 'multer';
import sharp from 'sharp';
import { nanoid } from 'nanoid';
import fs from 'fs-extra';
import path from 'path';
import bcrypt from 'bcryptjs';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { fileURLToPath } from 'node:url';
import { OperationGate, Mutex, Admission, httpError, text, scheduleLongDelay } from './safety.js';
import { BackupManager, safeRelative } from './backup.js';
import { acquireStorageLocks, normalizeLegacyThumbnailPaths, APPLICATION_SCHEMA, imageFormat, canonicalPath } from './storage.js';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { createS3Client, deliverBackup, rotateLocalBackups } from './backup-delivery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const storageRoot = path.resolve(process.env.STORAGE_ROOT || __dirname);
const app = express();

const PORT = process.env.PORT || 7878;
const CONFIG_BASE_URL = process.env.BASE_URL ? process.env.BASE_URL.replace(/\/$/, '') : '';

// --- 自动备份配置 ---
let _backupTimer = null;
let backupTimerGeneration = 0;
function clearBackupTimers() { backupTimerGeneration++; _backupTimer?.(); _backupTimer = null; }
function startBackupTimers(intervalHours) {
  clearBackupTimers();
  const generation = backupTimerGeneration;
  const schedule = delay => {
    _backupTimer = scheduleLongDelay(async () => {
      try { const result = await runAutoBackup(); if (!result.success) console.error(result.message); }
      catch (err) { console.error('Auto-backup failed:', err.message); }
      finally { if (generation === backupTimerGeneration) schedule(intervalHours * 3600000); }
    }, delay);
  };
  schedule(300000);
}

const uploadDir = path.join(storageRoot, 'uploads');
const dataFile = path.join(storageRoot, 'data', 'db.sqlite');
const maxFileMiB = Number(process.env.UPLOAD_MAX_FILE_MIB || 100);
if (!Number.isInteger(maxFileMiB) || maxFileMiB < 1 || maxFileMiB > 100) throw new Error('UPLOAD_MAX_FILE_MIB must be an integer from 1 to 100');
const MAX_FILE_SIZE = maxFileMiB * 1024 * 1024; // retain the original 100 MiB default
const DAILY_UPLOAD_LIMIT = 200;

// --- 简易频率限制 ---
const rateLimitMap = new Map();
function rateLimit({ windowMs = 60000, max = 10 }) {
  return (req, res, next) => {
    const key = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    if (!rateLimitMap.has(key)) rateLimitMap.set(key, []);
    const entries = rateLimitMap.get(key).filter((t) => now - t < windowMs);
    if (entries.length >= max) return res.status(429).json({ message: '请求过于频繁，请稍后再试' });
    entries.push(now);
    rateLimitMap.set(key, entries);
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, entries] of rateLimitMap) {
    const filtered = entries.filter((t) => now - t < 60000);
    if (filtered.length) rateLimitMap.set(key, filtered);
    else rateLimitMap.delete(key);
  }
}, 300000);

const gate = new OperationGate();
const writes = new Mutex();
const admission = new Admission(3, 2);
const restoreAdmission = new Admission(1, 1);
const maintenanceHandlers = new WeakSet();
function maintenance(fn) { maintenanceHandlers.add(fn); return fn; }
function guarded(fn) {
  if (fn.constructor.name !== 'AsyncFunction' || maintenanceHandlers.has(fn)) {
    return (req, res, next) => { try { Promise.resolve(fn(req, res, next)).catch(next); } catch (e) { next(e); } };
  }
  return (req, res, next) => {
    let release;
    try { release = gate.enter(!!req.operationLeases); req.operationLeases = (req.operationLeases || 0) + 1; } catch (e) { return next(e); }
    Promise.resolve(fn(req, res, next)).catch(next).finally(() => { req.operationLeases--; release(); });
  };
}
function trackedStatic(middleware) {
  return (req, res, next) => {
    let release;
    try { release = gate.enter(!!req.operationLeases); } catch (err) { return next(err); }
    const done = () => { release(); res.removeListener('finish', done); res.removeListener('close', done); };
    res.once('finish', done); res.once('close', done);
    try { middleware(req, res, err => { done(); next(err); }); }
    catch (err) { done(); next(err); }
  };
}
function route(method, url, ...handlers) { app[method](url, ...handlers.map(guarded)); }
async function transaction(fn) {
  return writes.run(async () => {
    const db = await getSqlite();
    await db.exec('BEGIN IMMEDIATE');
    try { const result = await fn(db); await db.exec('COMMIT'); return result; }
    catch (e) { await db.exec('ROLLBACK'); throw e; }
  });
}
async function liveUser(req, db) {
  db ||= await getSqlite();
  const user = await db.get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!user || (req.authType === 'apiKey' ? user.apiKey !== req.authValue :
    (user.sessionVersion || 1) !== req.authVersion)) throw httpError(401, 'AUTH_EXPIRED');
  return user;
}
async function writeAs(req, fn, admin = false) {
  return transaction(async db => {
    const user = await liveUser(req, db);
    if (admin && !(user.id === 'admin' || user.level >= 9)) throw httpError(403, 'ADMIN_REQUIRED');
    return fn(db, user);
  });
}
const releaseStorageLocks = await acquireStorageLocks([path.dirname(dataFile), uploadDir]);
// This listener also retains the native handles for the lifetime of the process.
process.once('beforeExit', () => releaseStorageLocks().catch(err => console.error('Storage lock close failed:', err.message)));
const stagingRoot = path.join(storageRoot, 'data', '.incoming');
await fs.ensureDir(stagingRoot);
// Only this process owns this isolated staging directory; stale inputs are never indexed.
await fs.emptyDir(stagingRoot);
function multipart(field, limits, slots) {
  return async (req, res, next) => {
    const release = slots.enter(req.user.id);
    let dir;
    const disconnected = () => { req.uploadAborted = true; };
    const closed = () => { if (!res.writableFinished) disconnected(); };
    req.once('aborted', disconnected);
    res.once('close', closed);
    try {
      dir = await fs.mkdtemp(path.join(stagingRoot, 'request-'));
      req.inputDir = dir;
      const parser = multer({ dest: dir, limits });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          req.uploadAborted = true;
          req.destroy(httpError(408, 'UPLOAD_TIMEOUT'));
        }, 60000);
        parser.single(field)(req, res, err => {
          clearTimeout(timer);
          if (err) reject(err instanceof multer.MulterError || err.code ? err : httpError(400, 'INVALID_MULTIPART'));
          else resolve();
        });
      });
      if (req.uploadAborted) throw httpError(400, 'UPLOAD_ABORTED');
      // The downstream async handler owns cleanup and the slot until processing finishes.
      req.releaseInput = async () => {
        try { await fs.remove(dir); } finally {
          req.removeListener('aborted', disconnected); res.removeListener('close', closed); release();
        }
      };
      next();
    } catch (e) {
      try { if (dir) await fs.remove(dir); } finally {
        req.removeListener('aborted', disconnected); res.removeListener('close', closed); release();
      }
      throw e;
    }
  };
}
const receiveImage = multipart('image', { fileSize: MAX_FILE_SIZE, files: 1, fields: 8, fieldSize: 4096, parts: 9 }, admission);
const receiveBackup = multipart('backup', { fileSize: 1024 ** 3, files: 1, fields: 0, parts: 1 }, restoreAdmission);

function parseBool(value, defaultValue = true) {
  if (value === undefined) return defaultValue;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 'false') return value === 'true';
  throw httpError(400, 'INVALID_BOOLEAN');
}
function newPassword(body, key, required = true) {
  const value = text(body, key, { required, max: 4096, trim: false });
  if (Buffer.byteLength(value, 'utf8') > 72) throw httpError(400, 'PASSWORD_EXCEEDS_72_BYTES');
  return value;
}

await fs.ensureDir(uploadDir);
await fs.ensureDir(path.dirname(dataFile));

// 在反代场景下使用 X-Forwarded-* 头推断真实协议
const proxySetting = process.env.TRUST_PROXY;
app.set('trust proxy', proxySetting === undefined || proxySetting === 'true' ? true : proxySetting === 'false' ? false : proxySetting);

app.use((req, res, next) => (gate.maintenance || gate.failed) ? next(httpError(503, 'MAINTENANCE')) : next());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 30 }));
app.use((req, res, next) => {
  if (gate.maintenance || gate.failed) return next(httpError(503, 'MAINTENANCE'));
  if (req.body && (typeof req.body !== 'object' || Array.isArray(req.body))) return next(httpError(400, 'INVALID_BODY'));
  req.body ||= {};
  next();
});
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'nodeimage-clone-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7, httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' }
  })
);

// 兼容旧链接：尝试从数据库找到新的子目录路径并重定向
route('get', '/uploads/:file', async (req, res, next) => {
  const file = req.params.file;
  if (!file || file.includes('/')) return next();
  try {
    const db = await getSqlite();
    // 优先匹配缩略图，再匹配原图
    const thumbRow = await db.get('SELECT thumbName FROM images WHERE thumbName LIKE ?', `%/${file}`);
    if (thumbRow?.thumbName) {
      return res.redirect(`/uploads/${thumbRow.thumbName}`);
    }
    const imgRow = await db.get('SELECT filename FROM images WHERE filename LIKE ?', `%/${file}`);
    if (imgRow?.filename) {
      return res.redirect(`/uploads/${imgRow.filename}`);
    }
  } catch (err) {
    console.error('兼容旧链接查询失败', err.message);
  }
  return next();
});

// Regenerate only an indexed thumbnail, with bounded decoding and a live-row
// check before publication so deletion cannot race a thumbnail back into existence.
const thumbnailAdmission = new Admission(2, 1);
app.use('/uploads/thumbs', guarded(async (req, res, next) => {
  const rel = `thumbs/${req.path.replace(/^\/+/, '')}`;
  if (!safeRelative(rel)) throw httpError(400, 'INVALID_PATH');
  const thumbPath = path.join(uploadDir, rel);
  if (await fs.pathExists(thumbPath)) return next();
  const db = await getSqlite();
  const image = await db.get('SELECT * FROM images WHERE thumbName = ?', rel);
  if (!image || !safeRelative(image.filename)) return next();
  const release = thumbnailAdmission.enter(req.ip);
  try {
    const thumb = await sharp(path.join(uploadDir, image.filename), { limitInputPixels: 40_000_000 })
      .resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    await transaction(async conn => {
      if (!await conn.get('SELECT id FROM images WHERE id = ? AND filename = ? AND thumbName = ?', image.id, image.filename, rel)) return;
      await fs.ensureDir(path.dirname(thumbPath));
      await fs.writeFile(thumbPath, thumb);
    });
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  finally { release(); }
  next();
}));

app.use('/uploads', guarded(async (req, res, next) => {
  let relative;
  try { relative = decodeURIComponent(req.path).replace(/^\/+/, ''); }
  catch { throw httpError(400, 'INVALID_PATH'); }
  if (!safeRelative(relative)) return res.status(404).end();
  const db = await getSqlite();
  const pending = await db.all('SELECT filePath FROM pending_deletions');
  if (pending.some(item => canonicalPath(item.filePath) === canonicalPath(relative))) return res.status(404).end();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (path.extname(relative).toLowerCase() === '.avif') res.type('image/avif');
  if (path.extname(relative).toLowerCase() === '.heif' && (await db.get('SELECT mime FROM images WHERE filename = ?', relative))?.mime === 'image/avif') res.type('image/avif');
  next();
}));
app.use('/uploads', trackedStatic(express.static(uploadDir)));
app.use('/uploads', (req, res) => res.status(404).end());
app.use(express.static(path.join(__dirname, 'public')));

const allowedMime = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/avif'
]);

let sqliteDb;
let sqliteOpening;
async function getSqlite() {
  if (sqliteDb) return sqliteDb;
  if (sqliteOpening) return sqliteOpening;
  sqliteOpening = (async () => {
    await fs.ensureDir(path.dirname(dataFile));
    const db = await open({
      filename: dataFile,
      driver: sqlite3.Database
    });
    try {
    await db.exec(`PRAGMA journal_mode=WAL; ${APPLICATION_SCHEMA}`);
    // 补齐缺失的 sessionVersion 列（历史数据库）
    const cols = await db.all(`PRAGMA table_info(users)`);
    const hasSessionVersion = cols.some((c) => c.name === 'sessionVersion');
    if (!hasSessionVersion) {
      await db.exec(`ALTER TABLE users ADD COLUMN sessionVersion INTEGER DEFAULT 1`);
    }
    sqliteDb = db;
    return db;
    } catch (err) { await db.close().catch(() => {}); throw err; }
  })();
  try { return await sqliteOpening; } finally { sqliteOpening = null; }
}

async function resetSqlite() {
  if (sqliteOpening) await sqliteOpening;
  if (sqliteDb) {
    const checkpoint = await sqliteDb.get('PRAGMA wal_checkpoint(TRUNCATE)');
    if (checkpoint.busy) throw httpError(503, 'DATABASE_BUSY');
    await sqliteDb.close();
  }
  sqliteDb = null;
}

async function ensureDefaultUserSql() {
  const db = await getSqlite();
  const admin = await db.get('SELECT * FROM users WHERE id = ?', 'admin');
  if (!admin) {
    const passwordHash = bcrypt.hashSync('admin', 10);
    await db.run(
      'INSERT INTO users (id, username, passwordHash, apiKey, level, sessionVersion, createdAt) VALUES (?,?,?,?,?,?,?)',
      'admin',
      'admin',
      passwordHash,
      generateApiKey(),
      1,
      1,
      Date.now()
    );
  }
}

// Reads have no migration or default-user side effects. Legacy file paths remain valid.
async function getBranding() {
  const db = await getSqlite();
  const row = await db.get('SELECT value FROM settings WHERE key = ?', 'branding');
  return row ? JSON.parse(row.value) : { name: 'Nodeimage', subtitle: 'NodeSeek专用图床·克隆版', icon: '', registrationEnabled: false };
}
const imageColumns = ['id', 'userId', 'filename', 'thumbName', 'mime', 'size', 'width', 'height', 'createdAt', 'autoDelete', 'deleteAfterDays'];
async function insertImage(db, record) {
  return db.run(`INSERT INTO images (${imageColumns.join(',')}) VALUES (${imageColumns.map(() => '?').join(',')})`,
    ...imageColumns.map(k => k === 'autoDelete' ? Number(!!record[k]) : record[k] ?? null));
}
async function queueFileRemoval(db, images) {
  for (const image of images) for (const relative of [image.filename, image.thumbName].filter(Boolean)) {
    if (!safeRelative(relative)) throw new Error('Unsafe stored image path');
    await db.run('INSERT OR IGNORE INTO pending_deletions (filePath, createdAt) VALUES (?,?)', relative, Date.now());
  }
}
async function removeFiles() {
  await transaction(async db => {
    for (const item of await db.all('SELECT filePath FROM pending_deletions')) {
      try {
        if (!safeRelative(item.filePath)) throw new Error('Unsafe pending image path');
        await fs.remove(path.join(uploadDir, item.filePath));
        await db.run('DELETE FROM pending_deletions WHERE filePath = ?', item.filePath);
      } catch (err) { console.warn('Deferred file cleanup:', err.code || err.message); }
    }
  });
}

function getBaseUrl(req) {
  if (CONFIG_BASE_URL) return CONFIG_BASE_URL;
  const xfProto = req.get('x-forwarded-proto') || req.get('x-forwarded-scheme');
  let protocol = (xfProto || (req.secure ? 'https' : req.protocol) || 'http').split(',')[0].trim();
  // 如果 Referer/Origin 是 https，则优先用 https，避免反代未带 proto 头时出现 http 链接
  const ref = req.get('referer') || req.get('origin') || '';
  if (ref.startsWith('https://')) protocol = 'https';
  if (req.get('front-end-https') === 'on') protocol = 'https';
  const xfHost = req.get('x-forwarded-host');
  const hostHeader = req.get('host');
  const host = (xfHost || hostHeader || '').split(',')[0].trim();
  return `${protocol}://${host}`;
}

function generateApiKey() {
  return nanoid(48);
}

function getTodayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { start: start.getTime(), end: end.getTime() };
}

async function getUser(req) {
  const db = await getSqlite();
  // An explicitly supplied API key is an independent credential. Password changes
  // revoke cookie sessions; key rotation/account deletion revoke API keys.
  const apiKey = req.get('x-api-key');
  if (apiKey) {
    req.authType = 'apiKey'; req.authValue = apiKey;
    return db.get('SELECT * FROM users WHERE apiKey = ?', apiKey);
  }
  req.authType = 'session';
  req.authVersion = req.session?.sessionVersion || 1;
  if (!req.session?.userId) return null;
  const user = await db.get('SELECT * FROM users WHERE id = ?', req.session.userId);
  if (user && (user.sessionVersion || 1) === req.authVersion) return user;
  req.session.destroy(() => {});
  return null;
}
async function requireAuth(req, res, next) {
  req.user = await getUser(req);
  if (!req.user) throw httpError(401, 'AUTH_REQUIRED');
  next();
}
async function attachUser(req, res, next) { req.user = await getUser(req); next(); }

function createWatermarkSvg(text, width = 800, height = 2400) {
  const fontSize = Math.max(1, Math.min(Math.max(16, Math.round(width / 25)), Math.floor(height / 3) || 1));
  const padding = Math.round(fontSize * 0.6);
  return `\n    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${Math.max(1, Math.min(height, fontSize * 3))}">\n      <style>\n        .watermark {\n          fill: rgba(255,255,255,0.7);\n          font-size: ${fontSize}px;\n          font-family: 'Helvetica Neue', Arial, sans-serif;\n          font-weight: 600;\n          paint-order: stroke;\n          stroke: rgba(0,0,0,0.35);\n          stroke-width: 2px;\n        }\n      </style>\n      <text x="${width - padding}" y="${fontSize + padding}" text-anchor="end" class="watermark">${text.replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;'}[c]))}</text>\n    </svg>\n  `;
}

async function processImage(buffer, options) {
  const { compressToWebp, webpQuality, watermarkText } = options;
  const base = sharp(buffer, { animated: true, limitInputPixels: 40_000_000 }).rotate();
  const meta = await base.metadata();
  const decodedFormat = imageFormat(meta);

  let pipeline = base;
  if (watermarkText) {
    const svg = createWatermarkSvg(watermarkText, meta.autoOrient?.width || meta.width || 800, meta.pageHeight || meta.autoOrient?.height || meta.height || 2400);
    pipeline = pipeline.composite([{ input: Buffer.from(svg), gravity: 'southeast' }]);
  }

  let outputMime = decodedFormat.mime;
  let ext = decodedFormat.ext;
  if (ext === 'avif') pipeline = pipeline.avif();
  if (compressToWebp && meta.format !== 'gif' && meta.format !== 'svg') {
    pipeline = pipeline.webp({ quality: webpQuality || 90 });
    outputMime = 'image/webp';
    ext = 'webp';
  }

  const outputBuffer = await pipeline.toBuffer();
  const finalMeta = await sharp(outputBuffer).metadata();
  return {
    buffer: outputBuffer,
    mime: outputMime,
    ext,
    width: finalMeta.width,
    height: finalMeta.height,
    size: outputBuffer.length
  };
}

route('get', '/api/user/status', attachUser, async (req, res) => {
  const user = req.user;
  if (!user) return res.json({ authenticated: false });
  const { start, end } = getTodayRange();
  const db = await getSqlite();
  const { count } = await db.get('SELECT count(*) AS count FROM images WHERE userId = ? AND createdAt BETWEEN ? AND ?', user.id, start, end);
  res.json({ authenticated: true, id: user.id, username: user.username, level: user.level,
    dailyUploads: count, dailyUploadLimit: DAILY_UPLOAD_LIMIT, apiKey: user.apiKey });
});

route('post', '/api/auth/login', rateLimit({ windowMs: 60000, max: 10 }), async (req, res) => {
  const username = text(req.body, 'username', { required: true, max: 30 });
  const password = text(req.body, 'password', { required: true, max: 4096, trim: false });
  const db = await getSqlite();
  let user = await db.get('SELECT * FROM users WHERE username = ?', username);
  if (!user) throw httpError(401, '用户名或密码错误');
  const originalHash = user.passwordHash;
  if (originalHash && !await bcrypt.compare(password, originalHash)) throw httpError(401, '用户名或密码错误');
  const initialHash = !originalHash ? await bcrypt.hash(password, 10) : null;
  user = await transaction(async conn => {
    const current = await conn.get('SELECT * FROM users WHERE id = ?', user.id);
    if (!current || current.passwordHash !== originalHash || current.username !== username) throw httpError(401, 'AUTH_EXPIRED');
    if (initialHash) await conn.run('UPDATE users SET passwordHash = ? WHERE id = ?', initialHash, user.id);
    return current;
  });
  req.session.userId = user.id;
  req.session.sessionVersion = user.sessionVersion || 1;
  res.json({ message: '登录成功', user: { username: user.username, level: user.level }, defaultCreds: username === 'admin' && password === 'admin' });
});
route('post', '/api/auth/logout', async (req, res) => {
  await new Promise((resolve, reject) => req.session.destroy(err => err ? reject(err) : resolve()));
  res.json({ message: '已注销' });
});
route('post', '/api/auth/register', async (req, res) => {
  const username = text(req.body, 'username', { required: true, max: 30 });
  const password = newPassword(req.body, 'password');
  if (!(await getBranding()).registrationEnabled) throw httpError(403, '注册已关闭');
  const passwordHash = await bcrypt.hash(password, 10);
  const user = { id: nanoid(12), apiKey: generateApiKey() };
  await transaction(async db => {
    if (!(await getBranding()).registrationEnabled) throw httpError(403, '注册已关闭');
    await db.run('INSERT INTO users (id, username, passwordHash, apiKey, level, sessionVersion, createdAt) VALUES (?,?,?,?,1,1,?)',
      user.id, username, passwordHash, user.apiKey, Date.now());
  });
  req.session.userId = user.id; req.session.sessionVersion = 1;
  res.json({ message: '注册成功', user: { username, level: 1 } });
});
function requireAdmin(req, res, next) {
  if (req.user && (req.user.id === 'admin' || req.user.level >= 9)) return next();
  throw httpError(403, '仅管理员可操作');
}
route('get', '/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const db = await getSqlite();
  res.json({ users: await db.all('SELECT id, username, level, createdAt FROM users') });
});
route('post', '/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const username = text(req.body, 'username', { required: true, max: 30 });
  const password = newPassword(req.body, 'password', false);
  const hash = password ? await bcrypt.hash(password, 10) : null;
  await writeAs(req, async db => {
    const target = await db.get('SELECT * FROM users WHERE id = ?', req.params.id);
    if (!target) throw httpError(404, '用户不存在');
    if (username !== target.username || hash) await db.run(
      'UPDATE users SET username = ?, passwordHash = ?, sessionVersion = COALESCE(sessionVersion,1) + 1 WHERE id = ?',
      username, hash || target.passwordHash, target.id);
  }, true);
  res.json({ message: '已更新用户' });
});
route('delete', '/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = req.params.id;
  if (id === 'admin') throw httpError(400, '不可删除管理员');
  const removedImages = await writeAs(req, async db => {
    if (!await db.get('SELECT id FROM users WHERE id = ?', id)) throw httpError(404, '用户不存在');
    const images = await db.all('SELECT * FROM images WHERE userId = ?', id);
    await queueFileRemoval(db, images);
    await db.run('DELETE FROM images WHERE userId = ?', id);
    await db.run('DELETE FROM users WHERE id = ?', id);
    return images;
  }, true);
  await removeFiles(removedImages);
  res.json({ message: '已删除用户' });
});
async function handleCredentialUpdate(req, res) {
  const oldPassword = text(req.body, 'oldPassword', { required: true, max: 4096, trim: false });
  const nextPassword = newPassword(req.body, 'newPassword');
  const username = text(req.body, 'newUsername', { required: true, max: 30 });
  const originalHash = req.user.passwordHash;
  if (!originalHash || !await bcrypt.compare(oldPassword, originalHash)) throw httpError(401, '原密码错误');
  const hash = await bcrypt.hash(nextPassword, 10);
  await writeAs(req, async (db, user) => {
    if (user.passwordHash !== originalHash) throw httpError(409, 'CREDENTIALS_CHANGED');
    await db.run('UPDATE users SET username = ?, passwordHash = ?, sessionVersion = COALESCE(sessionVersion,1) + 1 WHERE id = ?', username, hash, user.id);
  });
  req.session.destroy(() => {});
  res.json({ message: '账号密码已更新，请重新登录', username });
}
route('post', '/api/user/password', requireAuth, handleCredentialUpdate);
route('post', '/api/user/credentials', requireAuth, handleCredentialUpdate);
route('get', '/api/user/api-key', requireAuth, async (req, res) => { res.json({ apiKey: req.user.apiKey }); });
route('get', '/api/settings/branding', async (req, res) => { res.json({ ...await getBranding(), uploadMaxFileBytes: MAX_FILE_SIZE }); });
route('post', '/api/settings/branding', requireAuth, requireAdmin, async (req, res) => {
  const branding = { name: text(req.body, 'name') || 'Nodeimage', subtitle: text(req.body, 'subtitle'),
    icon: text(req.body, 'icon', { max: 4096 }), registrationEnabled: parseBool(req.body.registrationEnabled, false) };
  await writeAs(req, db => db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', 'branding', JSON.stringify(branding)), true);
  res.json({ message: '已更新图床设置', branding });
});
route('post', '/api/user/regenerate-api-key', requireAuth, async (req, res) => {
  const apiKey = generateApiKey();
  await writeAs(req, (db, user) => db.run('UPDATE users SET apiKey = ? WHERE id = ?', apiKey, user.id));
  res.json({ apiKey });
});

// --- 备份设置 ---
const BACKUP_DEFAULTS = {
  intervalHours: 24,
  keepCount: 7,
  s3Endpoint: '',
  s3Region: 'auto',
  s3Bucket: '',
  s3AccessKey: '',
  s3SecretKey: '',
  webhookUrl: ''
};

function backupNumber(value, fallback, max, integer = false) {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isFinite(number) || number < 1 || number > max || (integer && !Number.isInteger(number))) throw httpError(400, 'INVALID_BACKUP_SCHEDULE');
  return number;
}
async function getBackupConfig() {
  const db = await getSqlite();
  const row = await db.get('SELECT value FROM settings WHERE key = ?', 'backup');
  const saved = row ? JSON.parse(row.value) : {};
  const config = {};
  for (const key of Object.keys(BACKUP_DEFAULTS)) config[key] = saved[key] ?? BACKUP_DEFAULTS[key];
  const envNames = { s3Endpoint: 'S3_ENDPOINT', s3Region: 'S3_REGION', s3Bucket: 'S3_BUCKET', s3AccessKey: 'S3_ACCESS_KEY', s3SecretKey: 'S3_SECRET_KEY', webhookUrl: 'BACKUP_WEBHOOK_URL' };
  for (const [key, name] of Object.entries(envNames)) if (process.env[name]) config[key] = process.env[name];
  config.intervalHours = backupNumber(process.env.BACKUP_INTERVAL_HOURS || config.intervalHours, 24, 720);
  config.keepCount = backupNumber(process.env.BACKUP_KEEP_COUNT || config.keepCount, 7, 365, true);
  return config;
}

route('get', '/api/settings/backup', requireAuth, requireAdmin, async (req, res) => {
  const config = await getBackupConfig();
  // 密钥脱敏
  config.s3AccessKey = config.s3AccessKey ? '***' + config.s3AccessKey.slice(-4) : '';
  config.s3SecretKey = config.s3SecretKey ? '***' : '';
  res.json(config);
});

route('post', '/api/settings/backup', requireAuth, requireAdmin, async (req, res) => {
  const updated = await writeAs(req, async db => {
    const current = await getBackupConfig();
    const updated = {
      intervalHours: backupNumber(req.body.intervalHours, current.intervalHours, 720),
      keepCount: backupNumber(req.body.keepCount, current.keepCount, 365, true),
      s3Endpoint: req.body.s3Endpoint !== undefined ? String(req.body.s3Endpoint).trim() : current.s3Endpoint,
      s3Region: req.body.s3Region !== undefined ? String(req.body.s3Region).trim() : current.s3Region,
      s3Bucket: req.body.s3Bucket !== undefined ? String(req.body.s3Bucket).trim() : current.s3Bucket,
      s3AccessKey: req.body.s3AccessKey !== undefined ? String(req.body.s3AccessKey).trim() : current.s3AccessKey,
      s3SecretKey: req.body.s3SecretKey !== undefined ? String(req.body.s3SecretKey).trim() : current.s3SecretKey,
      webhookUrl: req.body.webhookUrl !== undefined ? String(req.body.webhookUrl).trim() : current.webhookUrl
    };
    for (const key of ['s3AccessKey', 's3SecretKey']) {
      if (!updated[key] || updated[key].startsWith('***')) updated[key] = current[key];
    }
    await db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', 'backup', JSON.stringify(updated));
    return updated;
  }, true);
  // 重置 S3 连接缓存
  // 重置备份定时器
  clearBackupTimers();
  startBackupTimers((await getBackupConfig()).intervalHours);
  // 脱敏返回
  const result = { ...updated };
  result.s3AccessKey = result.s3AccessKey ? '***' + result.s3AccessKey.slice(-4) : '';
  result.s3SecretKey = result.s3SecretKey ? '***' : '';
  res.json({ message: '备份设置已更新', config: result });
});

// 测试 S3 连接
route('post', '/api/settings/backup/test-s3', requireAuth, requireAdmin, async (req, res) => {
  const config = await getBackupConfig();
  if (!config.s3Endpoint || !config.s3Bucket || !config.s3AccessKey || !config.s3SecretKey) {
    return res.status(400).json({ message: 'S3 配置不完整' });
  }
  try {
    const testClient = createS3Client(config);
    try { await testClient.send(new ListObjectsV2Command({ Bucket: config.s3Bucket, MaxKeys: 1 })); }
    finally { testClient.destroy(); }
    res.json({ message: 'S3 连接成功' });
  } catch (err) {
    res.status(400).json({ message: 'S3 连接失败', error: err.message });
  }
});

// 测试 Webhook
route('post', '/api/settings/backup/test-webhook', requireAuth, requireAdmin, async (req, res) => {
  const config = await getBackupConfig();
  if (!config.webhookUrl) return res.status(400).json({ message: 'Webhook URL 未配置' });
  try {
    const res2 = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-Backup-Test': 'true' },
      signal: AbortSignal.timeout(10000),
      body: 'nodeimage backup test ping'
    });
    await res2.body?.cancel();
    if (!res2.ok) throw new Error(`HTTP ${res2.status}`);
    res.json({ message: 'Webhook 连接成功' });
  } catch (err) {
    res.status(400).json({ message: 'Webhook 连接失败', error: err.message });
  }
});

const backups = new BackupManager({ storageRoot, uploadDir, dataFile, getSqlite, resetSqlite, gate });
// Recovery runs before opening the database or accepting requests.
await backups.recover();
for (const entry of await fs.readdir(path.dirname(dataFile))) {
  if (entry.startsWith('.snapshot-') || entry.startsWith('.restore-stage-')) await fs.remove(path.join(path.dirname(dataFile), entry));
}
for (const entry of await fs.readdir(uploadDir)) {
  if (entry.startsWith('.restore-stage-')) await fs.remove(path.join(uploadDir, entry));
}
await ensureDefaultUserSql();
await normalizeLegacyThumbnailPaths(await getSqlite(), uploadDir);
// Historical AVIF records used sharp's 'heif' format and octet-stream MIME.
// Confirm the actual codec before correcting metadata; keep existing URLs intact.
for (const image of await (await getSqlite()).all("SELECT id, filename FROM images WHERE lower(filename) LIKE '%.heif'")) {
  if (!safeRelative(image.filename)) continue;
  try {
    const format = imageFormat(await sharp(path.join(uploadDir, image.filename), { limitInputPixels: false }).metadata());
    if (format.ext === 'avif') await (await getSqlite()).run('UPDATE images SET mime = ? WHERE id = ?', format.mime, image.id);
  } catch (err) { console.warn('Legacy HEIF inspection skipped:', err.code || err.message); }
}
await removeFiles();

route('get', '/api/backup', requireAuth, requireAdmin, maintenance(async (req, res) => {
  const outPath = await backups.create(async () => { await liveUser(req); });
  res.download(outPath, path.basename(outPath), err => {
    fs.remove(outPath).catch(() => {});
    if (err && !res.headersSent) res.status(500).end();
  });
}));
route('post', '/api/backup/restore', requireAuth, requireAdmin, receiveBackup, maintenance(async (req, res) => {
  try {
    if (!req.file) throw httpError(400, '缺少备份文件');
    await backups.restore(req.file.path, async () => {
      if (req.uploadAborted) throw httpError(400, 'UPLOAD_ABORTED');
      await liveUser(req);
    }, async () => {
      await new Promise((resolve, reject) => req.sessionStore.clear(err => err ? reject(err) : resolve()));
      req.session.destroy(() => {});
    });
    startBackupTimers((await getBackupConfig()).intervalHours);
    res.json({ message: '备份已恢复，原数据已保留在回滚目录' });
  } finally { await req.releaseInput?.(); }
}));

route('get', '/api/stats', async (req, res) => {
  const db = await getSqlite();
  const { start, end } = getTodayRange();
  const row = await db.get('SELECT count(*) AS total, COALESCE(sum(size),0) AS totalSize, COALESCE(sum(createdAt BETWEEN ? AND ?),0) AS today FROM images', start, end);
  res.json(row);
});

route('post', '/api/upload', requireAuth, receiveImage, async (req, res) => {
  let published = [];
  try {
    if (!req.file) throw httpError(400, '缺少图片文件');
    if (!allowedMime.has(req.file.mimetype)) throw httpError(400, '不支持的文件类型');
    const compressToWebp = String(req.body.compressToWebp ?? 'true') !== 'false';
    const webpQuality = Math.min(100, Math.max(10, Number(req.body.webpQuality) || 90));
    const watermarkContent = text(req.body, 'watermarkContent', { max: 256 });
    const watermarkText = String(req.body.autoWatermark) === 'true' ? (watermarkContent || 'nodeimage.com clone') : '';
    const autoDelete = String(req.body.autoDelete) === 'true';
    const deleteDays = Math.min(365, Math.max(1, Number(req.body.deleteDays) || 30));
    let processed;
    try { processed = await processImage(req.file.path, { compressToWebp, webpQuality, watermarkText }); }
    catch (err) { throw err.code ? err : httpError(400, 'INVALID_IMAGE'); }
    const thumbBuffer = await sharp(processed.buffer).resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    if (req.uploadAborted) throw httpError(400, 'UPLOAD_ABORTED');
    const now = new Date();
    const rel = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
    const id = nanoid(12);
    const filename = `${rel}/${id}.${processed.ext}`;
    const thumbName = `thumbs/${rel}/${id}_thumb.webp`;
    const record = { id, userId: req.user.id, filename, thumbName, mime: processed.mime, size: processed.size,
      width: processed.width, height: processed.height, createdAt: Date.now(), autoDelete, deleteAfterDays: autoDelete ? deleteDays : null };
    await writeAs(req, async (db, user) => {
      if (req.uploadAborted) throw httpError(400, 'UPLOAD_ABORTED');
      const { start, end } = getTodayRange();
      const { count } = await db.get('SELECT count(*) AS count FROM images WHERE userId = ? AND createdAt BETWEEN ? AND ?', user.id, start, end);
      if (count >= DAILY_UPLOAD_LIMIT) throw httpError(429, '已达到今日上传上限');
      for (const [relPath, buffer] of [[filename, processed.buffer], [thumbName, thumbBuffer]]) {
        const dest = path.join(uploadDir, relPath);
        published.push(dest);
        await fs.ensureDir(path.dirname(dest));
        await fs.writeFile(dest, buffer, { flag: 'wx' });
      }
      if (req.uploadAborted) throw httpError(400, 'UPLOAD_ABORTED');
      await insertImage(db, record);
    });
    published = [];
    const fileUrl = `${getBaseUrl(req)}/uploads/${filename}`;
    res.json({ id, url: fileUrl, thumbUrl: `${getBaseUrl(req)}/uploads/${thumbName}`, size: processed.size,
      width: processed.width, height: processed.height, format: processed.ext,
      markdown: `![image](${fileUrl})`, html: `<img src="${fileUrl}" alt="image" />`, bbcode: `[img]${fileUrl}[/img]` });
  } finally {
    try { for (const filename of published) await fs.remove(filename); }
    finally { await req.releaseInput?.(); }
  }
});
async function listImages(req, res, v1 = false) {
  const requestedPage = Number(req.query.page ?? 1);
  const requestedLimit = Number(req.query.limit ?? (v1 ? 50 : 20));
  if (!Number.isFinite(requestedPage) || !Number.isFinite(requestedLimit)) throw httpError(400, 'INVALID_PAGINATION');
  const page = Math.min(1_000_000, Math.max(1, Math.floor(requestedPage) || 1));
  const limit = Math.min(v1 ? 100 : 60, Math.max(1, Math.floor(requestedLimit) || (v1 ? 50 : 20)));
  const db = await getSqlite();
  const { total } = await db.get('SELECT count(*) AS total FROM images WHERE userId = ?', req.user.id);
  const images = await db.all('SELECT * FROM images WHERE userId = ? ORDER BY createdAt DESC LIMIT ? OFFSET ?', req.user.id, limit, (page - 1) * limit);
  const items = images.map(img => ({ ...img, url: `${getBaseUrl(req)}/uploads/${img.filename}`, thumbUrl: `${getBaseUrl(req)}/uploads/${img.thumbName || img.filename}` }));
  res.json({ items, total, totalPages: Math.max(v1 ? 0 : 1, Math.ceil(total / limit)), currentPage: page });
}
route('get', '/api/images', requireAuth, async (req, res) => { await listImages(req, res); });
route('get', '/api/v1/list', requireAuth, async (req, res) => { await listImages(req, res, true); });
async function deleteImages(req, ids) {
  const removed = await writeAs(req, async (db, user) => {
    const images = await db.all(`SELECT * FROM images WHERE userId = ? AND id IN (${ids.map(() => '?').join(',')})`, user.id, ...ids);
    await queueFileRemoval(db, images);
    for (const img of images) await db.run('DELETE FROM images WHERE id = ? AND userId = ?', img.id, user.id);
    return images;
  });
  await removeFiles(removed);
  return removed.length;
}
route('post', '/api/images/delete', requireAuth, async (req, res) => {
  const ids = req.body.ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some(x => typeof x !== 'string')) throw httpError(400, 'INVALID_IDS');
  await deleteImages(req, ids);
  res.json({ message: '删除完成' });
});
route('delete', '/api/v1/delete/:id', requireAuth, async (req, res) => {
  if (!await deleteImages(req, [req.params.id])) throw httpError(404, '未找到图片');
  res.json({ message: '删除成功' });
});

// --- 备份 API ---
route('post', '/api/backup/auto', requireAuth, requireAdmin, maintenance(async (req, res) => {
  const result = await runAutoBackup(req);
  res.status(result.success ? 200 : 502).json(result);
}));

route('get', '/api/backup/status', requireAuth, requireAdmin, async (req, res) => {
  const config = await getBackupConfig();
  res.json({
    s3: { configured: !!(config.s3Endpoint && config.s3Bucket && config.s3AccessKey && config.s3SecretKey), endpoint: config.s3Endpoint || null, bucket: config.s3Bucket || null },
    webhook: { configured: !!config.webhookUrl, url: config.webhookUrl || null },
    intervalHours: config.intervalHours,
    keepCount: config.keepCount
  });
});

app.use('/api', (req, res) => res.status(404).json({ message: 'NOT_FOUND' }));
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- 自动删除过期图片 ---
async function cleanupExpiredImages() {
  let release;
  try {
    release = gate.enter();
    const removed = await transaction(async db => {
      const images = await db.all('SELECT * FROM images WHERE autoDelete = 1 AND deleteAfterDays IS NOT NULL AND createdAt + deleteAfterDays * 86400000 <= ?', Date.now());
      await queueFileRemoval(db, images);
      for (const img of images) await db.run('DELETE FROM images WHERE id = ?', img.id);
      return images;
    });
    await removeFiles(removed);
  } catch (err) { if (err.status !== 503) console.error('Auto-delete cleanup error:', err.message); }
  finally { release?.(); }
}
setInterval(cleanupExpiredImages, 3600000).unref();

// --- 自动备份：S3 与 Webhook ---
function backupStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}-${d.getTime()}`;
}

let autoBackupRunning = false;
async function runAutoBackup(req) {
  if (autoBackupRunning) throw httpError(409, 'BACKUP_BUSY');
  autoBackupRunning = true;
  let release;
  try { return await performAutoBackup(req, () => { release = gate.enter(); }); }
  finally { release?.(); autoBackupRunning = false; }
}
async function performAutoBackup(req, holdData) {
  const filePath = await backups.create(req ? async () => { await liveUser(req); } : undefined);
  holdData();
  // One effective configuration per run: client, bucket, delivery and rotation agree.
  const config = await getBackupConfig();
  const results = await deliverBackup(filePath, backupStamp(), config);
  await rotateLocalBackups(path.dirname(dataFile), config.keepCount);
  const failed = results.some(result => result.success === false);
  const configured = results.some(result => !result.skipped);
  return { success: !failed, message: failed ? '本地备份已生成，部分远端备份失败' :
    configured ? '本地及已配置远端备份完成' : '本地备份完成（未配置远端目标）', results };
}

// 定时自动备份
const config = await getBackupConfig();
startBackupTimers(config.intervalHours);

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err instanceof multer.MulterError ? (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400) :
    err.code === 'SQLITE_CONSTRAINT' ? 409 : (err.status || 500);
  if (status >= 500 && status !== 503) console.error('Request failed:', err.message);
  if (!res.destroyed) res.status(status).json({ message: status >= 500 && status !== 503 ? 'INTERNAL_ERROR' : err.message });
});

const server = app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  console.log(`Nodeimage clone running at http://localhost:${server.address().port}`);
});
