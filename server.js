import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import sharp from 'sharp';
import { nanoid } from 'nanoid';
import fs from 'fs-extra';
import path from 'path';
import mime from 'mime-types';
import bcrypt from 'bcryptjs';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { spawn } from 'child_process';
import { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

const __dirname = process.cwd();
const app = express();

const PORT = process.env.PORT || 7878;
const CONFIG_BASE_URL = process.env.BASE_URL ? process.env.BASE_URL.replace(/\/$/, '') : '';

// --- 自动备份配置 ---
let s3Client;
let _backupTimer = null;
function clearBackupTimers() {
  if (_backupTimer) { clearTimeout(_backupTimer); clearInterval(_backupTimer); _backupTimer = null; }
}
function startBackupTimers(intervalHours) {
  clearBackupTimers();
  const ms = intervalHours * 3600000;
  _backupTimer = setTimeout(() => {
    runAutoBackup();
    _backupTimer = setInterval(runAutoBackup, ms);
  }, 300000); // 启动后 5 分钟首次执行
}

async function getS3Client() {
  const config = await getBackupConfig();
  if (!config.s3Endpoint || !config.s3Bucket || !config.s3AccessKey || !config.s3SecretKey) return null;
  if (s3Client) return s3Client;
  s3Client = new S3Client({
    endpoint: config.s3Endpoint,
    region: config.s3Region,
    credentials: { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey },
    forcePathStyle: true
  });
  return s3Client;
}

const uploadDir = path.join(__dirname, 'uploads');
const dataFile = path.join(__dirname, 'data', 'db.sqlite');
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const DAILY_UPLOAD_LIMIT = 200;
const MAX_CONCURRENT_UPLOADS = 3;

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

// --- 并发控制 ---
let activeUploads = 0;
const uploadQueue = [];
function enqueueUpload(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      activeUploads++;
      try { resolve(await fn()); }
      catch (err) { reject(err); }
      finally {
        activeUploads--;
        if (uploadQueue.length > 0) uploadQueue.shift()();
      }
    };
    if (activeUploads < MAX_CONCURRENT_UPLOADS) run();
    else uploadQueue.push(run);
  });
}

function parseBool(val, defaultVal = true) {
  if (val === undefined || val === null) return defaultVal;
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') return val.toLowerCase() === 'true';
  return Boolean(val);
}

await fs.ensureDir(uploadDir);
await fs.ensureDir(path.dirname(dataFile));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE }
});

// 在反代场景下使用 X-Forwarded-* 头推断真实协议
app.set('trust proxy', true);

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'nodeimage-clone-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7, httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' }
  })
);

// 兼容旧链接：尝试从数据库找到新的子目录路径并重定向
app.get('/uploads/:file', async (req, res, next) => {
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

// 缩略图自动重生：找不到时从原图生成
app.use('/uploads/thumbs', async (req, res, next) => {
  const thumbPath = path.join(uploadDir, 'thumbs', req.path.replace(/^\/+/, ''));
  if (await fs.pathExists(thumbPath)) return next();

  // 从路径推断原图文件名：xxx_thumb.webp → xxx.webp (或其他扩展名)
  const thumbFile = path.basename(req.path);
  if (!thumbFile.endsWith('_thumb.webp')) return next();

  const baseName = thumbFile.replace(/_thumb\.webp$/, '');
  const thumbDir = path.dirname(req.path); // e.g. /2026/05

  // 查找原图
  let originalRel = null;
  for (const ext of ['webp', 'png', 'jpg', 'jpeg', 'gif', 'avif']) {
    const test = path.join(thumbDir.replace(/^\/+/, ''), `${baseName}.${ext}`);
    if (await fs.pathExists(path.join(uploadDir, test))) {
      originalRel = test;
      break;
    }
  }
  // 也查数据库
  if (!originalRel) {
    try {
      const db = await getSqlite();
      const row = await db.get('SELECT filename FROM images WHERE thumbName LIKE ?', `%${thumbFile}`);
      if (row) originalRel = row.filename;
    } catch (e) { /* ignore */ }
  }

  if (!originalRel) return next();

  try {
    const originalPath = path.join(uploadDir, originalRel);
    const buffer = await fs.readFile(originalPath);
    const thumbBuffer = await sharp(buffer)
      .resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    await fs.ensureDir(path.dirname(thumbPath));
    await fs.writeFile(thumbPath, thumbBuffer);
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(thumbBuffer);
  } catch (err) {
    console.error('缩略图重生失败', err.message);
    next();
  }
});

app.use('/uploads', express.static(uploadDir));
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
async function getSqlite() {
  if (sqliteDb) return sqliteDb;
  await fs.ensureDir(path.dirname(dataFile));
  sqliteDb = await open({
    filename: dataFile,
    driver: sqlite3.Database
  });
  await sqliteDb.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE,
      passwordHash TEXT,
      apiKey TEXT,
      level INTEGER,
      sessionVersion INTEGER DEFAULT 1,
      createdAt INTEGER
    );
    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      userId TEXT,
      filename TEXT,
      thumbName TEXT,
      mime TEXT,
      size INTEGER,
      width INTEGER,
      height INTEGER,
      createdAt INTEGER,
      autoDelete INTEGER,
      deleteAfterDays INTEGER
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  // 补齐缺失的 sessionVersion 列（历史数据库）
  const cols = await sqliteDb.all(`PRAGMA table_info(users)`);
  const hasSessionVersion = cols.some((c) => c.name === 'sessionVersion');
  if (!hasSessionVersion) {
    await sqliteDb.exec(`ALTER TABLE users ADD COLUMN sessionVersion INTEGER DEFAULT 1`);
  }
  return sqliteDb;
}

async function resetSqlite() {
  if (sqliteDb) {
    try {
      await sqliteDb.close();
    } catch (e) {
      console.warn('关闭数据库连接时出错', e.message);
    }
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

async function loadDb() {
  const db = await getSqlite();
  await ensureDefaultUserSql();
  const users = await db.all('SELECT * FROM users');
  const images = await db.all('SELECT * FROM images ORDER BY createdAt DESC');
  const settingsRow = await db.get('SELECT value FROM settings WHERE key = ?', 'branding');
  const branding = settingsRow ? JSON.parse(settingsRow.value) : {
    name: 'Nodeimage',
    subtitle: 'NodeSeek专用图床·克隆版',
    icon: '',
    registrationEnabled: false
  };
  const data = { users, images, settings: { branding } };

  // 迁移旧文件：若文件未包含子目录，则移动到当前年月目录
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  let migrated = false;
  for (const img of data.images) {
    if (img.filename && !img.filename.includes('/')) {
      const newRel = `${year}/${month}/${img.filename}`;
      const newDir = path.join(uploadDir, year, month);
      await fs.ensureDir(newDir);
      try {
        const oldPath = path.join(uploadDir, img.filename);
        const newPath = path.join(uploadDir, newRel);
        if (await fs.pathExists(oldPath)) {
          await fs.move(oldPath, newPath, { overwrite: true });
          img.filename = newRel;
          migrated = true;
        }
      } catch (err) {
        console.error('迁移图片失败', err.message);
      }
      if (img.thumbName && !img.thumbName.includes('/')) {
        const newThumbRel = `thumbs/${year}/${month}/${img.thumbName}`;
        const oldThumb = path.join(uploadDir, 'thumbs', img.thumbName);
        const newThumb = path.join(uploadDir, newThumbRel);
        try {
          if (await fs.pathExists(oldThumb)) {
            await fs.ensureDir(path.dirname(newThumb));
            await fs.move(oldThumb, newThumb, { overwrite: true });
            img.thumbName = newThumbRel;
            migrated = true;
          }
        } catch (err) {
          console.error('迁移缩略图失败', err.message);
        }
      }
    }
  }
  // 迁移 v1.1.2 缩略图：从 YYYY/MM/xxx 搬到 thumbs/YYYY/MM/xxx
  for (const img of data.images) {
    if (img.thumbName && img.thumbName.includes('/') && !img.thumbName.startsWith('thumbs/')) {
      const newThumbRel = `thumbs/${img.thumbName}`;
      const oldPath = path.join(uploadDir, img.thumbName);
      const newPath = path.join(uploadDir, newThumbRel);
      try {
        if (await fs.pathExists(oldPath)) {
          await fs.ensureDir(path.dirname(newPath));
          await fs.move(oldPath, newPath, { overwrite: true });
          img.thumbName = newThumbRel;
          migrated = true;
        }
      } catch (err) {
        console.error('迁移缩略图(v1.1.2)失败', err.message);
      }
    }
  }

  if (migrated) {
    await saveDb(data);
  }
  return data;
}

async function saveDb(data) {
  const db = await getSqlite();
  const txn = await db.exec('BEGIN');
  try {
    await db.run('DELETE FROM users');
    const userStmt = await db.prepare('INSERT INTO users (id, username, passwordHash, apiKey, level, sessionVersion, createdAt) VALUES (?,?,?,?,?,?,?)');
    for (const u of data.users) {
      await userStmt.run(
        u.id,
        u.username,
        u.passwordHash || null,
        u.apiKey,
        u.level || 1,
        u.sessionVersion || 1,
        u.createdAt || Date.now()
      );
    }
    await userStmt.finalize();

  await db.run('DELETE FROM images');
  const imgStmt = await db.prepare('INSERT INTO images (id, userId, filename, thumbName, mime, size, width, height, createdAt, autoDelete, deleteAfterDays) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (const img of data.images) {
    await imgStmt.run(
      img.id,
      img.userId,
      img.filename,
      img.thumbName || null,
      img.mime || '',
      img.size || 0,
      img.width || null,
      img.height || null,
      img.createdAt || Date.now(),
      img.autoDelete ? 1 : 0,
      img.deleteAfterDays || null
    );
  }
  await imgStmt.finalize();

    await db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', 'branding', JSON.stringify(data.settings?.branding || {}));
    await db.exec('COMMIT');
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }
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

async function rebuildImagesFromUploads(db, ownerId = 'admin') {
  const images = [];
  const seen = new Set();
  async function walk(dirRel) {
    const dirPath = path.join(uploadDir, dirRel);
    const entries = await fs.readdir(dirPath);
    for (const entry of entries) {
      const rel = dirRel ? path.join(dirRel, entry) : entry;
      const full = path.join(uploadDir, rel);
      const stat = await fs.stat(full);
      if (stat.isDirectory()) {
        await walk(rel);
      } else {
        // 跳过缩略图目录和缩略图文件
        if (entry.endsWith('_thumb.webp') || dirRel === 'thumbs') continue;
        const id = path.parse(entry).name;
        const thumbRel = `thumbs/${dirRel}/${id}_thumb.webp`;
        const thumbExists = await fs.pathExists(path.join(uploadDir, thumbRel));
        images.push({
          id,
          userId: ownerId || 'admin',
          filename: rel,
          thumbName: thumbExists ? thumbRel : null,
          mime: mime.lookup(entry) || 'application/octet-stream',
          size: stat.size,
          width: null,
          height: null,
          createdAt: stat.mtimeMs,
          autoDelete: 0,
          deleteAfterDays: null
        });
        seen.add(rel);
      }
    }
  }
  await walk('');
  db.images = images.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

async function collectUploadFiles() {
  const files = [];
  async function walk(dirRel) {
    const dirPath = path.join(uploadDir, dirRel);
    const entries = await fs.readdir(dirPath);
    for (const entry of entries) {
      const rel = dirRel ? path.join(dirRel, entry) : entry;
      const full = path.join(uploadDir, rel);
      const stat = await fs.stat(full);
      if (stat.isDirectory()) {
        await walk(rel);
      } else {
        if (entry.endsWith('_thumb.webp') || dirRel === 'thumbs') continue;
        const thumbRel = `thumbs/${dirRel}/${path.parse(entry).name}_thumb.webp`;
        const thumbExists = await fs.pathExists(path.join(uploadDir, thumbRel));
        files.push({
          rel,
          thumbRel: thumbExists ? thumbRel : null,
          size: stat.size,
          createdAt: stat.mtimeMs,
          mime: mime.lookup(entry) || 'application/octet-stream'
        });
      }
    }
  }
  await walk('');
  return files;
}

async function reconcileImages(db) {
  const uploads = await collectUploadFiles();
  const existsMap = new Map();
  db.images.forEach((img) => existsMap.set(img.filename, img));
  let changed = false;

  // 保留存在文件的记录
  const kept = [];
  for (const img of db.images) {
    const exists = await fs.pathExists(path.join(uploadDir, img.filename));
    if (exists) {
      kept.push(img);
    } else {
      changed = true;
    }
  }

  // 补全缺失记录
  for (const f of uploads) {
    if (existsMap.has(f.rel)) continue;
    kept.push({
      id: path.parse(f.rel).name,
      userId: 'admin',
      filename: f.rel,
      thumbName: f.thumbRel,
      mime: f.mime,
      size: f.size,
      width: null,
      height: null,
      createdAt: f.createdAt,
      autoDelete: 0,
      deleteAfterDays: null
    });
    changed = true;
  }

  if (changed) {
    kept.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    db.images = kept;
    await saveDb(db);
  }
}

function getTodayRange() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { start: start.getTime(), end: end.getTime() };
}

async function getUser(req) {
  const db = await loadDb();
  let user = null;

  if (req.session?.userId) {
    user = db.users.find((u) => u.id === req.session.userId) || null;
  }

  const apiKey = req.get('x-api-key') || req.get('X-API-Key');
  if (!user && apiKey) {
    user = db.users.find((u) => u.apiKey === apiKey) || null;
  }

  return { user, db };
}

async function requireAuth(req, res, next) {
  const { user, db } = await getUser(req);
  req.db = db;
  if (!user) {
    return res.status(401).json({ message: 'AUTH_REQUIRED' });
  }
  // 会话版本校验：当用户改密或管理员修改账号后，使旧会话失效
  const sessionVersion = req.session?.sessionVersion || 1;
  if ((user.sessionVersion || 1) !== sessionVersion) {
    req.session.destroy(() => {});
    return res.status(401).json({ message: 'AUTH_EXPIRED' });
  }
  req.user = user;
  next();
}

async function attachUser(req, res, next) {
  const { user, db } = await getUser(req);
  req.user = user;
  req.db = db;
  next();
}

function createWatermarkSvg(text, width = 800) {
  const fontSize = Math.max(16, Math.round(width / 25));
  const padding = Math.round(fontSize * 0.6);
  return `\n    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${fontSize * 3}">\n      <style>\n        .watermark {\n          fill: rgba(255,255,255,0.7);\n          font-size: ${fontSize}px;\n          font-family: 'Helvetica Neue', Arial, sans-serif;\n          font-weight: 600;\n          paint-order: stroke;\n          stroke: rgba(0,0,0,0.35);\n          stroke-width: 2px;\n        }\n      </style>\n      <text x="${width - padding}" y="${fontSize + padding}" text-anchor="end" class="watermark">${text}</text>\n    </svg>\n  `;
}

async function processImage(buffer, options) {
  const { compressToWebp, webpQuality, watermarkText } = options;
  const base = sharp(buffer).rotate();
  const meta = await base.metadata();

  let pipeline = base;
  if (watermarkText) {
    const svg = createWatermarkSvg(watermarkText, meta.width || 800);
    pipeline = pipeline.composite([{ input: Buffer.from(svg), gravity: 'southeast' }]);
  }

  let outputMime = meta.format ? mime.lookup(meta.format) || 'application/octet-stream' : 'application/octet-stream';
  let ext = meta.format || 'png';
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

app.get('/api/user/status', attachUser, async (req, res) => {
  const user = req.user;
  const db = req.db;
  if (!user) {
    return res.json({ authenticated: false });
  }
  const { start, end } = getTodayRange();
  const todayUploads = db.images.filter((img) => img.userId === user.id && img.createdAt >= start && img.createdAt <= end).length;
  res.json({
    authenticated: true,
    id: user.id,
    username: user.username,
    level: user.level,
    dailyUploads: todayUploads,
    dailyUploadLimit: DAILY_UPLOAD_LIMIT,
    apiKey: user.apiKey
  });
});

app.post('/api/auth/login', rateLimit({ windowMs: 60000, max: 10 }), async (req, res) => {
  const username = (req.body.username || '').trim().slice(0, 30);
  const password = req.body.password || '';
  if (!username || !password) return res.status(400).json({ message: '用户名和密码不能为空' });
  const db = await loadDb();
  const user = db.users.find((u) => u.username === username);
  if (!user) return res.status(401).json({ message: '用户名或密码错误' });
  // 若旧用户没有密码，则用首次登录的密码初始化
  if (!user.passwordHash) {
    user.passwordHash = await bcrypt.hash(password, 10);
    await saveDb(db);
  } else {
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ message: '用户名或密码错误' });
  }
  req.session.userId = user.id;
  req.session.sessionVersion = user.sessionVersion || 1;
  const isDefault = user.username === 'admin' && password === 'admin';
  res.json({ message: '登录成功', user: { username: user.username, level: user.level }, defaultCreds: isDefault });
});

app.post('/api/auth/logout', async (req, res) => {
  req.session.destroy(() => {
    res.json({ message: '已注销' });
  });
});

app.post('/api/auth/register', async (req, res) => {
  const username = (req.body.username || '').trim().slice(0, 30);
  const password = req.body.password || '';
  if (!username || !password) return res.status(400).json({ message: '用户名和密码不能为空' });
  const db = await loadDb();
  const allow = db.settings?.branding?.registrationEnabled;
  if (!allow) return res.status(403).json({ message: '注册已关闭' });
  const exists = db.users.find((u) => u.username === username);
  if (exists) return res.status(400).json({ message: '用户名已存在' });
  try {
    const user = {
      id: nanoid(12),
      username,
      passwordHash: await bcrypt.hash(password, 10),
      apiKey: generateApiKey(),
      level: 1,
      sessionVersion: 1,
      createdAt: Date.now()
    };
    db.users.push(user);
    await saveDb(db);
    req.session.userId = user.id;
    req.session.sessionVersion = user.sessionVersion;
    res.json({ message: '注册成功', user: { username: user.username, level: user.level } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '注册失败，请稍后再试' });
  }
});

// 管理员用户管理
function requireAdmin(req, res, next) {
  if (req.user && (req.user.id === 'admin' || req.user.level >= 9)) return next();
  return res.status(403).json({ message: '仅管理员可操作' });
}

app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const db = await loadDb();
  res.json({
    users: db.users.map((u) => ({
      id: u.id,
      username: u.username,
      level: u.level || 1,
      createdAt: u.createdAt
    }))
  });
});

app.post('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const db = await loadDb();
  const target = db.users.find((u) => u.id === req.params.id);
  if (!target) return res.status(404).json({ message: '用户不存在' });
  const nextName = (req.body.username || '').trim();
  if (!nextName) return res.status(400).json({ message: '用户名不能为空' });
  const dup = db.users.find((u) => u.username === nextName && u.id !== target.id);
  if (dup) return res.status(400).json({ message: '用户名已存在' });
  let bumped = false;
  if (target.username !== nextName.slice(0, 30)) {
    target.username = nextName.slice(0, 30);
    bumped = true;
  }
  if (req.body.password) {
    target.passwordHash = await bcrypt.hash(req.body.password, 10);
    bumped = true;
  }
  if (bumped) {
    target.sessionVersion = (target.sessionVersion || 1) + 1;
  }
  await saveDb(db);
  res.json({ message: '已更新用户' });
});

app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = req.params.id;
  if (id === 'admin') return res.status(400).json({ message: '不可删除管理员' });
  const db = await loadDb();
  const targetUser = db.users.find((u) => u.id === id);
  if (!targetUser) return res.status(404).json({ message: '用户不存在' });

  // 删除该用户的图片及文件
  const keepImages = [];
  for (const img of db.images) {
    if (img.userId === id) {
      try {
        await fs.remove(path.join(uploadDir, img.filename));
        if (img.thumbName) await fs.remove(path.join(uploadDir, img.thumbName));
      } catch (err) {
        console.error('删除文件失败', err.message);
      }
    } else {
      keepImages.push(img);
    }
  }
  db.images = keepImages;
  db.users = db.users.filter((u) => u.id !== id);
  await saveDb(db);
  res.json({ message: '已删除用户' });
});

async function handleCredentialUpdate(req, res) {
  const { oldPassword, newPassword, newUsername } = req.body || {};
  const nextUsername = (newUsername || '').trim();
  if (!oldPassword || !newPassword || !nextUsername) {
    return res.status(400).json({ message: '缺少必填项' });
  }
  const db = req.db;
  const user = db.users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ message: '用户不存在' });
  const ok = user.passwordHash ? await bcrypt.compare(oldPassword, user.passwordHash) : false;
  if (!ok) return res.status(401).json({ message: '原密码错误' });
   // 用户名重名校验
  const dup = db.users.find((u) => u.username === nextUsername && u.id !== user.id);
  if (dup) return res.status(400).json({ message: '用户名已存在' });

  user.username = nextUsername.slice(0, 30);
  user.passwordHash = await bcrypt.hash(newPassword, 10);
  user.sessionVersion = (user.sessionVersion || 1) + 1;
  await saveDb(db);
  req.session.destroy(() => {});
  res.json({ message: '账号密码已更新，请重新登录', username: user.username });
}

app.post('/api/user/password', requireAuth, handleCredentialUpdate);
app.post('/api/user/credentials', requireAuth, handleCredentialUpdate);

app.get('/api/user/api-key', requireAuth, async (req, res) => {
  res.json({ apiKey: req.user.apiKey });
});

app.get('/api/settings/branding', async (req, res) => {
  const db = await loadDb();
  const branding = db.settings?.branding || {};
  res.json({
    name: branding.name || 'Nodeimage',
    subtitle: branding.subtitle || 'NodeSeek专用图床·克隆版',
    icon: branding.icon || '',
    registrationEnabled: !!branding.registrationEnabled
  });
});

app.post('/api/settings/branding', requireAuth, async (req, res) => {
  const db = await loadDb();
  // 仅 admin 允许修改图床设置
  if (!(req.user?.id === 'admin' || req.user?.level >= 9)) return res.status(403).json({ message: '仅管理员可修改设置' });
  db.settings = db.settings || {};
  db.settings.branding = {
    name: req.body.name || 'Nodeimage',
    subtitle: req.body.subtitle || 'NodeSeek专用图床·克隆版',
    icon: req.body.icon || '',
    registrationEnabled: parseBool(req.body.registrationEnabled, false)
  };
  await saveDb(db);
  res.json({ message: '已更新图床设置', branding: db.settings.branding });
});

app.post('/api/user/regenerate-api-key', requireAuth, async (req, res) => {
  const db = req.db;
  const user = db.users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ message: '用户不存在' });
  user.apiKey = generateApiKey();
  await saveDb(db);
  res.json({ apiKey: user.apiKey });
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

async function getBackupConfig() {
  const db = await getSqlite();
  const row = await db.get('SELECT value FROM settings WHERE key = ?', 'backup');
  const saved = row ? JSON.parse(row.value) : {};
  // 环境变量优先，数据库值作为默认
  return {
    intervalHours: parseInt(process.env.BACKUP_INTERVAL_HOURS) || saved.intervalHours || BACKUP_DEFAULTS.intervalHours,
    keepCount: parseInt(process.env.BACKUP_KEEP_COUNT) || saved.keepCount || BACKUP_DEFAULTS.keepCount,
    s3Endpoint: process.env.S3_ENDPOINT || saved.s3Endpoint || BACKUP_DEFAULTS.s3Endpoint,
    s3Region: process.env.S3_REGION || saved.s3Region || BACKUP_DEFAULTS.s3Region,
    s3Bucket: process.env.S3_BUCKET || saved.s3Bucket || BACKUP_DEFAULTS.s3Bucket,
    s3AccessKey: process.env.S3_ACCESS_KEY || saved.s3AccessKey || BACKUP_DEFAULTS.s3AccessKey,
    s3SecretKey: process.env.S3_SECRET_KEY || saved.s3SecretKey || BACKUP_DEFAULTS.s3SecretKey,
    webhookUrl: process.env.BACKUP_WEBHOOK_URL || saved.webhookUrl || BACKUP_DEFAULTS.webhookUrl
  };
}

app.get('/api/settings/backup', requireAuth, requireAdmin, async (req, res) => {
  const config = await getBackupConfig();
  // 密钥脱敏
  config.s3AccessKey = config.s3AccessKey ? '***' + config.s3AccessKey.slice(-4) : '';
  config.s3SecretKey = config.s3SecretKey ? '***' : '';
  res.json(config);
});

app.post('/api/settings/backup', requireAuth, requireAdmin, async (req, res) => {
  const db = await getSqlite();
  const current = await getBackupConfig();
  const updated = {
    intervalHours: Math.max(1, Math.min(720, Number(req.body.intervalHours) || current.intervalHours)),
    keepCount: Math.max(1, Math.min(365, Number(req.body.keepCount) || current.keepCount)),
    s3Endpoint: req.body.s3Endpoint !== undefined ? String(req.body.s3Endpoint).trim() : current.s3Endpoint,
    s3Region: req.body.s3Region !== undefined ? String(req.body.s3Region).trim() : current.s3Region,
    s3Bucket: req.body.s3Bucket !== undefined ? String(req.body.s3Bucket).trim() : current.s3Bucket,
    s3AccessKey: req.body.s3AccessKey !== undefined ? String(req.body.s3AccessKey).trim() : current.s3AccessKey,
    s3SecretKey: req.body.s3SecretKey !== undefined ? String(req.body.s3SecretKey).trim() : current.s3SecretKey,
    webhookUrl: req.body.webhookUrl !== undefined ? String(req.body.webhookUrl).trim() : current.webhookUrl
  };
  await db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', 'backup', JSON.stringify(updated));
  // 重置 S3 连接缓存
  s3Client = null;
  // 重置备份定时器
  clearBackupTimers();
  startBackupTimers(updated.intervalHours);
  // 脱敏返回
  const result = { ...updated };
  result.s3AccessKey = result.s3AccessKey ? '***' + result.s3AccessKey.slice(-4) : '';
  result.s3SecretKey = result.s3SecretKey ? '***' : '';
  res.json({ message: '备份设置已更新', config: result });
});

// 测试 S3 连接
app.post('/api/settings/backup/test-s3', requireAuth, requireAdmin, async (req, res) => {
  const config = await getBackupConfig();
  if (!config.s3Endpoint || !config.s3Bucket || !config.s3AccessKey || !config.s3SecretKey) {
    return res.status(400).json({ message: 'S3 配置不完整' });
  }
  try {
    const testClient = new S3Client({
      endpoint: config.s3Endpoint,
      region: config.s3Region,
      credentials: { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey },
      forcePathStyle: true
    });
    await testClient.send(new ListObjectsV2Command({ Bucket: config.s3Bucket, MaxKeys: 1 }));
    res.json({ message: 'S3 连接成功' });
  } catch (err) {
    res.status(400).json({ message: 'S3 连接失败', error: err.message });
  }
});

// 测试 Webhook
app.post('/api/settings/backup/test-webhook', requireAuth, requireAdmin, async (req, res) => {
  const config = await getBackupConfig();
  if (!config.webhookUrl) return res.status(400).json({ message: 'Webhook URL 未配置' });
  try {
    const res2 = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-Backup-Test': 'true' },
      body: 'nodeimage backup test ping'
    });
    if (!res2.ok) throw new Error(`HTTP ${res2.status}`);
    res.json({ message: 'Webhook 连接成功' });
  } catch (err) {
    res.status(400).json({ message: 'Webhook 连接失败', error: err.message });
  }
});

// 备份下载（打包 uploads 与数据库）
app.get('/api/backup', requireAuth, requireAdmin, async (req, res) => {
  try {
    const files = [];
    if (await fs.pathExists(dataFile)) files.push('data/db.sqlite');
    if (await fs.pathExists(uploadDir)) files.push('uploads');
    if (!files.length) return res.status(400).json({ message: '没有可备份的文件' });
    const ts = new Date();
    const stamp = `${ts.getFullYear()}${String(ts.getMonth() + 1).padStart(2, '0')}${String(ts.getDate()).padStart(2, '0')}-${ts.getTime()}`;
    const outPath = path.join(__dirname, 'data', `backup-${stamp}.tar.gz`);
    await fs.ensureDir(path.dirname(outPath));
    await new Promise((resolve, reject) => {
      const tar = spawn('tar', ['-czf', outPath, ...files], { cwd: __dirname });
      tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error('打包失败'))));
      tar.on('error', reject);
    });
    res.download(outPath, path.basename(outPath), (err) => {
      fs.remove(outPath).catch(() => {});
      if (err && !res.headersSent) res.status(500).end();
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '备份失败' });
  }
});

// 恢复备份
const restoreUpload = multer({ storage: multer.memoryStorage() });
app.post('/api/backup/restore', requireAuth, requireAdmin, restoreUpload.single('backup'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: '缺少备份文件' });
  const tmpPath = path.join(__dirname, 'data', `restore-${Date.now()}.tar.gz`);
  try {
    await fs.ensureDir(path.dirname(tmpPath));
    await fs.writeFile(tmpPath, req.file.buffer);
    // 关闭并清理现有数据库文件，避免锁住
    await resetSqlite();
    await Promise.all([
      fs.remove(dataFile).catch(() => {}),
      fs.remove(`${dataFile}-wal`).catch(() => {}),
      fs.remove(`${dataFile}-shm`).catch(() => {})
    ]);
    await new Promise((resolve, reject) => {
      const tar = spawn('tar', ['-xzf', tmpPath, '-C', __dirname], { cwd: __dirname });
      tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error('解压失败'))));
      tar.on('error', reject);
    });
    await resetSqlite();
    const restored = await loadDb();
    await reconcileImages(restored);
    res.json({ message: '备份已恢复' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '恢复失败', error: err.message });
  } finally {
    fs.remove(tmpPath).catch(() => {});
  }
});

app.get('/api/stats', async (req, res) => {
  const db = await loadDb();
  const total = db.images.length;
  const { start, end } = getTodayRange();
  const today = db.images.filter((img) => img.createdAt >= start && img.createdAt <= end).length;
  const totalSize = db.images.reduce((sum, img) => sum + (img.size || 0), 0);
  res.json({ total, today, totalSize });
});

app.post('/api/upload', requireAuth, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: '缺少图片文件' });
    }
    if (!allowedMime.has(req.file.mimetype)) {
      return res.status(400).json({ message: '不支持的文件类型' });
    }

    const compressToWebp = String(req.body.compressToWebp ?? 'true') !== 'false';
    const webpQuality = Math.min(100, Math.max(10, Number(req.body.webpQuality) || 90));
    const autoWatermark = String(req.body.autoWatermark ?? 'false') === 'true';
    const watermarkContent = (req.body.watermarkContent || '').trim();
    const autoDelete = String(req.body.autoDelete ?? 'false') === 'true';
    const deleteDays = Math.min(365, Math.max(1, Number(req.body.deleteDays) || 30));

    const { start, end } = getTodayRange();
    const todayUploads = req.db.images.filter((img) => img.userId === req.user.id && img.createdAt >= start && img.createdAt <= end).length;
    if (todayUploads >= DAILY_UPLOAD_LIMIT) {
      return res.status(429).json({ message: '已达到今日上传上限' });
    }

    const watermarkText = autoWatermark ? (watermarkContent || 'nodeimage.com clone') : '';

    const { processed, thumbBuffer } = await enqueueUpload(async () => {
      const p = await processImage(req.file.buffer, {
        compressToWebp,
        webpQuality,
        watermarkText
      });
      const tb = await sharp(p.buffer)
        .resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      return { processed: p, thumbBuffer: tb };
    });

    const now = new Date();
    const year = String(now.getFullYear());
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const dir = path.join(uploadDir, year, month);
    await fs.ensureDir(dir);

    const id = nanoid(12);
    const filenameOnly = `${id}.${processed.ext}`;
    const filename = `${year}/${month}/${filenameOnly}`;
    const filePath = path.join(uploadDir, filename);
    await fs.writeFile(filePath, processed.buffer);

    const thumbNameOnly = `${id}_thumb.webp`;
    const thumbName = `thumbs/${year}/${month}/${thumbNameOnly}`;
    const thumbPath = path.join(uploadDir, thumbName);
    await fs.ensureDir(path.dirname(thumbPath));
    await fs.writeFile(thumbPath, thumbBuffer);

    const baseUrl = getBaseUrl(req);
    const fileUrl = `${baseUrl}/uploads/${filename}`;
    const thumbUrl = `${baseUrl}/uploads/${thumbName}`;

    const record = {
      id,
      userId: req.user.id,
      filename,
      thumbName,
      mime: processed.mime,
      size: processed.size,
      width: processed.width,
      height: processed.height,
      createdAt: Date.now(),
      autoDelete,
      deleteAfterDays: autoDelete ? deleteDays : null
    };
    req.db.images.unshift(record);
    await saveDb(req.db);

    res.json({
      id,
      url: fileUrl,
      thumbUrl,
      size: processed.size,
      width: processed.width,
      height: processed.height,
      format: processed.ext,
      markdown: `![image](${fileUrl})`,
      html: `<img src="${fileUrl}" alt="image" />`,
      bbcode: `[img]${fileUrl}[/img]`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: '上传失败', error: err?.message });
  }
});

app.get('/api/images', requireAuth, async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 20));
  const start = (page - 1) * limit;
  const end = start + limit;
  const items = req.db.images.filter((img) => img.userId === req.user.id);
  const slice = items.slice(start, end).map((img) => ({
    ...img,
    url: `${getBaseUrl(req)}/uploads/${img.filename}`,
    thumbUrl: `${getBaseUrl(req)}/uploads/${img.thumbName || img.filename}`
  }));
  const totalPages = Math.max(1, Math.ceil(items.length / limit));
  res.json({
    items: slice,
    total: items.length,
    totalPages,
    currentPage: page
  });
});

app.post('/api/images/delete', requireAuth, async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ message: '缺少要删除的ID' });

  const remaining = [];
  for (const img of req.db.images) {
    if (img.userId === req.user.id && ids.includes(img.id)) {
      try {
        await fs.remove(path.join(uploadDir, img.filename));
        if (img.thumbName) await fs.remove(path.join(uploadDir, img.thumbName));
      } catch (err) {
        console.error('删除文件失败', err.message);
      }
    } else {
      remaining.push(img);
    }
  }
  req.db.images = remaining;
  await saveDb(req.db);
  res.json({ message: '删除完成' });
});

app.get('/api/v1/list', requireAuth, async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const userImages = req.db.images.filter((img) => img.userId === req.user.id);
  const total = userImages.length;
  const totalPages = Math.ceil(total / limit);
  const start = (page - 1) * limit;
  const items = userImages.slice(start, start + limit).map((img) => ({
    id: img.id,
    url: `${getBaseUrl(req)}/uploads/${img.filename}`,
    thumbUrl: `${getBaseUrl(req)}/uploads/${img.thumbName || img.filename}`,
    size: img.size,
    width: img.width,
    height: img.height,
    createdAt: img.createdAt
  }));
  res.json({ items, total, totalPages, currentPage: page });
});

app.delete('/api/v1/delete/:id', requireAuth, async (req, res) => {
  const targetId = req.params.id;
  const remaining = [];
  let removed = false;
  for (const img of req.db.images) {
    if (img.userId === req.user.id && img.id === targetId) {
      try {
      await fs.remove(path.join(uploadDir, img.filename));
      if (img.thumbName) await fs.remove(path.join(uploadDir, img.thumbName));
      } catch (err) {
        console.error('删除文件失败', err.message);
      }
      removed = true;
    } else {
      remaining.push(img);
    }
  }
  if (!removed) return res.status(404).json({ message: '未找到图片' });
  req.db.images = remaining;
  await saveDb(req.db);
  res.json({ message: '删除成功' });
});

// --- 备份 API ---
app.post('/api/backup/auto', requireAuth, requireAdmin, async (req, res) => {
  try {
    await runAutoBackup();
    res.json({ message: '备份完成' });
  } catch (err) {
    res.status(500).json({ message: '备份失败', error: err.message });
  }
});

app.get('/api/backup/status', requireAuth, requireAdmin, async (req, res) => {
  const config = await getBackupConfig();
  res.json({
    s3: { configured: !!(config.s3Endpoint && config.s3Bucket && config.s3AccessKey && config.s3SecretKey), endpoint: config.s3Endpoint || null, bucket: config.s3Bucket || null },
    webhook: { configured: !!config.webhookUrl, url: config.webhookUrl || null },
    intervalHours: config.intervalHours,
    keepCount: config.keepCount
  });
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- 自动删除过期图片 ---
async function cleanupExpiredImages() {
  try {
    const db = await getSqlite();
    const now = Date.now();
    const rows = await db.all('SELECT * FROM images WHERE autoDelete = 1 AND deleteAfterDays IS NOT NULL');
    let removed = 0;
    for (const img of rows) {
      const expiresAt = img.createdAt + img.deleteAfterDays * 86400000;
      if (now >= expiresAt) {
        try {
          await fs.remove(path.join(uploadDir, img.filename)).catch(() => {});
          if (img.thumbName) await fs.remove(path.join(uploadDir, img.thumbName)).catch(() => {});
        } catch (e) { /* ignore */ }
        await db.run('DELETE FROM images WHERE id = ?', img.id);
        removed++;
      }
    }
    if (removed > 0) console.log(`Auto-delete: removed ${removed} expired image(s)`);
  } catch (err) {
    console.error('Auto-delete cleanup error:', err);
  }
}
setInterval(cleanupExpiredImages, 3600000);

// --- 自动备份：S3 与 Webhook ---
function backupStamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}-${d.getTime()}`;
}

function backupArchivePath(stamp) {
  return path.join(__dirname, 'data', `backup-${stamp}.tar.gz`);
}

async function createBackupArchive(stamp) {
  const outPath = backupArchivePath(stamp);
  await fs.ensureDir(path.dirname(outPath));
  const files = [];
  if (await fs.pathExists(dataFile)) files.push(path.relative(__dirname, dataFile));
  if (await fs.pathExists(uploadDir)) files.push(path.relative(__dirname, uploadDir));
  if (!files.length) throw new Error('没有可备份的文件');
  await new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-czf', outPath, ...files], { cwd: __dirname });
    tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error('打包失败'))));
    tar.on('error', reject);
  });
  return outPath;
}

async function uploadBackupToS3(filePath, stamp) {
  const client = await getS3Client();
  if (!client) return { type: 's3', skipped: true, reason: 'S3 未配置' };
  const config = await getBackupConfig();
  const stream = await fs.createReadStream(filePath);
  const upload = new Upload({
    client,
    params: {
      Bucket: config.s3Bucket,
      Key: `nodeimage/backup-${stamp}.tar.gz`,
      Body: stream,
      ContentType: 'application/gzip'
    }
  });
  await upload.done();
  return { type: 's3', success: true };
}

async function uploadBackupToWebhook(filePath, stamp) {
  const config = await getBackupConfig();
  if (!config.webhookUrl) return { type: 'webhook', skipped: true, reason: 'Webhook 未配置' };
  const content = await fs.readFile(filePath);
  const res = await fetch(config.webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/gzip',
      'X-Backup-Filename': `nodeimage-backup-${stamp}.tar.gz`,
      'X-Backup-Timestamp': stamp
    },
    body: content
  });
  if (!res.ok) throw new Error(`Webhook 返回 ${res.status}`);
  return { type: 'webhook', success: true };
}

async function rotateS3Backups() {
  const client = await getS3Client();
  if (!client) return;
  const config = await getBackupConfig();
  try {
    const list = await client.send(new ListObjectsV2Command({
      Bucket: config.s3Bucket,
      Prefix: 'nodeimage/backup-'
    }));
    const items = (list.Contents || []).sort((a, b) => (b.LastModified || 0) - (a.LastModified || 0));
    if (items.length <= config.keepCount) return;
    for (const item of items.slice(config.keepCount)) {
      await client.send(new DeleteObjectCommand({ Bucket: config.s3Bucket, Key: item.Key }));
      console.log(`S3 backup deleted: ${item.Key}`);
    }
  } catch (err) {
    console.error('S3 rotate error:', err.message);
  }
}

async function runAutoBackup() {
  console.log('Auto-backup starting...');
  const stamp = backupStamp();
  let filePath;
  try {
    filePath = await createBackupArchive(stamp);
    const [s3Result, webhookResult] = await Promise.allSettled([
      uploadBackupToS3(filePath, stamp),
      uploadBackupToWebhook(filePath, stamp)
    ]);
    if (s3Result.status === 'fulfilled') console.log('Backup S3:', JSON.stringify(s3Result.value));
    else console.error('Backup S3 failed:', s3Result.reason?.message);
    if (webhookResult.status === 'fulfilled') console.log('Backup Webhook:', JSON.stringify(webhookResult.value));
    else console.error('Backup Webhook failed:', webhookResult.reason?.message);
    await rotateS3Backups();
  } catch (err) {
    console.error('Auto-backup failed:', err.message);
  }
  // 本地轮转：保留最近 N 个备份
  try {
    const config = await getBackupConfig();
    const dir = path.join(__dirname, 'data');
    const files = (await fs.readdir(dir))
      .filter((f) => f.startsWith('backup-') && f.endsWith('.tar.gz'))
      .map((f) => ({ name: f, path: path.join(dir, f) }));
    files.sort((a, b) => b.name.localeCompare(a.name));
    for (const f of files.slice(config.keepCount)) {
      await fs.remove(f.path);
      console.log(`Local backup deleted: ${f.name}`);
    }
  } catch (err) {
    console.error('Local backup rotate error:', err.message);
  }
}

// 定时自动备份
(async () => {
  const config = await getBackupConfig();
  startBackupTimers(config.intervalHours);
})();

app.listen(PORT, () => {
  console.log(`Nodeimage clone running at http://localhost:${PORT}`);
});
