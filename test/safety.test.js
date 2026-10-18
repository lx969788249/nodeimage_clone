import test from 'node:test';
import assert from 'node:assert/strict';
import { OperationGate } from '../safety.js';

test('maintenance timeout leaves the live generation serving and never executes switch', async () => {
  const gate = new OperationGate();
  const release = gate.enter();
  let switched = false;
  const pending = gate.exclusive(async () => { switched = true; }, 20);
  assert.throws(() => gate.enter(), e => e.status === 503);
  await assert.rejects(pending, e => e.status === 503 && e.message === 'BUSY_REQUESTS');
  assert.equal(switched, false);
  assert.equal(gate.maintenance, false);
  release();
  await gate.exclusive(async () => { switched = true; });
  assert.equal(switched, true);
});

test('720-hour delay splits into safe Node timer segments and cancellation stops callbacks', async () => {
  const { scheduleLongDelay } = await import('../safety.js');
  const queued = []; const cancelled = [];
  const schedule = (fn, delay) => { const value = { fn, delay }; queued.push(value); return value; };
  let fired = 0;
  const stop = scheduleLongDelay(() => fired++, 720 * 3600000, schedule, value => cancelled.push(value));
  assert.equal(queued[0].delay, 2147483647);
  queued[0].fn();
  assert.equal(queued[1].delay, 720 * 3600000 - 2147483647);
  assert.equal(fired, 0); queued[1].fn(); assert.equal(fired, 1);
  stop(); assert.equal(cancelled.length, 1);
  const second = scheduleLongDelay(() => fired++, 10, schedule, value => cancelled.push(value));
  second(); queued.at(-1).fn(); assert.equal(fired, 1);
});
