import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkerTaskManager, WORKER_EVENT_LIMIT, WORKER_MAX_OUTPUT_BYTES, WORKER_MAX_TOTAL_TIMEOUT_MS } from '../src/worker-jobs.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('WorkerTaskManager cancellation is immutable and invokes the task canceller', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-worker-jobs-'));t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const manager = new WorkerTaskManager({ env: { CWD_DATA_DIR: dir, CWD_WORKER_AUTO_REVIEW: '0' }, heartbeatMs: 1000 });t.after(() => manager.close());
  let release;let registered = false;let unregister = () => {};let cancelReason = null;
  const started = await manager.start({ mode: 'DELEGATE', role: 'worker', execution: 'cross_provider_thread', provider: 'third_party', model: 'third-a', effort: 'max', cwd: dir, timeoutMs: 10000 }, async ({ registerCancel }) => {unregister = registerCancel((reason) => { cancelReason = reason; });registered = true;await new Promise((resolve) => { release = resolve; });return { output: 'SHOULD_NOT_COMPLETE' };});
  let running = await manager.get(started.taskId);for (let i = 0; i < 40 && (!running || running.status !== 'running' || !registered); i++) { await sleep(10); running = await manager.get(started.taskId); }
  assert.equal(running.status, 'running');assert.equal(registered, true);
  const cancelled = await manager.cancel(started.taskId, 'operator stop');assert.equal(cancelled.status, 'cancelled');assert.equal(cancelled.error.code, 'WORKER_CANCELLED');assert.equal(cancelled.cancelReason, 'operator stop');assert.ok(cancelled.lastProgressAt);assert.ok(cancelled.events.some((event) => event.type === 'worker.cancelled'));assert.equal(cancelReason, 'operator stop');
  release();unregister();await sleep(30);const final = await manager.get(started.taskId);assert.equal(final.status, 'cancelled');assert.equal(final.output, null);
  const persisted = JSON.parse(await fs.readFile(path.join(dir, 'worker-tasks', `${started.taskId}.json`), 'utf8'));assert.equal(persisted.status, 'cancelled');
});

test('WorkerTaskManager emits a Main review checkpoint and renews the same lease once', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-worker-renewal-'));t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const manager = new WorkerTaskManager({ env: { CWD_DATA_DIR: dir, CWD_WORKER_AUTO_REVIEW: '0' }, heartbeatMs: 1000 });t.after(() => manager.close());
  let release;let extension = 0;
  const started = await manager.start({ mode: 'DELEGATE', role: 'worker', execution: 'cross_provider_thread', provider: 'third_party', model: 'third-a', effort: 'max', cwd: dir, timeoutMs: 2000, maxTotalTimeoutMs: 6000 }, async ({ registerExtend }) => {registerExtend((extraMs) => { extension += extraMs; });await new Promise((resolve) => { release = resolve; });return { output: 'RENEWED_OK' };});
  let review = await manager.get(started.taskId);for (let i = 0; i < 30 && !review.reviewDue; i++) { await sleep(100); review = await manager.get(started.taskId); }
  assert.equal(review.status, 'running');assert.equal(review.reviewDue, true);assert.ok(review.reviewAt);const oldDeadline = Date.parse(review.deadlineAt);
  const extended = await manager.extend(started.taskId, { extraMs: 2000, reason: 'direction and progress verified' });assert.equal(extension, 2000);assert.equal(extended.reviewDue, false);assert.equal(extended.extensionCount, 1);assert.ok(Date.parse(extended.deadlineAt) > oldDeadline);assert.ok(extended.events.some((event) => event.type === 'worker.review_due'));assert.ok(extended.events.some((event) => event.type === 'worker.extended'));
  release();const final = await manager.wait(started.taskId, { timeoutMs: 2000, pollMs: 25 });assert.equal(final.status, 'completed');assert.equal(final.output, 'RENEWED_OK');
});

test('WorkerTaskManager automatically renews progressing quick work within its hard cap', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-worker-auto-renewal-'));t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const manager = new WorkerTaskManager({ env: { CWD_DATA_DIR: dir }, heartbeatMs: 1000, progressStaleMs: 2000, heartbeatStaleMs: 3000 });t.after(() => manager.close());
  let release; let extension = 0;
  const started = await manager.start({ mode: 'DELEGATE', role: 'worker', execution: 'cross_provider_thread', provider: 'third_party', model: 'third-a', profile: 'quick', timeoutMs: 2000, maxTotalTimeoutMs: 5000 }, async ({ report, registerExtend }) => {
    registerExtend((extraMs) => { extension += extraMs; });
    await report({ phase: 'executing', progress: 35, message: 'substantive step complete', event: { type: 'item/completed', details: { itemType: 'commandExecution' } } });
    await new Promise((resolve) => { release = resolve; });
    return { output: 'AUTO_RENEWED_OK' };
  });
  let task = await manager.get(started.taskId);
  for (let i = 0; i < 30 && !(task.autoExtensionCount > 0 || ['completed', 'cancelled', 'failed', 'timed_out'].includes(task.status)); i++) { await sleep(100); task = await manager.get(started.taskId); }
  assert.equal(task.status, 'running'); assert.equal(task.autoExtensionCount, 1); assert.equal(task.lastReviewDecision, 'extended'); assert.ok(extension >= 1000); assert.ok(task.events.some((event) => event.type === 'worker.extended' && event.details.automatic === 'true'));
  release(); const final = await manager.wait(started.taskId, { timeoutMs: 2000, pollMs: 25 }); assert.equal(final.status, 'completed'); assert.equal(final.output, 'AUTO_RENEWED_OK');
});

test('WorkerTaskManager automatically cancels heartbeat-only work at review', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-worker-auto-cancel-'));t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const manager = new WorkerTaskManager({ env: { CWD_DATA_DIR: dir }, heartbeatMs: 1000, progressStaleMs: 1000, heartbeatStaleMs: 3000 });t.after(() => manager.close());
  let release; let cancelReason = '';
  const started = await manager.start({ mode: 'DELEGATE', role: 'worker', execution: 'cross_provider_thread', provider: 'third_party', model: 'third-a', profile: 'quick', timeoutMs: 3000, maxTotalTimeoutMs: 5000 }, async ({ registerCancel }) => {
    registerCancel((reason) => { cancelReason = reason; release?.(); });
    await new Promise((resolve) => { release = resolve; });
    return { output: 'MUST_NOT_COMPLETE' };
  });
  const final = await manager.wait(started.taskId, { timeoutMs: 3000, pollMs: 25 });
  assert.equal(final.status, 'cancelled'); assert.equal(final.progressEvidence.state, 'terminal'); assert.match(final.cancelReason, /没有近期实质进展/); assert.match(cancelReason, /没有近期实质进展/); assert.equal(final.lastReviewDecision, 'cancelled'); assert.ok(final.events.some((event) => event.type === 'worker.auto_review'));
});

test('WorkerTaskManager gives an already-executing heartbeat-only task one bounded grace review', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-worker-auto-grace-'));t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const manager = new WorkerTaskManager({ env: { CWD_DATA_DIR: dir }, heartbeatMs: 1000, progressStaleMs: 1000, heartbeatStaleMs: 3000 });t.after(() => manager.close());
  let release; let extension = 0;
  const started = await manager.start({ mode: 'DELEGATE', role: 'worker', execution: 'cross_provider_thread', provider: 'third_party', model: 'third-a', profile: 'quick', timeoutMs: 3000, maxTotalTimeoutMs: 6000 }, async ({ report, registerExtend }) => {
    registerExtend((extraMs) => { extension += extraMs; });
    await report({ phase: 'executing', progress: 35, message: 'long command still running', event: { type: 'item/started', details: { itemType: 'commandExecution' } } });
    await new Promise((resolve) => { release = resolve; });
    return { output: 'GRACE_OK' };
  });
  let task = await manager.get(started.taskId);
  for (let i = 0; i < 40 && task.autoExtensionCount === 0; i++) { await sleep(100); task = await manager.get(started.taskId); }
  assert.equal(task.status, 'running'); assert.equal(task.autoExtensionCount, 1); assert.match(task.lastReviewReason, /一次有界观察宽限/); assert.ok(extension >= 1000); assert.ok(task.events.some((event) => event.type === 'worker.extended' && event.details.grace === 'true'));
  release(); const final = await manager.wait(started.taskId, { timeoutMs: 2000, pollMs: 25 }); assert.equal(final.status, 'completed'); assert.equal(final.output, 'GRACE_OK');
});

test('WorkerTaskManager hard-caps total runtime at sixty minutes even when metadata asks for more',async(t)=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cwd-worker-cap-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const manager=new WorkerTaskManager({env:{CWD_DATA_DIR:dir}});t.after(()=>manager.close());let release;let running=false;const started=await manager.start({mode:'DELEGATE',role:'worker',execution:'cross_provider_thread',provider:'third_party',model:'third-a',timeoutMs:1000,maxTotalTimeoutMs:24*60*60*1000},async()=>{running=true;await new Promise(r=>{release=r});return{output:'done'}});assert.equal(started.maxTotalTimeoutMs,WORKER_MAX_TOTAL_TIMEOUT_MS);for(let i=0;i<50&&!running;i++)await sleep(10);assert.equal(running,true);await manager.cancel(started.taskId,'test complete');release();await sleep(10);assert.equal((await manager.get(started.taskId)).status,'cancelled')});

test('provider-isolated Worker is cancelled when control state switches to MAIN',async(t)=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cwd-worker-main-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.writeFile(path.join(dir,'state.json'),JSON.stringify({mode:'DELEGATE'}));const manager=new WorkerTaskManager({env:{CWD_DATA_DIR:dir},modeGuardMs:100,heartbeatMs:1000});t.after(()=>manager.close());let release;let cancelReason='';let registered=false;const started=await manager.start({mode:'DELEGATE',role:'worker',execution:'cross_provider_thread',provider:'third_party',model:'third-a',timeoutMs:5000},async({registerCancel})=>{registerCancel((reason)=>{cancelReason=reason;release?.()});registered=true;await new Promise(r=>{release=r});return{output:'must-not-win'}});for(let i=0;i<30&&!registered;i++)await sleep(20);await fs.writeFile(path.join(dir,'state.json'),JSON.stringify({mode:'MAIN'}));let task=await manager.get(started.taskId);for(let i=0;i<40&&task.status!=='cancelled';i++){await sleep(50);task=await manager.get(started.taskId)}assert.equal(task.status,'cancelled');assert.match(task.cancelReason,/MAIN mode activated/);assert.match(cancelReason,/MAIN mode activated/)});

test('guarded Worker fails closed if delegation state disappears',async(t)=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cwd-worker-state-missing-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const state=path.join(dir,'state.json');await fs.writeFile(state,JSON.stringify({mode:'DELEGATE'}));const manager=new WorkerTaskManager({env:{CWD_DATA_DIR:dir},modeGuardMs:100});t.after(()=>manager.close());let release;const started=await manager.start({mode:'DELEGATE',role:'worker',execution:'cross_provider_thread',provider:'third_party',model:'third-a',timeoutMs:5000},async({registerCancel})=>{registerCancel(()=>release?.());await new Promise(r=>{release=r});return{output:'must-not-win'}});await fs.unlink(state);let task=await manager.get(started.taskId);for(let i=0;i<40&&task.status!=='cancelled';i++){await sleep(50);task=await manager.get(started.taskId)}assert.equal(task.status,'cancelled');assert.match(task.cancelReason,/state unavailable/i)});
test('WorkerTaskManager reconciles persisted nonterminal tasks after a control-plane restart',async(t)=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cwd-worker-orphan-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const taskId='wrk_orphaned-control-plane';const file=path.join(dir,'worker-tasks',`${taskId}.json`);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify({taskId,status:'running',phase:'executing',progress:35,createdAt:'2026-08-22T00:00:00.000Z',startedAt:'2026-08-22T00:00:00.000Z',updatedAt:'2026-08-22T00:00:30.000Z',lastHeartbeatAt:'2026-08-22T00:00:30.000Z',lastProgressAt:'2026-08-22T00:00:30.000Z',events:[],eventSeq:0,provider:'third_party',model:'third-a',role:'worker',mode:'DELEGATE',execution:'cross_provider_thread'})+'\n');let observed=null;const manager=new WorkerTaskManager({env:{CWD_DATA_DIR:dir},onOrphan:async(payload)=>{observed=payload}});t.after(()=>manager.close());const recovered=await manager.get(taskId);assert.equal(recovered.status,'failed');assert.equal(recovered.phase,'orphaned');assert.equal(recovered.error.code,'CONTROL_PLANE_RESTART');assert.ok(recovered.events.some((event)=>event.type==='worker.orphaned'));assert.equal(observed.task.taskId,taskId);assert.equal(observed.task.error.code,'CONTROL_PLANE_RESTART');const persisted=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(persisted.status,'failed');assert.equal(persisted.error.code,'CONTROL_PLANE_RESTART')});
test('WorkerTaskManager preserves meaningful progress, exposes evidence, and compacts noisy results',async(t)=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cwd-worker-progress-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const manager=new WorkerTaskManager({env:{CWD_DATA_DIR:dir},heartbeatMs:1000,persistDebounceMs:5,persistMinIntervalMs:5});t.after(()=>manager.close());let release;let ready;const observed=new Promise((resolve)=>{ready=resolve});const started=await manager.start({mode:'DELEGATE',role:'worker',execution:'cross_provider_thread',provider:'third_party',model:'third-a',timeoutMs:10000},async({report})=>{await report({phase:'executing',progress:35,message:'command complete',event:{type:'item/completed',details:{itemType:'commandExecution'}}});await report({phase:'running',message:'usage only',event:{type:'thread/tokenUsage/updated'}});ready();await new Promise((resolve)=>{release=resolve});return{output:'x'.repeat(WORKER_MAX_OUTPUT_BYTES*2),messages:['m'.repeat(WORKER_MAX_OUTPUT_BYTES)]}});await observed;const running=await manager.get(started.taskId);assert.equal(running.progress,35);assert.equal(running.lastProgressType,'item/completed');assert.equal(running.progressEvidence.state,'progressing');assert.ok(running.events.length>=2);assert.equal(running.events.at(-1).type,'thread/tokenUsage/updated');release();const final=await manager.wait(started.taskId,{timeoutMs:2000,pollMs:25});assert.equal(final.status,'completed');assert.ok(Buffer.byteLength(final.output,'utf8')<=WORKER_MAX_OUTPUT_BYTES+32);assert.ok(final.messages[0].length<=32*1024+32);assert.ok(final.events.length<=WORKER_EVENT_LIMIT)});
test('WorkerTaskManager removes expired terminal task memory and disk records',async(t)=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cwd-worker-retention-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const manager=new WorkerTaskManager({env:{CWD_DATA_DIR:dir},retentionMs:1,sweepMs:1000,persistDebounceMs:5,persistMinIntervalMs:5});t.after(()=>manager.close());const started=await manager.start({mode:'DELEGATE',role:'worker',execution:'cross_provider_thread',provider:'third_party',model:'third-a',timeoutMs:10000},async()=>({output:'done'}));const final=await manager.wait(started.taskId,{timeoutMs:2000,pollMs:25});assert.equal(final.status,'completed');await sleep(10);const result=await manager.cleanup();assert.ok(result.removed>=1);assert.equal(await manager.get(started.taskId),null);await assert.rejects(()=>fs.readFile(path.join(dir,'worker-tasks',`${started.taskId}.json`)),{code:'ENOENT'})});
