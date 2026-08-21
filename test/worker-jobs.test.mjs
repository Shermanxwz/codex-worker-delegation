import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkerTaskManager } from '../src/worker-jobs.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('WorkerTaskManager cancellation is immutable and invokes the task canceller', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-worker-jobs-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const manager = new WorkerTaskManager({ env: { CWD_DATA_DIR: dir }, heartbeatMs: 1000 });
  t.after(() => manager.close());
  let release;
  let registered = false;
  let unregister = () => {};
  let cancelReason = null;
  const started = await manager.start({ mode: 'DELEGATE', role: 'worker', execution: 'cross_provider_thread', provider: 'third_party', model: 'third-a', effort: 'max', cwd: dir, timeoutMs: 10000 }, async ({ registerCancel }) => {
    unregister = registerCancel((reason) => { cancelReason = reason; });
    registered = true;
    await new Promise((resolve) => { release = resolve; });
    return { output: 'SHOULD_NOT_COMPLETE' };
  });
  let running = await manager.get(started.taskId);
  for (let i = 0; i < 40 && (!running || running.status !== 'running' || !registered); i++) { await sleep(10); running = await manager.get(started.taskId); }
  assert.equal(running.status, 'running');assert.equal(registered, true);
  const cancelled = await manager.cancel(started.taskId, 'operator stop');
  assert.equal(cancelled.status, 'cancelled');assert.equal(cancelled.error.code, 'WORKER_CANCELLED');assert.equal(cancelled.cancelReason, 'operator stop');assert.ok(cancelled.lastProgressAt);assert.ok(cancelled.events.some((event) => event.type === 'worker.cancelled'));assert.equal(cancelReason, 'operator stop');
  release();unregister();await sleep(30);
  const final = await manager.get(started.taskId);assert.equal(final.status, 'cancelled');assert.equal(final.output, null);
  const persisted = JSON.parse(await fs.readFile(path.join(dir, 'worker-tasks', `${started.taskId}.json`), 'utf8'));assert.equal(persisted.status, 'cancelled');
});

test('WorkerTaskManager emits a Main review checkpoint and renews the same lease once', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-worker-renewal-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const manager = new WorkerTaskManager({ env: { CWD_DATA_DIR: dir }, heartbeatMs: 1000 });
  t.after(() => manager.close());
  let release;
  let extension = 0;
  const started = await manager.start({ mode: 'DELEGATE', role: 'worker', execution: 'cross_provider_thread', provider: 'third_party', model: 'third-a', effort: 'max', cwd: dir, timeoutMs: 2000, maxTotalTimeoutMs: 6000 }, async ({ registerExtend }) => {
    registerExtend((extraMs) => { extension += extraMs; });
    await new Promise((resolve) => { release = resolve; });
    return { output: 'RENEWED_OK' };
  });
  let review = await manager.get(started.taskId);
  for (let i = 0; i < 30 && !review.reviewDue; i++) { await sleep(100); review = await manager.get(started.taskId); }
  assert.equal(review.status, 'running');
  assert.equal(review.reviewDue, true);
  assert.ok(review.reviewAt);
  const oldDeadline = Date.parse(review.deadlineAt);
  const extended = await manager.extend(started.taskId, { extraMs: 2000, reason: 'direction and progress verified' });
  assert.equal(extension, 2000);
  assert.equal(extended.reviewDue, false);
  assert.equal(extended.extensionCount, 1);
  assert.ok(Date.parse(extended.deadlineAt) > oldDeadline);
  assert.ok(extended.events.some((event) => event.type === 'worker.review_due'));
  assert.ok(extended.events.some((event) => event.type === 'worker.extended'));
  release();
  const final = await manager.wait(started.taskId, { timeoutMs: 2000, pollMs: 25 });
  assert.equal(final.status, 'completed');
  assert.equal(final.output, 'RENEWED_OK');
});
