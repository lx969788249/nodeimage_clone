import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { deliverBackup } from '../backup-delivery.js';
import { fixture } from './helpers.js';

async function listener(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function input(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nodeimage-delivery-'));
  t.after(() => fs.remove(dir));
  const file = path.join(dir, 'backup.tar.gz'); await fs.writeFile(file, gzipSync('isolated backup payload'));
  return file;
}

test('local S3 mock and webhook receive streamed archive, S3 retention follows all pages', async t => {
  const operations = []; let webhookBody;
  const endpoint = await listener(t, async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const chunks = []; for await (const part of req) chunks.push(part);
    operations.push({ method: req.method, path: url.pathname, token: url.searchParams.get('continuation-token'), bytes: Buffer.concat(chunks).length });
    if (req.method === 'PUT') { res.setHeader('ETag', '"test-etag"'); res.end(); return; }
    if (req.method === 'DELETE') { res.statusCode = 204; res.end(); return; }
    const next = url.searchParams.has('continuation-token');
    const contents = next ? [['nodeimage/backup-new.tar.gz', '2026-10-18T00:00:00Z'], ['nodeimage/backup-old-2.tar.gz', '2020-01-01T00:00:00Z']] : [['nodeimage/backup-old-1.tar.gz', '2019-01-01T00:00:00Z']];
    res.setHeader('Content-Type', 'application/xml');
    res.end(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>${!next}</IsTruncated>${!next ? '<NextContinuationToken>page-2</NextContinuationToken>' : ''}${contents.map(([key, date]) => `<Contents><Key>${key}</Key><LastModified>${date}</LastModified><Size>1</Size></Contents>`).join('')}</ListBucketResult>`);
  });
  const webhookUrl = await listener(t, async (req, res) => { const chunks = []; for await (const part of req) chunks.push(part); webhookBody = Buffer.concat(chunks); res.end('ok'); });
  const results = await deliverBackup(await input(t), 'test-stamp', { s3Endpoint: endpoint, s3Region: 'auto', s3Bucket: 'isolated-test', s3AccessKey: 'test-access', s3SecretKey: 'test-secret', keepCount: 1, webhookUrl });
  assert.ok(results.every(item => item.success), JSON.stringify(results));
  assert.equal(gunzipSync(webhookBody).toString(), 'isolated backup payload');
  assert.equal(operations.filter(item => item.method === 'PUT').length, 1);
  assert.ok(operations.some(item => item.token === 'page-2'));
  assert.deepEqual(operations.filter(item => item.method === 'DELETE').map(item => item.path.split('/').at(-1)).sort(), ['backup-old-1.tar.gz', 'backup-old-2.tar.gz']);
});

test('webhook failures and timeout are reported; no configured targets are explicitly skipped', async t => {
  const file = await input(t);
  const broken = await listener(t, (req, res) => { req.resume(); res.statusCode = 503; res.end('failed'); });
  const failure = await deliverBackup(file, 'stamp', { webhookUrl: broken }, { timeoutMs: 1000 });
  assert.equal(failure[1].success, false); assert.match(failure[1].error, /503/);
  const stalled = await listener(t, req => req.resume());
  const timeout = await deliverBackup(file, 'stamp', { webhookUrl: stalled }, { timeoutMs: 100 });
  assert.equal(timeout[1].success, false);
  assert.ok((await deliverBackup(file, 'stamp', {})).every(item => item.skipped));
});

test('API preserves masked credentials, distinguishes remote failure, and validates schedule', async t => {
  const f = await fixture(t);
  const failedUrl = await listener(t, (req, res) => { req.resume(); res.statusCode = 500; res.end(); });
  assert.equal((await f.request('/api/settings/backup', { method: 'POST', key: f.key, body: { s3AccessKey: 'local-dummy-key', s3SecretKey: 'local-dummy-secret', webhookUrl: failedUrl } })).status, 200);
  const masked = await f.request('/api/settings/backup', { key: f.key });
  assert.equal((await f.request('/api/settings/backup', { method: 'POST', key: f.key, body: { s3AccessKey: masked.data.s3AccessKey, s3SecretKey: '', intervalHours: 720 } })).status, 200);
  const saved = JSON.parse((await f.db.get("SELECT value FROM settings WHERE key='backup'")).value);
  assert.equal(saved.s3AccessKey, 'local-dummy-key'); assert.equal(saved.s3SecretKey, 'local-dummy-secret');
  const result = await f.request('/api/backup/auto', { method: 'POST', key: f.key });
  assert.equal(result.status, 502); assert.equal(result.data.success, false); assert.equal(result.data.results[1].success, false);
  for (const body of [{ intervalHours: -1 }, { intervalHours: Infinity }, { keepCount: 1.5 }, { keepCount: {} }]) assert.equal((await f.request('/api/settings/backup', { method: 'POST', key: f.key, body })).status, 400);
});
