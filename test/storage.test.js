import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fixture, slowUpload, waitFor, repo } from './helpers.js';
import { acquireStorageLocks } from '../storage.js';

async function rejectedProcess(root, env = {}) {
  const child = spawn(process.execPath, ['server.js'], { cwd: repo,
    env: { ...process.env, STORAGE_ROOT: root, PORT: '0', HOST: '127.0.0.1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  const [code, signal] = await once(child, 'exit'); clearTimeout(timer);
  assert.equal(signal, null, output);
  assert.notEqual(code, 0, output);
  return output;
}

test('second process is rejected before touching an active upload; SIGKILL releases both locks', async t => {
  const f = await fixture(t);
  const slow = await slowUpload(f);
  await waitFor(async () => (await f.incoming()).length === 1);
  const before = await f.incoming();
  const output = await rejectedProcess(f.root);
  assert.match(output, /STORAGE_IN_USE/);
  assert.doesNotMatch(output, /running at/);
  assert.deepEqual(await f.incoming(), before);
  assert.equal((await slow.finish()).status, 200);
  f.child.kill('SIGKILL'); await once(f.child, 'exit'); await f.closeDb();
  const restarted = await fixture(t, { root: f.root });
  assert.equal((await restarted.request('/api/stats')).data.total, 1);
});

test('shared upload storage is locked even when another instance uses a different data directory', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nodeimage-lock-test-'));
  t.after(() => fs.remove(root));
  const first = await acquireStorageLocks([path.join(root, 'data-a'), path.join(root, 'uploads')]);
  try {
    await assert.rejects(acquireStorageLocks([path.join(root, 'data-b'), path.join(root, 'uploads')]), /STORAGE_IN_USE/);
  } finally { await first(); }
  const next = await acquireStorageLocks([path.join(root, 'data-b'), path.join(root, 'uploads')]);
  await next();
});

test('default accepts exactly 100 MiB and rejects 100 MiB + 1 byte before processing', async t => {
  const f = await fixture(t, { env: { UPLOAD_MAX_FILE_MIB: '' } });
  const paddedImage = Buffer.alloc(100 * 1024 ** 2); f.png.copy(paddedImage);
  assert.equal((await f.upload({ key: f.key }, paddedImage)).status, 200);
  await waitFor(async () => (await f.incoming()).length === 0);
  assert.equal((await f.upload({ key: f.key }, Buffer.alloc(100 * 1024 ** 2 + 1))).status, 413);
  await waitFor(async () => (await f.incoming()).length === 0);
  assert.equal((await f.request('/api/settings/branding')).data.uploadMaxFileBytes, 104857600);
});

test('invalid upload limit fails before any storage cleanup', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nodeimage-limit-test-'));
  t.after(() => fs.remove(root));
  await fs.ensureDir(path.join(root, 'data/.incoming'));
  const sentinel = path.join(root, 'data/.incoming/sentinel'); await fs.writeFile(sentinel, 'unchanged');
  for (const value of ['0', '101', '1.5', 'NaN']) {
    assert.match(await rejectedProcess(root, { UPLOAD_MAX_FILE_MIB: value }), /UPLOAD_MAX_FILE_MIB/);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'unchanged');
  }
});

test('an active static image stream is drained before backup maintenance starts', async t => {
  const http = await import('node:http');
  const f = await fixture(t);
  const size = 16 * 1024 ** 2;
  await fs.writeFile(path.join(f.root, 'uploads/stream.bin'), Buffer.alloc(size, 1));
  const response = await new Promise((resolve, reject) => {
    const req = http.get(f.url + '/uploads/stream.bin', resolve); req.on('error', reject);
  });
  response.pause();
  const pending = f.request('/api/backup', { key: f.key });
  await waitFor(async () => (await f.request('/api/stats')).status === 503);
  let bytes = 0;
  const ended = new Promise((resolve, reject) => { response.on('data', chunk => { bytes += chunk.length; }); response.on('end', resolve); response.on('error', reject); });
  response.resume(); await ended;
  assert.equal(bytes, size);
  assert.equal((await pending).status, 200);
});

test('forged forwarded addresses do not reset failed-account protection with TRUST_PROXY=false', async t => {
  const f = await fixture(t, { env: { TRUST_PROXY: 'false' } });
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    const result = await f.request('/api/auth/login', { method: 'POST', headers: { 'x-forwarded-for': `198.51.100.${i + 1}` }, body: { username: 'absent', password: 'wrong' } });
    statuses.push(result.status);
  }
  assert.ok(statuses.includes(429));
});
