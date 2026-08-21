import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { workerTaskPath, workerTasksDir, statePath } from './paths.mjs';

export const WORKER_DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
export const WORKER_MAX_TIMEOUT_MS = 15 * 60 * 1000;
export const WORKER_MAX_TOTAL_TIMEOUT_MS = 60 * 60 * 1000;
export const WORKER_DEFAULT_EXTENSION_MS = 15 * 60 * 1000;
export const WORKER_REVIEW_LEAD_MS = 90 * 1000;
export const WORKER_HEARTBEAT_MS = 5000;
const WORKER_CLOSE_TIMEOUT_MS = 5000;
const WORKER_CANCEL_HANDLER_TIMEOUT_MS = 5000;
export const TERMINAL_TASK_STATES = Object.freeze(new Set(['completed', 'failed', 'timed_out', 'cancelled', 'delegation_required']));

export function normalizeWorkerTimeout(value) {
  if (value === undefined || value === null || value === '') return WORKER_DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1000) throw new Error('timeoutMs must be at least 1000 milliseconds');
  return Math.min(Math.trunc(parsed), WORKER_MAX_TIMEOUT_MS);
}

export function normalizeWorkerExtension(value) {
  if (value === undefined || value === null || value === '') return WORKER_DEFAULT_EXTENSION_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1000) throw new Error('extraMs must be at least 1000 milliseconds');
  return Math.min(Math.trunc(parsed), WORKER_MAX_TIMEOUT_MS);
}

export function normalizeWorkerMaxTotalTimeout(value, initialTimeoutMs = WORKER_DEFAULT_TIMEOUT_MS) {
  const initial = normalizeWorkerTimeout(initialTimeoutMs);
  if (value === undefined || value === null || value === '') return WORKER_MAX_TOTAL_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < initial) throw new Error('maxTotalTimeoutMs must be at least the initial timeout');
  return Math.min(Math.trunc(parsed), WORKER_MAX_TOTAL_TIMEOUT_MS);
}

function reviewLeadMs(timeoutMs) { return Math.min(WORKER_REVIEW_LEAD_MS, Math.max(1000, Math.floor(timeoutMs / 2))); }
function durationLabel(ms) { if (ms >= 60000) return `${Math.round(ms / 60000)} 分钟`; return `${Math.max(1, Math.round(ms / 1000))} 秒`; }
export function isTerminalTask(task) { return TERMINAL_TASK_STATES.has(task?.status); }
export function isWorkerTimeout(error) { return error?.code === 'CODEX_TURN_TIMEOUT' || error?.code === 'CODEX_REQUEST_TIMEOUT' || error?.code === 'WORKER_TIMEOUT' || /timed out|timeout|deadline exceeded/i.test(String(error?.message || error)); }
export function errorDetails(error) { if (!error) return null; return { name: error.name || 'Error', code: error.code || null, message: error.message || String(error), method: error.method || null, data: error.data === undefined ? null : error.data }; }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function iso(now) { return new Date(now).toISOString(); }

async function settleWithin(promises, timeoutMs = WORKER_CLOSE_TIMEOUT_MS) {
  if (!promises.length) return true;
  let timer;
  const completed = await Promise.race([
    Promise.allSettled(promises).then(() => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); timer.unref?.(); })
  ]);
  clearTimeout(timer); return completed;
}

async function invokeWithin(handler, argument, timeoutMs = WORKER_CANCEL_HANDLER_TIMEOUT_MS) {
  if (typeof handler !== 'function') return { invoked: false, settled: true };
  let timer;
  const outcome = await Promise.race([
    Promise.resolve().then(() => handler(argument)).then(() => ({ invoked: true, settled: true }), (error) => ({ invoked: true, settled: true, error })),
    new Promise((resolve) => { timer = setTimeout(() => resolve({ invoked: true, settled: false }), timeoutMs); timer.unref?.(); })
  ]);
  clearTimeout(timer); return outcome;
}

function safeEventDetails(details) {
  if (details === undefined || details === null) return null;
  if (typeof details === 'string') return details.slice(0, 500);
  if (typeof details !== 'object') return String(details).slice(0, 500);
  const allowed = ['method', 'threadId', 'turnId', 'itemId', 'itemType', 'status', 'phase', 'role', 'extraMs', 'reason', 'deadlineAt', 'reviewAt', 'reviewDue'];
  const safe = {}; for (const key of allowed) if (details[key] !== undefined && details[key] !== null) safe[key] = String(details[key]).slice(0, 200);
  return Object.keys(safe).length ? safe : null;
}

export class WorkerTaskManager {
  constructor({ env = process.env, heartbeatMs = Number(env.CWD_WORKER_HEARTBEAT_MS || WORKER_HEARTBEAT_MS), modeGuardMs = Number(env.CWD_WORKER_MODE_GUARD_MS || 500), now = () => Date.now() } = {}) {
    this.env = env; this.heartbeatMs = Math.max(1000, Number.isFinite(heartbeatMs) ? heartbeatMs : WORKER_HEARTBEAT_MS); this.modeGuardMs = Math.max(100, Math.min(5000, Number.isFinite(modeGuardMs) ? modeGuardMs : 500)); this.now = now;
    this.tasks = new Map(); this.timers = new Map(); this.modeTimers = new Map(); this.modeGuardedTasks = new Set(); this.reviewTimers = new Map(); this.writes = new Map(); this.runs = new Map(); this.cancelers = new Map(); this.extenders = new Map(); this.extensionLocks = new Set(); this.closing = false;
  }

  async start(metadata, runner) {
    if (this.closing) { const error = new Error('Worker task manager is shutting down'); error.code = 'WORKER_MANAGER_CLOSING'; throw error; }
    const createdAt = this.now(); const timeoutMs = normalizeWorkerTimeout(metadata.timeoutMs);
    const task = { taskId: `wrk_${crypto.randomUUID()}`, status: 'queued', phase: 'queued', progress: 0, message: '任务已创建，等待 Worker 启动', createdAt: iso(createdAt), startedAt: null, completedAt: null, updatedAt: iso(createdAt), lastHeartbeatAt: iso(createdAt), durationMs: null, timeoutMs, maxTotalTimeoutMs: normalizeWorkerMaxTotalTimeout(metadata.maxTotalTimeoutMs, timeoutMs), deadlineAt: null, reviewAt: null, reviewDue: false, extensionCount: 0, mode: metadata.mode, role: metadata.role, execution: metadata.execution, provider: metadata.provider, model: metadata.model, effort: metadata.effort || 'auto', cwd: metadata.cwd || null, threadId: null, turnId: null, output: null, messages: [], result: null, error: null, cancelRequestedAt: null, cancelReason: null, cancelledAt: null, lastProgressAt: iso(createdAt), events: [], eventSeq: 0 };
    this.tasks.set(task.taskId, task);
    const hasControlState = await fs.access(statePath(this.env)).then(() => true).catch(() => false); if (hasControlState) this.modeGuardedTasks.add(task.taskId);
    await this.#queueWrite(task);
    const run = this.#run(task.taskId, runner).catch(async (error) => { const completedAt = this.now(); await this.#update(task.taskId, { status: isWorkerTimeout(error) ? 'timed_out' : 'failed', phase: isWorkerTimeout(error) ? 'timeout' : 'failed', message: error.message || 'Worker task failed before execution started', completedAt: iso(completedAt), error: errorDetails(error) }, { type: 'worker.manager_failed', message: error.message || 'Worker task failed before execution started' }).catch(() => {}); });
    let tracked; tracked = run.finally(() => { if (this.runs.get(task.taskId) === tracked) this.runs.delete(task.taskId); }); this.runs.set(task.taskId, tracked); void tracked.catch(() => {});
    return structuredClone(task);
  }

  async get(taskId) {
    if (this.tasks.has(taskId)) { const task = this.tasks.get(taskId); if (isTerminalTask(task)) { const pendingWrite = this.writes.get(taskId); if (pendingWrite) await pendingWrite; } return structuredClone(this.tasks.get(taskId)); }
    let raw; try { raw = JSON.parse(await fs.readFile(workerTaskPath(this.env, taskId), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (raw.status === 'queued' || raw.status === 'starting' || raw.status === 'running') { raw.status = 'failed'; raw.phase = 'orphaned'; raw.message = '控制面重启后无法继续原 Worker 进程'; raw.error = { name: 'WorkerTaskOrphanedError', code: 'CONTROL_PLANE_RESTART', message: raw.message, method: null, data: null }; raw.completedAt = iso(this.now()); raw.updatedAt = raw.completedAt; raw.durationMs = raw.startedAt ? Math.max(0, this.now() - Date.parse(raw.startedAt)) : null; await this.#queueWrite(raw); }
    this.tasks.set(taskId, raw); return structuredClone(raw);
  }

  async wait(taskId, { timeoutMs = WORKER_DEFAULT_TIMEOUT_MS, pollMs = 250 } = {}) { const deadline = this.now() + timeoutMs; while (true) { const task = await this.get(taskId); if (!task) return null; if (isTerminalTask(task)) return task; const remaining = deadline - this.now(); if (remaining <= 0) return task; await sleep(Math.min(pollMs, remaining)); } }

  async cancel(taskId, reason = 'cancelled by caller') {
    const task = await this.get(taskId); if (!task || isTerminalTask(task)) return task;
    const normalizedReason = String(reason || 'cancelled by caller').trim().slice(0, 500) || 'cancelled by caller';
    const now = this.now(); const cancelRequestedAt = iso(now);
    // If the runner already registered its App Server/process canceller, invoke
    // it before publishing a terminal task. This prevents status readers from
    // observing "cancelled" while the delegated process has not yet received
    // its stop signal. Startup races remain covered by #registerCancel, which
    // notices cancelRequestedAt and immediately invokes a late registrant.
    const canceler = this.cancelers.get(taskId);
    if (canceler) {
      await this.#update(taskId, { phase: 'cancelling', message: `正在取消 Worker：${normalizedReason}`, cancelRequestedAt, cancelReason: normalizedReason }, { type: 'worker.cancel_requested', message: `正在取消 Worker：${normalizedReason}` });
      await invokeWithin(canceler, normalizedReason);
    }
    const current = this.tasks.get(taskId); if (!current || isTerminalTask(current)) return this.get(taskId);
    const completedAt = iso(this.now());
    await this.#update(taskId, { status: 'cancelled', phase: 'cancelled', message: `Worker 已取消：${normalizedReason}`, completedAt, cancelledAt: completedAt, cancelRequestedAt: current.cancelRequestedAt || cancelRequestedAt, cancelReason: normalizedReason, durationMs: current.startedAt ? Math.max(0, this.now() - Date.parse(current.startedAt)) : null, error: { name: 'WorkerCancelledError', code: 'WORKER_CANCELLED', message: normalizedReason, method: null, data: null } }, { type: 'worker.cancelled', message: `Worker 已取消：${normalizedReason}` });
    return this.get(taskId);
  }

  async cancelAll(reason = 'cancelled by control plane') { const ids = [...this.tasks.values()].filter((task) => !isTerminalTask(task)).map((task) => task.taskId); return Promise.all(ids.map((taskId) => this.cancel(taskId, reason))); }

  async extend(taskId, { extraMs, reason = '主控确认 Worker 方向正确，续期继续执行' } = {}) {
    const task = await this.get(taskId); if (!task || isTerminalTask(task)) return task;
    if (this.extensionLocks.has(taskId)) { const error = new Error('Worker extension is already being processed'); error.code = 'WORKER_EXTENSION_IN_PROGRESS'; throw error; }
    if (!task.reviewDue) { const error = new Error('Worker extension is only allowed at the scheduled main-control review point'); error.code = 'WORKER_REVIEW_NOT_DUE'; throw error; }
    const normalizedExtraMs = normalizeWorkerExtension(extraMs); const startedAt = Date.parse(task.startedAt || '') || this.now(); const hardDeadline = startedAt + Math.min(Number(task.maxTotalTimeoutMs) || WORKER_MAX_TOTAL_TIMEOUT_MS, WORKER_MAX_TOTAL_TIMEOUT_MS); const currentDeadline = Date.parse(task.deadlineAt || '') || (startedAt + task.timeoutMs); const acceptedExtraMs = Math.min(normalizedExtraMs, Math.max(0, hardDeadline - currentDeadline));
    if (acceptedExtraMs < 1000) { const error = new Error('Worker reached its maximum total runtime and cannot be extended'); error.code = 'WORKER_MAX_TOTAL_TIMEOUT'; throw error; }
    const extender = this.extenders.get(taskId); if (!extender) { const error = new Error('Worker execution is not currently extendable'); error.code = 'WORKER_EXTENSION_UNAVAILABLE'; throw error; }
    this.extensionLocks.add(taskId);
    try { await extender(acceptedExtraMs); const deadlineAt = currentDeadline + acceptedExtraMs; const reviewAt = deadlineAt - reviewLeadMs(acceptedExtraMs); const normalizedReason = String(reason || '主控确认 Worker 方向正确，续期继续执行').trim().slice(0, 500) || '主控确认 Worker 方向正确，续期继续执行'; const updated = await this.#update(taskId, { phase: 'running', message: `主控已确认方向正常，Worker 已续期 ${durationLabel(acceptedExtraMs)}`, deadlineAt: iso(deadlineAt), reviewAt: iso(reviewAt), reviewDue: false, extensionCount: (Number(task.extensionCount) || 0) + 1 }, { type: 'worker.extended', message: '主控确认后续期 Worker', details: { extraMs: acceptedExtraMs, reason: normalizedReason, deadlineAt: iso(deadlineAt), reviewAt: iso(reviewAt) } }); this.#scheduleReview(taskId, reviewAt); return updated; }
    finally { this.extensionLocks.delete(taskId); }
  }

  async close(reason = 'control plane closed') {
    if (this.closing) { await settleWithin([...this.runs.values(), ...this.writes.values()]); return; }
    this.closing = true;
    for (const timer of this.timers.values()) clearInterval(timer); this.timers.clear(); for (const timer of this.modeTimers.values()) clearInterval(timer); this.modeTimers.clear(); this.modeGuardedTasks.clear(); for (const timer of this.reviewTimers.values()) clearTimeout(timer); this.reviewTimers.clear();
    await this.cancelAll(reason).catch(() => {}); await settleWithin([...this.runs.values()]); await settleWithin([...this.writes.values()]); this.cancelers.clear(); this.extenders.clear(); this.extensionLocks.clear();
  }

  async #run(taskId, runner) {
    if (isTerminalTask(this.tasks.get(taskId))) return;
    const startedAt = this.now(); const started = await this.#update(taskId, { status: 'running', phase: 'starting', progress: 5, message: 'Worker 已启动，正在连接 Codex App Server', startedAt: iso(startedAt), lastHeartbeatAt: iso(startedAt), lastProgressAt: iso(startedAt), deadlineAt: iso(startedAt + this.tasks.get(taskId).timeoutMs), reviewAt: iso(startedAt + this.tasks.get(taskId).timeoutMs - reviewLeadMs(this.tasks.get(taskId).timeoutMs)), reviewDue: false }, { type: 'worker.started', message: 'Worker 已启动' });
    if (!started || isTerminalTask(started)) return;
    this.#scheduleReview(taskId, Date.parse(started.reviewAt)); const heartbeat = setInterval(() => { void this.#update(taskId, { lastHeartbeatAt: iso(this.now()), message: 'Worker 仍在运行，等待下一阶段结果' }).catch(() => {}); }, this.heartbeatMs); this.timers.set(taskId, heartbeat);
    if (this.modeGuardedTasks.has(taskId)) { const modeTimer = setInterval(() => { void this.#enforceControlMode(taskId).catch(() => {}); }, this.modeGuardMs); this.modeTimers.set(taskId, modeTimer); }
    try { const result = await runner({ taskId, report: (patch = {}) => this.#update(taskId, { ...patch, lastHeartbeatAt: iso(this.now()) }, patch.event || null), heartbeat: () => this.#update(taskId, { lastHeartbeatAt: iso(this.now()) }), registerCancel: (handler) => this.#registerCancel(taskId, handler), registerExtend: (handler) => this.#registerExtend(taskId, handler) }); if (isTerminalTask(this.tasks.get(taskId))) return; const completedAt = this.now(); await this.#update(taskId, { status: 'completed', phase: 'completed', progress: 100, message: 'Worker 已完成并返回结果', completedAt: iso(completedAt), durationMs: Math.max(0, completedAt - startedAt), threadId: result?.threadId || this.tasks.get(taskId)?.threadId || null, turnId: result?.turn?.id || this.tasks.get(taskId)?.turnId || null, output: result?.output || '', messages: Array.isArray(result?.messages) ? result.messages : [], result }, { type: 'worker.completed', message: 'Worker 已完成' }); }
    catch (error) { if (isTerminalTask(this.tasks.get(taskId))) return; const completedAt = this.now(); const timedOut = isWorkerTimeout(error); await this.#update(taskId, { status: timedOut ? 'timed_out' : 'failed', phase: timedOut ? 'timeout' : 'failed', progress: Math.min(this.tasks.get(taskId)?.progress || 0, 95), message: timedOut ? 'Worker 超时；任务未返回完成事件' : 'Worker 执行失败', completedAt: iso(completedAt), durationMs: Math.max(0, completedAt - startedAt), error: errorDetails(error) }, { type: timedOut ? 'worker.timeout' : 'worker.failed', message: timedOut ? 'Worker 超时' : 'Worker 执行失败' }); }
    finally { clearInterval(heartbeat); this.timers.delete(taskId); const modeTimer = this.modeTimers.get(taskId); if (modeTimer) clearInterval(modeTimer); this.modeTimers.delete(taskId); this.modeGuardedTasks.delete(taskId); const reviewTimer = this.reviewTimers.get(taskId); if (reviewTimer) clearTimeout(reviewTimer); this.reviewTimers.delete(taskId); this.extenders.delete(taskId); }
  }

  async #enforceControlMode(taskId) {
    const task = this.tasks.get(taskId); if (!task || isTerminalTask(task)) return;
    let state; try { state = JSON.parse(await fs.readFile(statePath(this.env), 'utf8')); } catch (error) { await this.cancel(taskId, `delegation control state unavailable; failing closed (${error.code || error.message})`); return; }
    if (!['AUTO', 'DELEGATE', 'MAIN'].includes(state?.mode)) { await this.cancel(taskId, 'delegation control state is invalid; failing closed'); return; }
    if (state.mode === 'MAIN') await this.cancel(taskId, 'MAIN mode activated; provider-isolated Worker frozen by cancellation');
  }

  #registerCancel(taskId, handler) {
    if (typeof handler !== 'function') return () => {};
    const task = this.tasks.get(taskId); if (!task) return () => {};
    if (task.cancelRequestedAt || task.status === 'cancelled') { try { void Promise.resolve(handler(task.cancelReason || 'cancelled by caller')).catch(() => {}); } catch {} return () => {}; }
    this.cancelers.set(taskId, handler); return () => { if (this.cancelers.get(taskId) === handler) this.cancelers.delete(taskId); };
  }

  #registerExtend(taskId, handler) { if (typeof handler !== 'function') return () => {}; const task = this.tasks.get(taskId); if (!task || isTerminalTask(task)) return () => {}; this.extenders.set(taskId, handler); return () => { if (this.extenders.get(taskId) === handler) this.extenders.delete(taskId); }; }
  #scheduleReview(taskId, reviewAt) { const previous = this.reviewTimers.get(taskId); if (previous) clearTimeout(previous); const delay = Math.max(0, Number(reviewAt) - this.now()); const timer = setTimeout(() => { this.reviewTimers.delete(taskId); void this.#markReviewDue(taskId).catch(() => {}); }, delay); this.reviewTimers.set(taskId, timer); }
  async #markReviewDue(taskId) { const task = this.tasks.get(taskId); if (!task || isTerminalTask(task) || task.reviewDue) return; if (Date.parse(task.deadlineAt || '') <= this.now()) return; await this.#update(taskId, { phase: 'review', reviewDue: true, message: '已到主控观察点：请检查 Worker 进度、方向和安全性后续期或终止' }, { type: 'worker.review_due', message: '等待主控观察后决定续期或终止', details: { reviewAt: task.reviewAt, deadlineAt: task.deadlineAt } }); }

  async #update(taskId, patch = {}, event = null) {
    const task = this.tasks.get(taskId); if (!task) return null; if (isTerminalTask(task)) return structuredClone(task);
    for (const key of ['status', 'phase', 'progress', 'message', 'startedAt', 'completedAt', 'updatedAt', 'lastHeartbeatAt', 'durationMs', 'threadId', 'turnId', 'output', 'messages', 'result', 'error', 'cancelRequestedAt', 'cancelReason', 'cancelledAt', 'lastProgressAt', 'deadlineAt', 'reviewAt', 'reviewDue', 'extensionCount']) if (patch[key] !== undefined) task[key] = patch[key];
    if (event) { task.eventSeq += 1; task.lastProgressAt = iso(this.now()); task.events.push({ seq: task.eventSeq, at: iso(this.now()), type: event.type || 'worker.progress', message: event.message || task.message, phase: task.phase, progress: task.progress, details: safeEventDetails(event.details) }); if (task.events.length > 80) task.events.splice(0, task.events.length - 80); }
    task.updatedAt = iso(this.now()); await this.#queueWrite(task); return structuredClone(task);
  }

  async #queueWrite(task) { const snapshot = structuredClone(task); const previous = this.writes.get(snapshot.taskId) || Promise.resolve(); const next = previous.catch(() => {}).then(() => this.#persist(snapshot)); const tracked = next.finally(() => { if (this.writes.get(snapshot.taskId) === tracked) this.writes.delete(snapshot.taskId); }); this.writes.set(snapshot.taskId, tracked); return tracked; }
  async #persist(task) { const directory = workerTasksDir(this.env); const file = workerTaskPath(this.env, task.taskId); await fs.mkdir(directory, { recursive: true, mode: 0o700 }); const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`; let handle; try { handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(`${JSON.stringify(task, null, 2)}\n`); await handle.sync(); await handle.close(); handle = null; await fs.rename(temporary, file); await fs.chmod(file, 0o600).catch(() => {}); const directoryHandle = await fs.open(directory, 'r'); try { await directoryHandle.sync(); } finally { await directoryHandle.close(); } } finally { if (handle) await handle.close().catch(() => {}); await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); } }
}
