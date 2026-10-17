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
