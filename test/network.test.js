import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import bcrypt from 'bcryptjs';
import { baseUrl, proxySetting, requestContext } from '../network.js';
import { LoginGuard } from '../safety.js';
import { fixture } from './helpers.js';

function context(headers, { setting, encrypted = false, peer = '192.0.2.1', configuredBase = '' } = {}) {
  const proxy = proxySetting(setting);
  const app = express(); app.set('trust proxy', proxy.trust);
  const req = { headers: { host: 'images.example:7878', ...headers }, socket: { remoteAddress: peer, encrypted } };
  let error;
  requestContext({ compatibility: proxy.compatibility, trustPeer: app.get('trust proxy fn'), configuredBase })(req, {}, err => { error = err; });
  if (error) throw error;
  return req;
}

test('default direct/proxy protocol uses single hints without trusting IP or forwarded destinations', () => {
  assert.deepEqual(proxySetting(), { compatibility: true, trust: false });
  assert.equal(context({}).publicContext.baseUrl, 'http://images.example:7878');
  const req = context({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'attacker.example', origin: 'https://attacker.example', referer: 'https://attacker.example' });
  assert.equal(req.publicContext.baseUrl, 'https://images.example:7878');
  for (const hint of ['https,http', 'https, https', 'HTTPS', 'javascript', 'ftp', ' https']) {
    const req = context({ 'x-forwarded-proto': hint, 'x-forwarded-scheme': 'https', 'front-end-https': 'on', origin: 'https://evil.example' });
    assert.equal(req.publicContext.protocol, 'http');
    assert.equal(req.headers['x-forwarded-proto'], 'http');
  }
  assert.equal(context({ 'x-forwarded-proto': 'http' }, { encrypted: true }).publicContext.protocol, 'https');
});

test('explicit proxy boundaries honor only trusted peers and support hop counts', () => {
  for (const setting of ['false', '0', '198.51.100.0/24']) {
    const req = context({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'proxy.example' }, { setting });
    assert.equal(req.publicContext.baseUrl, 'http://images.example:7878');
    assert.equal(req.headers['x-forwarded-proto'], 'http');
  }
  for (const setting of ['true', '1', '192.0.2.0/24']) {
    assert.equal(context({ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'proxy.example' }, { setting }).publicContext.baseUrl, 'https://proxy.example');
  }
  assert.throws(() => proxySetting('-1'));
  assert.throws(() => proxySetting('NaN'));
  assert.throws(() => { const app = express(); app.set('trust proxy', proxySetting('invalid-network').trust); });
});

test('base URLs and Host authorities reject injection, preserving configured path prefixes', () => {
  assert.equal(baseUrl('https://Images.Example/prefix/'), 'https://images.example/prefix');
  for (const url of ['file:///tmp/test', 'https://@host/', 'https://a:b@host/', 'https://host/?', 'https://host/#', 'https://host/\\evil', 'https://host/\nfoo', 'https:///example.com', 'https://evil".com', 'https://evil`host']) assert.throws(() => baseUrl(url));
  for (const host of ['evil/abc', 'evil@host', 'evil,host', 'evil?x', 'evil#x', 'evil%0d', 'evil\\host', 'host:999999', 'host\t', 'evil".com', "evil'host", 'evil`host', 'host\0']) assert.throws(() => context({ host }), /INVALID_HOST/);
  assert.equal(context({ host: '[::1]:7878' }).publicContext.baseUrl, 'http://[::1]:7878');
  assert.equal(context({ 'x-forwarded-host': 'evil.example' }, { configuredBase: baseUrl('https://canonical.example/app/') }).publicContext.baseUrl, 'https://canonical.example/app');
});

test('failed-login state, timers and concurrency are bounded; success clears only its account', () => {
  let now = 100;
  const guard = new LoginGuard({ limit: 2, capacity: 4, now: () => now });
  const a = guard.enter(), b = guard.enter();
  assert.throws(() => guard.enter(), /AUTH_BUSY/);
  a(); a(); b(); assert.equal(guard.active, 0);
  for (let i = 0; i < 2000; i++) guard.failed(`user${i}`);
  assert.equal(guard.failures.size, 4); assert.equal(guard.global.count, 1000);
  const failure = guard.failed('victim');
  assert.equal(failure.status, 429); assert.equal(failure.delayMs, 2000);
  guard.succeeded('victim'); assert.equal(guard.failures.has('victim'), false); assert.equal(guard.global.count, 1000);
  now += 60000;
  assert.deepEqual(guard.failed('new'), { status: 401, retryAfter: 0, delayMs: 0 });
  assert.equal(guard.failures.size, 1);
});

test('shared proxy/exit allows many successful logins and independent accounts after failures', async t => {
  const f = await fixture(t);
  const user = { id: 'other', username: 'other', apiKey: 'other-key' };
  const admin = await f.db.get('SELECT passwordHash FROM users WHERE id = ?', 'admin');
  await f.db.run('INSERT INTO users (id,username,passwordHash,apiKey,level,sessionVersion,createdAt) VALUES (?,?,?,?,1,1,?)', user.id, user.username, admin.passwordHash, user.apiKey, Date.now());
  for (let i = 0; i < 15; i++) {
    const result = await f.request('/api/auth/login', { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.1, 192.0.2.10', 'x-forwarded-proto': 'https' }, body: { username: i % 2 ? 'admin' : 'other', password: 'admin' } });
    assert.equal(result.status, 200);
    assert.match(result.headers.get('set-cookie'), /; Secure/);
  }
  for (let i = 0; i < 11; i++) {
    const result = await f.request('/api/auth/login', { method: 'POST', headers: { 'x-forwarded-for': `198.51.100.${i}` }, body: { username: 'admin', password: 'wrong' } });
    assert.equal(result.status, i < 10 ? 401 : 429);
    if (i === 10) assert.equal(result.headers.get('retry-after'), '2');
  }
  for (const username of ['other', 'admin']) assert.equal((await f.request('/api/auth/login', { method: 'POST', body: { username, password: 'admin' } })).status, 200);
  assert.equal((await f.request('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } })).status, 401);
  assert.equal((await f.upload()).status, 200);
});

test('production direct HTTP remains usable; HTTPS hint upgrades existing cookie and image links', async t => {
  const f = await fixture(t, { env: { NODE_ENV: 'production' } });
  const direct = await f.request('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin' } });
  assert.equal(direct.status, 200); assert.doesNotMatch(direct.headers.get('set-cookie'), /; Secure/);
  const proxied = await f.request('/api/auth/login', { method: 'POST', cookie: direct.cookie, headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'attacker.example' }, body: { username: 'admin', password: 'admin' } });
  assert.equal(proxied.status, 200); assert.match(proxied.headers.get('set-cookie'), /; Secure/);
  const upload = await f.request('/api/upload', { method: 'POST', key: f.key, headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'attacker.example' }, body: f.form() });
  assert.equal(upload.status, 200); assert.ok(upload.data.url.startsWith(f.url.replace('http:', 'https:') + '/uploads/'));
  const directList = await f.request('/api/images', { key: f.key, headers: { origin: 'https://evil.example', referer: 'https://evil.example', 'x-forwarded-host': 'evil.example' } });
  assert.equal(directList.status, 200); assert.ok(directList.data.items[0].url.startsWith(f.url + '/uploads/'));
});

test('explicit false ignores forged protocol; BASE_URL controls canonical link prefix', async t => {
  const f = await fixture(t, { env: { TRUST_PROXY: 'false', BASE_URL: 'https://canonical.example/prefix/' } });
  const result = await f.request('/api/auth/login', { method: 'POST', headers: { 'x-forwarded-proto': 'https' }, body: { username: 'admin', password: 'admin' } });
  assert.equal(result.status, 200); assert.doesNotMatch(result.headers.get('set-cookie'), /; Secure/);
  const upload = await f.upload(); assert.equal(upload.status, 200);
  assert.ok(upload.data.url.startsWith('https://canonical.example/prefix/uploads/'));
});

test('concurrent guesses cannot evade the global verification cap with account/XFF rotation', async t => {
  const f = await fixture(t);
  // Slow historical bcrypt hashes keep verification in flight deterministically.
  const hash = await bcrypt.hash('correct', 12);
  for (let i = 0; i < 24; i++) await f.db.run('INSERT INTO users (id,username,passwordHash,apiKey,level,sessionVersion,createdAt) VALUES (?,?,?,?,1,1,?)', `guess${i}`, `absent${i}`, hash, `key${i}`, Date.now());
  const results = await Promise.all(Array.from({ length: 24 }, (_, i) => f.request('/api/auth/login', { method: 'POST', headers: { 'x-forwarded-for': `198.51.100.${i}` }, body: { username: `absent${i}`, password: 'wrong' } })));
  const busy = results.filter(result => result.status === 429 && result.data.message === 'AUTH_BUSY');
  assert.ok(busy.length > 0);
  assert.ok(busy.every(result => result.headers.get('retry-after') === '1'));
  assert.ok(results.every(result => [401, 429].includes(result.status)));
  assert.equal((await f.request('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'admin' } })).status, 200);
});

test('an actual reverse proxy preserves public HTTPS links and login cookies without IP configuration', async t => {
  const http = await import('node:http');
  const { once } = await import('node:events');
  const f = await fixture(t);
  const proxy = http.createServer((req, res) => {
    const upstream = http.request(f.url + req.url, { method: req.method, headers: {
      ...req.headers, 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9, 192.0.2.10'
    } }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on('error', () => res.destroy());
    req.on('aborted', () => upstream.destroy()); res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(() => new Promise(resolve => { proxy.closeAllConnections(); proxy.close(resolve); }));
  const url = `http://127.0.0.1:${proxy.address().port}`;
  const login = await fetch(url + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'javascript' }, body: JSON.stringify({ username: 'admin', password: 'admin' }) });
  assert.equal(login.status, 200); await login.json();
  assert.match(login.headers.get('set-cookie'), /; Secure/);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const status = await fetch(url + '/api/user/status', { headers: { cookie } });
  assert.equal((await status.json()).authenticated, true);
  const uploaded = await fetch(url + '/api/upload', { method: 'POST', headers: { 'x-api-key': f.key, 'x-forwarded-host': 'attacker.example' }, body: f.form() });
  assert.equal(uploaded.status, 200);
  assert.ok((await uploaded.json()).url.startsWith(url.replace('http:', 'https:') + '/uploads/'));
});

test('disconnecting guesses does not release in-flight bcrypt permits early', async t => {
  const http = await import('node:http');
  const { waitFor } = await import('./helpers.js');
  const f = await fixture(t);
  const hash = await bcrypt.hash('correct', 13);
  await f.db.run('UPDATE users SET passwordHash = ? WHERE id = ?', hash, 'admin');
  let sawBusy;
  const saturated = new Promise(resolve => { sawBusy = resolve; });
  const requests = Array.from({ length: 24 }, () => {
    const req = http.request(f.url + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      let raw = ''; res.on('data', chunk => { raw += chunk; });
      res.on('end', () => { if (res.statusCode === 429 && JSON.parse(raw).message === 'AUTH_BUSY') sawBusy(); });
    });
    req.on('error', () => {}); req.end(JSON.stringify({ username: 'admin', password: 'wrong' }));
    return req;
  });
  t.after(() => requests.forEach(req => req.destroy()));
  let timer;
  try { await Promise.race([saturated, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('login cap not reached')), 10000); })]); }
  finally { clearTimeout(timer); }
  requests.forEach(req => req.destroy());
  const stillBusy = await f.request('/api/auth/login', { method: 'POST', body: { username: 'absent', password: 'wrong' } });
  assert.equal(stillBusy.data.message, 'AUTH_BUSY');
  await waitFor(async () => {
    const r = await f.request('/api/auth/login', { method: 'POST', body: { username: 'absent', password: 'wrong' } });
    return r.status === 401;
  }, 15000);
  assert.equal((await f.request('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'correct' } })).status, 200);
});

test('initializing a legacy password enforces bcrypt byte limits without changing the account', async t => {
  const f = await fixture(t);
  await f.db.run('UPDATE users SET passwordHash = NULL WHERE id = ?', 'admin');
  const rejected = await f.request('/api/auth/login', { method: 'POST', body: { username: 'admin', password: '密'.repeat(25) } });
  assert.equal(rejected.status, 400);
  assert.equal((await f.db.get('SELECT passwordHash FROM users WHERE id = ?', 'admin')).passwordHash, null);
  assert.equal((await f.request('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'new-valid-password' } })).status, 200);
});

test('HTTPS registration replaces an existing HTTP session with a Secure cookie', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/settings/branding', { method: 'POST', key: f.key, body: { registrationEnabled: true } })).status, 200);
  const result = await f.request('/api/auth/register', { method: 'POST', cookie: f.admin, headers: { 'x-forwarded-proto': 'https' }, body: { username: 'registered', password: 'registration-password' } });
  assert.equal(result.status, 200); assert.match(result.headers.get('set-cookie'), /; Secure/);
  assert.notEqual(result.cookie, f.admin);
  assert.equal((await f.request('/api/user/status', { cookie: result.cookie })).data.username, 'registered');
  assert.equal((await f.request('/api/user/status', { cookie: f.admin })).data.authenticated, false);
});
