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

const __dirname = process.cwd();
const app = express();

const PORT = process.env.PORT || 7878;
const CONFIG_BASE_URL = process.env.BASE_URL ? process.env.BASE_URL.replace(/\/$/, '') : '';
const uploadDir = path.join(__dirname, 'uploads');
const thumbDir = path.join(uploadDir, 'thumbs');
const dataFile = path.join(__dirname, 'data', 'db.json');
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const DAILY_UPLOAD_LIMIT = 200;

function parseBool(val, defaultVal = true) {
  if (val === undefined || val === null) return defaultVal;
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') return val.toLowerCase() === 'true';
  return Boolean(val);
}

function ensureDefaultUser(db) {
  const hasUsers = Array.isArray(db.users) && db.users.length > 0;
  const existingAdmin = hasUsers ? db.users.find((u) => u.id === 'admin') : null;
  if (!hasUsers || !existingAdmin) {
    const passwordHash = bcrypt.hashSync('admin', 10);
    const admin = {
      id: 'admin',
      username: 'admin',
      passwordHash,
      apiKey: generateApiKey(),
      level: 1,
      createdAt: Date.now()
    };
    db.users = [admin];
    if (Array.isArray(db.images)) {
      db.images = db.images.map((img) => ({ ...img, userId: admin.id }));
    }
  }
}

await fs.ensureDir(uploadDir);
await fs.ensureDir(thumbDir);
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
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
  })
);

app.use('/uploads', express.static(uploadDir));
app.use(express.static(path.join(__dirname, 'public')));

const allowedMime = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/avif'
]);

async function loadDb() {
  if (!(await fs.pathExists(dataFile))) {
    const initial = {
      users: [],
      images: [],
      settings: {
        branding: {
          name: 'Nodeimage',
          subtitle: 'NodeSeek专用图床·克隆版',
          icon: '',
          footer: 'Nodeimage 克隆版 · 本地演示'
        }
      }
    };
    ensureDefaultUser(initial);
    await fs.writeJSON(dataFile, initial, { spaces: 2 });
    return initial;
  }
  const db = await fs.readJSON(dataFile);
  ensureDefaultUser(db);
  await saveDb(db);
  return db;
}

async function saveDb(db) {
  await fs.writeJSON(dataFile, db, { spaces: 2 });
}

function getBaseUrl(req) {
  if (CONFIG_BASE_URL) return CONFIG_BASE_URL;
  const xfProto = req.get('x-forwarded-proto');
  const protocol = (xfProto || req.protocol || 'http').split(',')[0].trim();
  const host = req.get('x-forwarded-host') || req.get('host');
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
  req.user = user;
  next();
}

async function attachUser(req, res, next) {
  const { user, db } = await getUser(req);
  req.user = user;
  req.db = db;
  next();
}

function ensureUserRecord(db, username) {
  let user = db.users.find((u) => u.username === username);
  if (!user) {
    user = {
      id: nanoid(12),
      username,
      apiKey: generateApiKey(),
      level: 1,
      createdAt: Date.now(),
      passwordHash: null
    };
    db.users.push(user);
  }
  return user;
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
    username: user.username,
    level: user.level,
    dailyUploads: todayUploads,
    dailyUploadLimit: DAILY_UPLOAD_LIMIT,
    apiKey: user.apiKey
  });
});

app.post('/api/auth/login', async (req, res) => {
  const username = (req.body.username || '').trim().slice(0, 30);
  const password = req.body.password || '';
  if (!username || !password) return res.status(400).json({ message: '用户名和密码不能为空' });
  const db = await loadDb();
  const user = db.users.find((u) => u.username === username);
  if (!user) return res.status(401).json({ message: '用户不存在' });
  // 若旧用户没有密码，则用首次登录的密码初始化
  if (!user.passwordHash) {
    user.passwordHash = await bcrypt.hash(password, 10);
    await saveDb(db);
  } else {
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ message: '密码错误' });
  }
  req.session.userId = user.id;
  const isDefault = user.username === 'admin' && password === 'admin';
  res.json({ message: '登录成功', user: { username: user.username, level: user.level }, defaultCreds: isDefault });
});

app.post('/api/auth/logout', async (req, res) => {
  req.session.destroy(() => {
    res.json({ message: '已注销' });
  });
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

  user.username = nextUsername.slice(0, 30);
  user.passwordHash = await bcrypt.hash(newPassword, 10);
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
    footer: branding.footer || 'Nodeimage 克隆版 · 本地演示'
  });
});

app.post('/api/settings/branding', requireAuth, async (req, res) => {
  const db = await loadDb();
  db.settings = db.settings || {};
  db.settings.branding = {
    name: req.body.name || 'Nodeimage',
    subtitle: req.body.subtitle || 'NodeSeek专用图床·克隆版',
    icon: req.body.icon || '',
    footer: req.body.footer || 'Nodeimage 克隆版 · 本地演示'
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

    const processed = await processImage(req.file.buffer, {
      compressToWebp,
      webpQuality,
      watermarkText
    });

    const id = nanoid(12);
    const filename = `${id}.${processed.ext}`;
    const filePath = path.join(uploadDir, filename);
    await fs.writeFile(filePath, processed.buffer);

    const thumbBuffer = await sharp(processed.buffer)
      .resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    const thumbName = `${id}_thumb.webp`;
    await fs.writeFile(path.join(thumbDir, thumbName), thumbBuffer);

    const baseUrl = getBaseUrl(req);
    const fileUrl = `${baseUrl}/uploads/${filename}`;
    const thumbUrl = `${baseUrl}/uploads/thumbs/${thumbName}`;

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
    thumbUrl: `${getBaseUrl(req)}/uploads/thumbs/${img.thumbName}`
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
      await fs.remove(path.join(uploadDir, img.filename));
      if (img.thumbName) await fs.remove(path.join(thumbDir, img.thumbName));
    } else {
      remaining.push(img);
    }
  }
  req.db.images = remaining;
  await saveDb(req.db);
  res.json({ message: '删除完成' });
});

app.get('/api/v1/list', requireAuth, async (req, res) => {
  const items = req.db.images.filter((img) => img.userId === req.user.id).map((img) => ({
    id: img.id,
    url: `${getBaseUrl(req)}/uploads/${img.filename}`,
    thumbUrl: `${getBaseUrl(req)}/uploads/thumbs/${img.thumbName}`,
    size: img.size,
    width: img.width,
    height: img.height,
    createdAt: img.createdAt
  }));
  res.json({ items });
});

app.delete('/api/v1/delete/:id', requireAuth, async (req, res) => {
  const targetId = req.params.id;
  const remaining = [];
  let removed = false;
  for (const img of req.db.images) {
    if (img.userId === req.user.id && img.id === targetId) {
      await fs.remove(path.join(uploadDir, img.filename));
      if (img.thumbName) await fs.remove(path.join(thumbDir, img.thumbName));
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

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Nodeimage clone running at http://localhost:${PORT}`);
});
