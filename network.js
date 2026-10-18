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
