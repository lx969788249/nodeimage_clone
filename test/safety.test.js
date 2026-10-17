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
