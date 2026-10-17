import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import sharp from 'sharp';

export const repo = path.dirname(path.dirname(new URL(import.meta.url).pathname));
export async function waitFor(fn, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (e) { last = e; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw last || new Error('Condition timed out');
}
export async function fixture(t, { root, beforeStart } = {}) {
  root ||= await fs.mkdtemp(path.join(os.tmpdir(), 'nodeimage-test-'));
  await beforeStart?.(root);
  const child = spawn(process.execPath, ['server.js'], { cwd: repo,
    env: { ...process.env, STORAGE_ROOT: root, HOST: '127.0.0.1', PORT: '0', SESSION_SECRET: 'test-only-isolated-secret', S3_ENDPOINT: '', S3_BUCKET: '', S3_ACCESS_KEY: '', S3_SECRET_KEY: '', BACKUP_WEBHOOK_URL: '', NODE_ENV: 'test', BASE_URL: '', BACKUP_INTERVAL_HOURS: '', BACKUP_KEEP_COUNT: '' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  let db;
  const stop = async () => {
    if (db) { await db.close(); db = null; }
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  };
  t.after(async () => { await stop(); await fs.remove(root); });
  const address = await waitFor(() => {
    if (child.exitCode !== null) throw new Error(output);
    return output.match(/http:\/\/localhost:(\d+)/)?.[1];
  });
  db = await open({ filename: path.join(root, 'data/db.sqlite'), driver: sqlite3.Database });
  await db.exec('PRAGMA busy_timeout=5000');
  const url = `http://127.0.0.1:${address}`;
  async function request(endpoint, { method = 'GET', body, cookie, key, headers = {} } = {}) {
    if (cookie) headers.Cookie = cookie;
    if (key) headers['x-api-key'] = key;
    if (body !== undefined && !(body instanceof FormData) && typeof body !== 'string') { body = JSON.stringify(body); headers['content-type'] = 'application/json'; }
    const response = await fetch(url + endpoint, { method, headers, body });
    const type = response.headers.get('content-type') || '';
    const data = type.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const login = async (username = 'admin', password = 'admin') => {
    const result = await request('/api/auth/login', { method: 'POST', body: { username, password } });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.cookie;
  };
  const admin = await login();
  const { data: { apiKey: key } } = await request('/api/user/api-key', { cookie: admin });
  const png = await sharp({ create: { width: 16, height: 12, channels: 3, background: 'red' } }).png().toBuffer();
  const form = (buffer = png, field = 'image', name = 'test.png', type = 'image/png') => {
    const data = new FormData(); data.append(field, new Blob([buffer], { type }), name); return data;
  };
  const upload = (auth = { key }, buffer = png) => request('/api/upload', { method: 'POST', ...auth, body: form(buffer) });
  const incoming = async () => fs.readdir(path.join(root, 'data/.incoming'));
  const closeDb = async () => { if (db) { await db.close(); db = null; } };
  return { root, child, db, closeDb, url, request, login, admin, key, png, form, upload, incoming, stop, output: () => output };
}
export async function slowUpload(f, auth = { key: f.key }) {
  const boundary = 'nodeimage-test-boundary';
  let complete;
  const result = new Promise((resolve, reject) => { complete = { resolve, reject }; });
  const req = http.request(f.url + '/api/upload', { method: 'POST', headers: {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    ...(auth.key ? { 'x-api-key': auth.key } : { Cookie: auth.cookie })
  } }, res => {
    let raw = ''; res.on('data', x => { raw += x; });
    res.on('end', () => { try { complete.resolve({ status: res.statusCode, data: JSON.parse(raw) }); } catch (e) { complete.reject(e); } });
  });
  req.on('error', complete.reject);
  result.catch(() => {});
  req.write(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="slow.png"\r\nContent-Type: image/png\r\n\r\n`);
  req.write(f.png.subarray(0, 20));
  return { req, result, finish: () => { req.end(Buffer.concat([f.png.subarray(20), Buffer.from(`\r\n--${boundary}--\r\n`)])); return result; } };
}
