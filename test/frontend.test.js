import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const script = await fs.readFile(new URL('../public/assets/js/main.js', import.meta.url), 'utf8');
const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');

// Minimal DOM for executing the actual production script and its event handlers.
// These tests verify behavior, not text patterns; they do not assert browser layout.
class Element {
  constructor(id = '') {
    this.id = id; this.value = ''; this.checked = false; this.disabled = false;
    this.style = {}; this.dataset = {}; this.children = []; this.listeners = new Map();
    this._classes = new Set(); this._queries = new Map(); this.textContent = ''; this.innerHTML = '';
    this.classList = {
      add: (...xs) => xs.forEach(x => this._classes.add(x)),
      remove: (...xs) => xs.forEach(x => this._classes.delete(x)),
      contains: x => this._classes.has(x),
      toggle: (x, on = !this._classes.has(x)) => on ? this._classes.add(x) : this._classes.delete(x)
    };
  }
  addEventListener(type, fn) { const xs = this.listeners.get(type) || []; xs.push(fn); this.listeners.set(type, xs); }
  async emit(type, event = {}) { await Promise.all((this.listeners.get(type) || []).map(fn => fn({ target: this, preventDefault() {}, ...event }))); }
  dispatchEvent(event) { this.emit(event.type); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this); }
  setAttribute(key, value) { this[key] = value; }
  getAttribute(key) { return this[key]; }
  contains(target) { return this === target || this.children.includes(target); }
  querySelector(selector) { if (!this._queries.has(selector)) this._queries.set(selector, new Element()); return this._queries.get(selector); }
  querySelectorAll() { return []; }
  closest() { return this.section || null; }
}

async function browser({ authenticated = false } = {}) {
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(x => [x[1], new Element(x[1])]));
  const sections = [...html.matchAll(/<section[^>]*id="([^"]+)"[^>]*data-save="([^"]+)"/g)].map(x => {
    const el = elements.get(x[1]); el.dataset.save = x[2]; return el;
  });
  const doc = new Element();
  doc.getElementById = id => elements.get(id) || null;
  doc.createElement = () => new Element();
  doc.documentElement = new Element(); doc.body = new Element(); doc.head = new Element();
  doc.querySelectorAll = selector => {
    if (!selector.startsWith('.settings-section')) return [];
    return sections.filter(s => (!selector.includes('.dirty') || s.classList.contains('dirty')) &&
      (!selector.includes('data-save="') || selector.includes(`data-save="${s.dataset.save}"`)));
  };
  const requests = [], copied = [], timers = [], media = new Element(), window = new Element(), local = new Map();
  window.matchMedia = () => media; window.location = { origin: 'http://127.0.0.1:3456', reload() {} };
  const config = { intervalHours: 24, keepCount: 7, s3AccessKey: '***KEY1', s3SecretKey: '***' };
  let responder = async (url) => {
    if (url === '/api/user/status') return { authenticated, id: 'admin', username: 'admin', level: 9 };
    if (url === '/api/settings/branding') return { name: 'Example', uploadMaxFileBytes: 104857600 };
    if (url === '/api/settings/backup') return config;
    if (url.startsWith('/api/images')) return { items: [], total: 0 };
    return { message: '完成' };
  };
  const context = vm.createContext({ document: doc, window,
    localStorage: { getItem: k => local.get(k) ?? null, setItem: (k,v) => local.set(k,v) },
    navigator: { clipboard: { writeText: async value => { copied.push(value); } } },
    fetch: async (url, opts = {}) => {
      requests.push({ url, ...opts }); const result = await responder(url, opts);
      return { ok: true, status: 200, json: async () => result, ...result.response };
    },
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); }, requestAnimationFrame: () => {},
    FormData, Blob, Event, URL, console: { error() {} }, confirm: () => true
  });
  vm.runInContext(script.replace('\ninit();', '\nglobalThis.initialized = init();'), context);
  await context.initialized;
  return { elements, sections, requests, copied, doc, media, local, window,
    run: code => vm.runInContext(code, context),
    respond: fn => { responder = fn; },
    flush: async () => { for (let i=0;i<8;i++) await Promise.resolve(); }
  };
}

test('settings navigation loads backup config without scope errors; ordinary users can edit upload preferences', async () => {
  const b = await browser({ authenticated: true });
  await b.elements.get('settingsNavBtn').emit('click'); await b.flush();
  assert.equal(b.elements.get('settingsView').style.display, 'block');
  assert.ok(b.requests.some(x => x.url === '/api/settings/backup'));
  b.run("state.user = { id: 'bob', username: 'bob', level: 1 }; setSettingsEnabled(true)");
  for (const id of ['compressToWebp', 'webpQuality', 'autoWatermark', 'watermarkContent', 'autoCopyLink', 'autoDelete', 'deleteDays']) {
    assert.equal(b.elements.get(id).disabled, false, id);
  }
  assert.equal(b.elements.get('brandNameInput').disabled, true);
  b.run("state.user.username = 'admin'");
  assert.equal(b.run('Boolean(isAdminUser())'), false);
});

test('history batch copy includes only selected images', async () => {
  const b = await browser();
  b.run("state.history.items = [{id:'a',url:'https://a'},{id:'b',url:'https://b'},{id:'c',url:'https://c'}]; state.history.selected = new Set(['a','c']); copyAllLinks('direct','history')");
  await b.flush(); assert.deepEqual(b.copied, ['https://a\nhttps://c']);
});

test('backup credential masks stay out of POST; entered credentials are sent then cleared', async () => {
  const b = await browser({ authenticated: true });
  await b.run('loadBackupSettings()');
  assert.equal(b.elements.get('s3AccessKey').value, '');
  assert.match(b.elements.get('s3AccessKey').placeholder, /已配置/);
  await b.run('saveBackupSettings()');
  const saved = JSON.parse(b.requests.find(x => x.method === 'POST').body);
  assert.equal('s3AccessKey' in saved, false); assert.equal('s3SecretKey' in saved, false);
  b.elements.get('s3AccessKey').value = 'actual-new-access'; b.elements.get('s3SecretKey').value = 'actual-new-secret';
  await b.run('saveBackupSettings()');
  const latest = JSON.parse(b.requests.filter(x => x.method === 'POST').at(-1).body);
  assert.equal(latest.s3AccessKey, 'actual-new-access'); assert.equal(latest.s3SecretKey, 'actual-new-secret');
  assert.equal(b.elements.get('s3AccessKey').value, ''); assert.equal(b.elements.get('s3SecretKey').value, '');
});

test('failed backup save retains dirty flag and aborts S3/Webhook tests', async () => {
  const b = await browser({ authenticated: true });
  b.respond(async () => ({ message: '配置校验失败', response: { ok: false, status: 400 } }));
  const section = b.elements.get('autoBackupSection'); section.classList.add('dirty');
  await b.elements.get('saveAllSettingsBtn').emit('click');
  assert.equal(section.classList.contains('dirty'), true);
  for (const id of ['testS3Btn', 'testWebhookBtn']) await b.elements.get(id).emit('click');
  assert.equal(b.requests.some(x => /test-s3|test-webhook/.test(x.url)), false);
  assert.match(b.elements.get('testS3Result').textContent, /配置校验失败/);
});

test('backup action displays server outcome and does not infer remote success from configuration', async () => {
  const b = await browser({ authenticated: true });
  b.respond(async () => ({ message: '仅本地备份完成' }));
  await b.elements.get('triggerBackupBtn').emit('click');
  const last = b.doc.getElementById('notificationContainer').children.at(-1);
  assert.equal(last.querySelector('.notification-text').textContent, '仅本地备份完成');
  assert.equal(b.requests.some(x => x.url === '/api/backup/status'), false);
});

test('notification treats filenames and server errors as plain text', async () => {
  const b = await browser();
  const attack = '<img src=x onerror=alert(1)>';
  b.run(`showNotification(${JSON.stringify(attack)}, 'error')`);
  const last = b.doc.getElementById('notificationContainer').children.at(-1);
  assert.equal(last.querySelector('.notification-text').textContent, attack);
  assert.equal(last.innerHTML.includes(attack), false);
});

test('credential change preserves spaces in current and new passwords', async () => {
  const b = await browser({ authenticated: true });
  b.elements.get('changeOldPassword').value = ' old password ';
  await b.elements.get('changeCredsSubmit').emit('click');
  b.elements.get('changeNewUsername').value = 'alice';
  b.elements.get('changeNewPassword').value = ' new password ';
  b.elements.get('changeNewPasswordConfirm').value = ' new password ';
  await b.elements.get('changeCredsSubmit').emit('click');
  const login = b.requests.find(x => x.url === '/api/auth/login');
  const changed = b.requests.find(x => x.url === '/api/user/credentials');
  assert.equal(JSON.parse(login.body).password, ' old password ');
  assert.equal(JSON.parse(changed.body).oldPassword, ' old password ');
  assert.equal(JSON.parse(changed.body).newPassword, ' new password ');
});

test('logout clears visible API key, image history and private settings; failed logout reports error', async () => {
  const b = await browser({ authenticated: true });
  b.run("state.history.items=[{id:'private'}]; state.results=[{id:'private'}]");
  b.elements.get('apiKeyInput').value = 'private-api-key';
  b.respond(async url => url === '/api/user/status' ? { authenticated: false } : {});
  await b.elements.get('logoutBtn').emit('click');
  assert.equal(b.elements.get('apiKeyInput').value, '');
  assert.equal(b.run('state.history.items.length + state.results.length'), 0);
  assert.equal(b.elements.get('settingsView').style.display, 'none');
  b.respond(async () => ({ response: { ok: false, status: 503 } }));
  await b.elements.get('logoutBtn').emit('click');
  assert.match(b.doc.getElementById('notificationContainer').children.at(-1).querySelector('.notification-text').textContent, /注销失败/);
});

test('configured limit controls label and client precheck; input is cleared for same-file reselection', async () => {
  const b = await browser({ authenticated: true });
  b.respond(async () => ({ uploadMaxFileBytes: 2 * 1024 * 1024 }));
  await b.run('loadBrandingFromServer()'); b.run('applyBranding()');
  assert.match(b.elements.get('uploadLimit').textContent, /2 MiB（2097152 字节）/);
  const input = b.elements.get('fileInput'); input.value = 'C:/fakepath/test.png';
  input.files = [{ name: 'test.png', type: 'image/png', size: 2 * 1024 * 1024 + 1 }];
  await input.emit('change'); await b.flush();
  assert.equal(input.value, '');
  assert.equal(b.requests.some(x => x.url === '/api/upload'), false);
});

test('new image preview resets previous pan/zoom and manual theme survives system change', async () => {
  const b = await browser();
  b.elements.get('zoomSlider').value = 4; await b.elements.get('zoomSlider').emit('input');
  b.run("openImageModal('https://image')");
  await b.elements.get('zoomSlider').emit('input');
  assert.match(b.elements.get('modalImage').style.transform, /scale\(1\)/);
  await b.elements.get('themeToggleBtn').emit('click');
  const theme = b.run('state.theme');
  await b.media.emit('change', { matches: theme !== 'dark' });
  assert.equal(b.run('state.theme'), theme);
});

test('copied cURL examples contain shell quotes and real line continuations', async () => {
  const b = await browser();
  const example = b.elements.get('curlExample1').textContent;
  assert.match(example, /POST "http:\/\/127\.0\.0\.1:3456\/api\/upload"/);
  assert.equal(example.includes('\\"'), false);
  assert.ok(example.includes('\\\n  -H "X-API-Key:'));
});


test('deleting the last image of a page reloads the remaining final page', async () => {
  const b = await browser({ authenticated: true });
  b.respond(async url => ({ items: [], total: 12, totalPages: 1, currentPage: url.includes('page=2') ? 2 : 1 }));
  await b.run('loadHistory(2)');
  assert.ok(b.requests.some(x => x.url === '/api/images?page=1&limit=12'));
  assert.equal(b.run('state.history.currentPage'), 1);
});
