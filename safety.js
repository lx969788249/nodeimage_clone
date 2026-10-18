// Track the lifetime of handlers, including work that continues after disconnect.
export const httpError = (status, message) => Object.assign(new Error(message), { status });

export class OperationGate {
  active = 0;
  maintenance = false;
  failed = false;
  waiter = null;
  enter(continuation = false) {
    if (this.failed) throw httpError(503, 'RECOVERY_REQUIRED');
    if (this.maintenance && !continuation) throw httpError(503, 'MAINTENANCE');
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.active === 0) this.waiter?.();
    };
  }
  async exclusive(fn, timeout = 30000) {
    if (this.failed) throw httpError(503, 'RECOVERY_REQUIRED');
    if (this.maintenance) throw httpError(503, 'MAINTENANCE');
    this.maintenance = true;
    let timer;
    try {
      if (this.active) await new Promise((resolve, reject) => {
        this.waiter = resolve;
        timer = setTimeout(() => reject(httpError(503, 'BUSY_REQUESTS')), timeout);
      });
      return await fn();
    } finally {
      clearTimeout(timer);
      this.waiter = null;
      this.maintenance = false;
    }
  }
}

export class Mutex {
  tail = Promise.resolve();
  async run(fn) {
    const previous = this.tail;
    let release;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }
}

export function text(body, key, { required = false, max = 256, trim = true } = {}) {
  const value = body?.[key];
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max) throw httpError(400, `INVALID_${key}`);
  const result = trim ? value.trim() : value;
  if (required && !result) throw httpError(400, `INVALID_${key}`);
  return result;
}

// Reserve before Multer consumes bytes. There is no waiting queue.
export class Admission {
  constructor(globalLimit, userLimit) {
    this.globalLimit = globalLimit;
    this.userLimit = userLimit;
    this.active = 0;
    this.users = new Map();
  }
  enter(userId) {
    const count = this.users.get(userId) || 0;
    if (this.active >= this.globalLimit || count >= this.userLimit) throw httpError(429, 'UPLOAD_BUSY');
    this.active++;
    this.users.set(userId, count + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active--;
      const left = this.users.get(userId) - 1;
      if (left) this.users.set(userId, left); else this.users.delete(userId);
    };
  }
}

// Node timers clamp delays above 2^31-1 to 1ms. Split long supported intervals.
export function scheduleLongDelay(fn, milliseconds, schedule = setTimeout, cancel = clearTimeout) {
  let handle;
  let cancelled = false;
  const arm = remaining => {
    const delay = Math.min(remaining, 2_147_483_647);
    handle = schedule(() => {
      if (cancelled) return;
      if (remaining > delay) arm(remaining - delay); else fn();
    }, delay);
  };
  arm(milliseconds);
  return () => { cancelled = true; cancel(handle); };
}

// No IP keys, lockouts, request queue or unbounded timestamp arrays. A valid
// password is checked even after failures; delays apply only to failed attempts.
export class LoginGuard {
  constructor({ limit = 8, capacity = 1024, windowMs = 60000, now = Date.now } = {}) {
    Object.assign(this, { limit, capacity, windowMs, now });
    this.active = 0;
    this.failures = new Map();
    this.global = { start: now(), count: 0 };
  }
  enter() {
    if (this.active >= this.limit) throw httpError(429, 'AUTH_BUSY');
    this.active++;
    let done = false;
    return () => { if (!done) { done = true; this.active--; } };
  }
  failed(username) {
    const now = this.now();
    for (const [key, value] of this.failures) if (now - value.start >= this.windowMs) this.failures.delete(key);
    if (now - this.global.start >= this.windowMs) this.global = { start: now, count: 0 };
    this.global.count = Math.min(this.global.count + 1, 1000);
    let account = this.failures.get(username);
    if (!account) {
      if (this.failures.size >= this.capacity) this.failures.delete(this.failures.keys().next().value);
      account = { start: now, count: 0 };
      this.failures.set(username, account);
    }
    account.count = Math.min(account.count + 1, 1000);
    const limited = account.count > 10 || this.global.count > 100;
    return { status: limited ? 429 : 401, retryAfter: limited ? 2 : 0,
      delayMs: Math.min(2000, Math.max(0, account.count - 5, this.global.count - 100) * 100) };
  }
  succeeded(username) { this.failures.delete(username); }
}
