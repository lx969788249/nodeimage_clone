import { httpError } from './safety.js';

export function proxySetting(value) {
  if (value === undefined || value === '') return { compatibility: true, trust: false };
  if (value === 'true') return { compatibility: false, trust: true };
  if (value === 'false') return { compatibility: false, trust: false };
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (!Number.isSafeInteger(hops)) throw new Error('Invalid TRUST_PROXY hop count');
    return { compatibility: false, trust: hops };
  }
  if (/^[+-]|^NaN$/i.test(value)) throw new Error('Invalid TRUST_PROXY');
  return { compatibility: false, trust: value }; // Express validates IP/CIDR at startup.
}

export function baseUrl(value = '') {
  if (!value) return '';
  if (/[\s\u0000-\u001f\u007f-\u009f\\?#]/.test(value) || !/^https?:\/\//.test(value)) throw new Error('Invalid BASE_URL');
  const authority = value.slice(value.indexOf('://') + 3).split('/')[0];
  try { validateAuthority(authority, value.startsWith('https:') ? 'https' : 'http'); } catch { throw new Error('Invalid BASE_URL'); }
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid BASE_URL'); }
  if (!url.hostname || url.username || url.password) throw new Error('Invalid BASE_URL');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function validateAuthority(value, protocol) {
  if (typeof value !== 'string' || !value || /[\s\u0000-\u001f\u007f-\u009f\\/@?#%,"'`]/.test(value)) throw httpError(400, 'INVALID_HOST');
  let url;
  try { url = new URL(`${protocol}://${value}`); } catch { throw httpError(400, 'INVALID_HOST'); }
  if (!/^(?:[a-z0-9._-]+|\[[a-f0-9:.]+\])$/i.test(url.hostname) || url.pathname !== '/' || url.username || url.password) throw httpError(400, 'INVALID_HOST');
  return url.host;
}

// Only presentation/transport hints in compatibility mode; never client identity.
// All consumers, including express-session proxy:true, see the same sanitized proto.
export function requestContext({ compatibility, trustPeer, configuredBase = '' }) {
  return (req, res, next) => {
    try {
      const trusted = !!trustPeer(req.socket.remoteAddress, 0);
      const allowHint = compatibility || trusted;
      const hint = req.headers['x-forwarded-proto'];
      const protocol = req.socket.encrypted ? 'https' : allowHint && /^(http|https)$/.test(hint) ? hint : 'http';
      let host = validateAuthority(req.headers.host, protocol);
      // Forwarded host changes the link destination only with explicit proxy trust.
      if (trusted && req.headers['x-forwarded-host']) host = validateAuthority(req.headers['x-forwarded-host'], protocol);
      req.publicContext = { protocol, baseUrl: configuredBase || `${protocol}://${host}` };
      req.headers['x-forwarded-proto'] = protocol;
      next();
    } catch (err) { next(err); }
  };
}

export const PROJECT_URL = 'https://github.com/lx969788249/nodeimage_clone';
const RELEASE_API = 'https://api.github.com/repos/lx969788249/nodeimage_clone';
const UPDATE_DAY = 24 * 60 * 60 * 1000;
const UPDATE_COOLDOWN = 15 * 60 * 1000;
export function stableVersion(tag) {
  if (typeof tag !== 'string' || tag.length > 100) return null;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(tag);
  if (!match || !match.slice(1, 4).every(value => Number.isSafeInteger(Number(value)))) return null;
  return match.slice(1, 4).join('.');
}
export function installedVersion(packageVersion, buildVersion = '') {
  if (typeof packageVersion !== 'string' || typeof buildVersion !== 'string' || stableVersion(packageVersion) !== packageVersion ||
      (buildVersion && buildVersion.replace(/^v/, '') !== packageVersion)) {
    throw new Error('APP_VERSION must match package.json version');
  }
  return packageVersion;
}

export function compareVersions(a, b) {
  a = stableVersion(a); b = stableVersion(b);
  if (!a || !b) return null;
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}

// State lives in SQLite settings. No browser/user identifiers are sent to GitHub.
export class ReleaseUpdates {
  constructor({ read, change, run = fn => fn(), version = '', revision = '', fetcher = fetch, now = Date.now, timeoutMs = 5000 }) {
    Object.assign(this, { read, change, run, fetcher, now, timeoutMs });
    this.version = stableVersion(version);
    this.revision = /^[a-f0-9]{40}$/i.test(revision) ? revision.toLowerCase() : null;
    this.running = null;
  }
  clean(value) {
    const state = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const timestamp = key => Number.isFinite(state[key]) && state[key] >= 0 && state[key] <= this.now() + 7 * UPDATE_DAY ? state[key] : 0;
    const latest = stableVersion(state.latest?.tag) && typeof state.latest?.publishedAt === 'string' && Number.isFinite(Date.parse(state.latest.publishedAt)) && Date.parse(state.latest.publishedAt) <= this.now() + 300000 ?
      { tag: state.latest.tag, version: stableVersion(state.latest.tag), publishedAt: state.latest.publishedAt } : null;
    return { attemptedAt: timestamp('attemptedAt'), checkedAt: timestamp('checkedAt'), nextCheckAt: timestamp('nextCheckAt'),
      outcome: ['ok', 'no_release', 'unavailable'].includes(state.outcome) ? state.outcome : 'unknown', latest,
      comparedRevision: /^[a-f0-9]{40}$/.test(state.comparedRevision || '') ? state.comparedRevision : null,
      relation: ['ahead', 'behind', 'identical', 'diverged'].includes(state.relation) ? state.relation : null,
      notifiedVersion: stableVersion(state.notifiedVersion), ignoredVersion: stableVersion(state.ignoredVersion) };
  }
  mutate(fn) { return this.change((value, db) => fn(this.clean(value), db)); }
  describe(state) {
    state = this.clean(state);
    let currentVersion = this.version, status = state.outcome === 'ok' && !state.latest ? 'unknown' : state.outcome, available = false;
    if (state.outcome === 'ok' && state.latest) {
      const comparison = compareVersions(state.latest.version, this.version);
      if (comparison !== null) { available = comparison > 0; status = available ? 'available' : comparison < 0 ? 'ahead' : 'current'; }
      else if (this.revision && state.comparedRevision === this.revision && state.relation) {
        available = state.relation === 'ahead';
        status = available ? 'available' : state.relation === 'identical' ? 'current' : state.relation === 'behind' ? 'ahead' : 'unknown';
        if (state.relation === 'identical') currentVersion = state.latest.version;
      } else status = 'unknown';
    }
    return { projectUrl: PROJECT_URL, currentVersion, revision: this.revision, status, available,
      latest: state.latest ? { ...state.latest, url: `${PROJECT_URL}/releases/tag/${encodeURIComponent(state.latest.tag)}` } : null,
      checking: !!this.running, attemptedAt: state.attemptedAt, checkedAt: state.checkedAt, nextCheckAt: state.nextCheckAt,
      manualAvailableAt: state.attemptedAt ? state.attemptedAt + UPDATE_COOLDOWN : 0,
      ignored: !!state.latest && state.ignoredVersion === state.latest.version,
      notified: !!state.latest && !!state.notifiedVersion && compareVersions(state.notifiedVersion, state.latest.version) >= 0 };
  }
  async snapshot() { return this.describe(await this.read()); }
  async json(url, signal) {
    const response = await this.fetcher(url, { signal, redirect: 'error', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'nodeimage-update-check' } });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('UPDATE_SERVICE_UNAVAILABLE');
    }
    let bytes = 0; const chunks = [];
    try {
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 256 * 1024) throw new Error('UPDATE_RESPONSE_TOO_LARGE');
        chunks.push(Buffer.from(chunk));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { if (!response.body?.locked) await response.body?.cancel().catch(() => {}); }
  }
  check(manual = false) {
    if (this.running) return this.running;
    this.running = Promise.resolve().then(() => this.run(async () => {
      const state = this.clean(await this.read()), now = this.now();
      if (manual ? state.attemptedAt && now < state.attemptedAt + UPDATE_COOLDOWN : now < state.nextCheckAt) return;
      // Reserve before network I/O, so a restart also respects the check budget.
      await this.mutate(value => ({ ...value, attemptedAt: now, nextCheckAt: now + UPDATE_DAY }));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const release = await this.json(`${RELEASE_API}/releases/latest`, controller.signal);
        let latest = null, relation = null;
        if (release) {
          const version = stableVersion(release.tag_name);
          if (!version || release.draft !== false || release.prerelease !== false || typeof release.published_at !== 'string' || !Number.isFinite(Date.parse(release.published_at)) || Date.parse(release.published_at) > this.now() + 300000) throw new Error('INVALID_RELEASE');
          latest = { tag: release.tag_name, version, publishedAt: release.published_at };
          if (!this.version && this.revision) {
            const comparison = await this.json(`${RELEASE_API}/compare/${this.revision}...${encodeURIComponent(latest.tag)}`, controller.signal);
            if (['ahead', 'behind', 'identical', 'diverged'].includes(comparison?.status)) relation = comparison.status;
          }
        }
        await this.mutate(value => ({ ...value, outcome: latest ? 'ok' : 'no_release', latest, relation,
          comparedRevision: this.revision, checkedAt: this.now() }));
      } catch {
        await this.mutate(value => ({ ...value, outcome: 'unavailable' }));
      } finally { clearTimeout(timer); }
    })).finally(() => { this.running = null; });
    return this.running;
  }
  async notice(action, version, authorize = () => {}) {
    if (!['claim', 'ignore'].includes(action) || !stableVersion(version)) throw httpError(400, 'INVALID_UPDATE_ACTION');
    let show = false;
    const state = await this.mutate(async (value, db) => {
      await authorize(db);
      const info = this.describe(value);
      if (!info.available || info.latest.version !== version) throw httpError(409, 'UPDATE_CHANGED');
      if (action === 'ignore') value.ignoredVersion = version;
      else show = !info.ignored && !info.notified;
      if (show || action === 'ignore') {
        if (!value.notifiedVersion || compareVersions(version, value.notifiedVersion) > 0) value.notifiedVersion = version;
      }
      return value;
    });
    return { ...this.describe(state), show };
  }
}
