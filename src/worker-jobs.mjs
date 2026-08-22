import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { workerTaskPath, workerTasksDir, statePath } from './paths.mjs';

export const WORKER_DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
export const WORKER_MAX_TIMEOUT_MS = 15 * 60 * 1000;
export const WORKER_MAX_TOTAL_TIMEOUT_MS = 60 * 60 * 1000;
export const WORKER_DEFAULT_EXTENSION_MS = 15 * 60 * 1000;
export const WORKER_REVIEW_LEAD_MS = 90 * 1000;
export const WORKER_HEARTBEAT_MS = 5000;
export const WORKER_QUICK_TIMEOUT_MS = 2 * 60 * 1000;
export const WORKER_QUICK_MAX_TOTAL_TIMEOUT_MS = 10 * 60 * 1000;
export const WORKER_QUICK_AUTO_EXTENSION_MS = 2 * 60 * 1000;
export const WORKER_STANDARD_AUTO_EXTENSION_MS = 15 * 60 * 1000;
export const WORKER_EVENT_LIMIT = 80;
export const WORKER_TASK_RETENTION_MS = 24 * 60 * 60 * 1000;
export const WORKER_TASK_SWEEP_MS = 60 * 1000;
export const WORKER_PERSIST_DEBOUNCE_MS = 500;
export const WORKER_PERSIST_MIN_INTERVAL_MS = 2000;
export const WORKER_MAX_OUTPUT_BYTES = 128 * 1024;
export const WORKER_MAX_MESSAGE_BYTES = 32 * 1024;
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
function isCancellationRequested(task) { return Boolean(task?.cancelRequestedAt); }
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
  const allowed = ['method', 'threadId', 'turnId', 'itemId', 'itemType', 'status', 'phase', 'role', 'profile', 'extraMs', 'reason', 'deadlineAt', 'reviewAt', 'reviewDue', 'decision', 'automatic', 'evidence', 'grace', 'heartbeatAgeMs', 'meaningfulProgressAgeMs', 'autoReviewCount', 'autoExtensionCount'];
  const safe = {}; for (const key of allowed) if (details[key] !== undefined && details[key] !== null) safe[key] = String(details[key]).slice(0, 200);
  return Object.keys(safe).length ? safe : null;
}

function truncateText(value, maxBytes) {
  if (value === undefined || value === null) return value;
  const text = String(value);
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  return `${bytes.subarray(0, Math.max(0, maxBytes - 24)).toString('utf8')}… [truncated]`;
}

function compactMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(-32).map((message) => truncateText(message, WORKER_MAX_MESSAGE_BYTES));
}

function compactTurn(turn) {
  if (!turn || typeof turn !== 'object') return turn || null;
  const items = Array.isArray(turn.items) ? turn.items.slice(-64).map((item) => {
    if (!item || typeof item !== 'object') return { text: truncateText(item, WORKER_MAX_MESSAGE_BYTES) };
    const compact = { id: item.id || null, type: item.type || null, status: item.status || null, phase: item.phase || null };
    for (const key of ['text', 'output', 'aggregated_output', 'command', 'name', 'arguments']) {
      if (item[key] !== undefined) compact[key] = truncateText(typeof item[key] === 'string' ? item[key] : JSON.stringify(item[key]), WORKER_MAX_MESSAGE_BYTES);
    }
    return compact;
  }) : [];
  return { id: turn.id || null, status: turn.status || null, items };
}

export function compactWorkerResult(result) {
  if (!result || typeof result !== 'object') return result || null;
  return {
    ...result,
    output: truncateText(result.output, WORKER_MAX_OUTPUT_BYTES),
    messages: compactMessages(result.messages),
    turn: compactTurn(result.turn)
  };
}

function isMeaningfulProgressEvent(event) {
  const type = String(event?.type || '');
  if (!type || type === 'thread/tokenUsage/updated' || type === 'mcpServer/startupStatus/updated' || type === 'thread/status/changed' || type === 'warning' || type === 'worker.review_due' || type === 'worker.extended') return false;
  return type.startsWith('worker.') || type.startsWith('integration.') || type === 'thread/started' || type === 'turn/started' || type === 'turn/completed' || type.includes('item/started') || type.includes('item/completed');
}

function persistImmediately(event, task) {
  if (isTerminalTask(task)) return true;
  const type = String(event?.type || '');
  return Boolean(type) && (type.startsWith('worker.') || type.startsWith('integration.') || type === 'thread/started' || type === 'turn/started' || type === 'turn/completed');
}

function numberOption(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.trunc(parsed))) : fallback;
}

function progressEvidence(task, now, heartbeatMs, progressStaleMs = null, heartbeatStaleMs = null) {
  if (isTerminalTask(task)) return { state: 'terminal', meaningfulProgress: false, heartbeatAgeMs: null, meaningfulProgressAgeMs: null };
  const heartbeatAt = Date.parse(task?.lastHeartbeatAt || '') || 0;
  const meaningfulAt = Date.parse(task?.lastMeaningfulProgressAt || task?.lastProgressAt || '') || 0;
  const heartbeatAgeMs = heartbeatAt ? Math.max(0, now - heartbeatAt) : null;
  const meaningfulProgressAgeMs = meaningfulAt ? Math.max(0, now - meaningfulAt) : null;
  const staleHeartbeatMs = Math.max(1000, Number(heartbeatStaleMs) || Math.max(15000, heartbeatMs * 3));
  const staleProgressMs = Math.max(1000, Number(progressStaleMs) || Math.max(30000, heartbeatMs * 6));
  const state = heartbeatAgeMs === null || heartbeatAgeMs > staleHeartbeatMs ? 'stalled' : (meaningfulProgressAgeMs === null || meaningfulProgressAgeMs > staleProgressMs ? 'heartbeat_only' : 'progressing');
  return { state, meaningfulProgress: state === 'progressing', heartbeatAgeMs, meaningfulProgressAgeMs };
}

export class WorkerTaskManager {
  constructor({ env = process.env, heartbeatMs = Number(env.CWD_WORKER_HEARTBEAT_MS || WORKER_HEARTBEAT_MS), modeGuardMs = Number(env.CWD_WORKER_MODE_GUARD_MS || 500), retentionMs = numberOption(env.CWD_WORKER_TASK_RETENTION_MS, WORKER_TASK_RETENTION_MS), sweepMs = numberOption(env.CWD_WORKER_TASK_SWEEP_MS, WORKER_TASK_SWEEP_MS), persistDebounceMs = numberOption(env.CWD_WORKER_PERSIST_DEBOUNCE_MS, WORKER_PERSIST_DEBOUNCE_MS), persistMinIntervalMs = numberOption(env.CWD_WORKER_PERSIST_MIN_INTERVAL_MS, WORKER_PERSIST_MIN_INTERVAL_MS), maxRetainedTasks = numberOption(env.CWD_WORKER_MAX_RETAINED_TASKS, 500, { min: 1, max: 100000 }), autoReview = env.CWD_WORKER_AUTO_REVIEW !== '0', progressStaleMs = numberOption(env.CWD_WORKER_PROGRESS_STALE_MS, 30000, { min: 1000, max: 60 * 60 * 1000 }), heartbeatStaleMs = numberOption(env.CWD_WORKER_HEARTBEAT_STALE_MS, 15000, { min: 1000, max: 60 * 60 * 1000 }), onReview = null, onOrphan = null, now = () => Date.now() } = {}) {
    this.env = env; this.heartbeatMs = Math.max(1000, Number.isFinite(heartbeatMs) ? heartbeatMs : WORKER_HEARTBEAT_MS); this.modeGuardMs = Math.max(100, Math.min(5000, Number.isFinite(modeGuardMs) ? modeGuardMs : 500)); this.now = now;
    this.retentionMs = retentionMs; this.sweepMs = Math.max(1000, sweepMs); this.persistDebounceMs = Math.max(0, persistDebounceMs); this.persistMinIntervalMs = Math.max(this.persistDebounceMs, persistMinIntervalMs); this.maxRetainedTasks = maxRetainedTasks;
    this.autoReview = autoReview !== false; this.progressStaleMs = Math.max(1000, progressStaleMs); this.heartbeatStaleMs = Math.max(1000, heartbeatStaleMs); this.onReview = typeof onReview === 'function' ? onReview : null; this.onOrphan = typeof onOrphan === 'function' ? onOrphan : null;
    this.tasks = new Map(); this.timers = new Map(); this.modeTimers = new Map(); this.modeGuardedTasks = new Set(); this.reviewTimers = new Map(); this.writes = new Map(); this.pendingWrites = new Map(); this.writeTimers = new Map(); this.lastPersistAt = new Map(); this.runs = new Map(); this.cancelers = new Map(); this.extenders = new Map(); this.extensionLocks = new Set(); this.reviewLocks = new Set(); this.closing = false;
    this.recovery = this.#recoverPersistedTasks(); this.recovery.catch(() => {});
    this.sweepTimer = setInterval(() => { void this.cleanup().catch(() => {}); }, this.sweepMs); this.sweepTimer.unref?.();
  }

  async start(metadata, runner) {
    await this.recovery;
    if (this.closing) { const error = new Error('Worker task manager is shutting down'); error.code = 'WORKER_MANAGER_CLOSING'; throw error; }
    const createdAt = this.now(); const timeoutMs = normalizeWorkerTimeout(metadata.timeoutMs);
    const task = { taskId: `wrk_${crypto.randomUUID()}`, status: 'queued', phase: 'queued', progress: 0, message: '任务已创建，等待 Worker 启动', createdAt: iso(createdAt), startedAt: null, completedAt: null, updatedAt: iso(createdAt), lastHeartbeatAt: iso(createdAt), durationMs: null, timeoutMs, maxTotalTimeoutMs: normalizeWorkerMaxTotalTimeout(metadata.maxTotalTimeoutMs, timeoutMs), deadlineAt: null, reviewAt: null, reviewDue: false, extensionCount: 0, autoReviewCount: 0, autoExtensionCount: 0, lastReviewDecision: null, lastReviewReason: null, mode: metadata.mode, role: metadata.role, execution: metadata.execution, provider: metadata.provider, model: metadata.model, effort: metadata.effort || 'auto', profile: metadata.profile || 'standard', cwd: metadata.cwd || null, threadId: null, turnId: null, output: null, messages: [], result: null, error: null, cancelRequestedAt: null, cancelReason: null, cancelledAt: null, lastMeaningfulProgressAt: iso(createdAt), lastProgressAt: iso(createdAt), lastProgressType: null, events: [], eventSeq: 0 };
    this.tasks.set(task.taskId, task);
    const hasControlState = await fs.access(statePath(this.env)).then(() => true).catch(() => false); if (hasControlState) this.modeGuardedTasks.add(task.taskId);
    await this.#writeSnapshot(task, { immediate: true });
    const run = this.#run(task.taskId, runner).catch(async (error) => { const current = this.tasks.get(task.taskId); if (isTerminalTask(current) || isCancellationRequested(current)) return; const completedAt = this.now(); await this.#update(task.taskId, { status: isWorkerTimeout(error) ? 'timed_out' : 'failed', phase: isWorkerTimeout(error) ? 'timeout' : 'failed', message: error.message || 'Worker task failed before execution started', completedAt: iso(completedAt), error: errorDetails(error) }, { type: 'worker.manager_failed', message: error.message || 'Worker task failed before execution started' }).catch(() => {}); });
    let tracked; tracked = run.finally(() => { if (this.runs.get(task.taskId) === tracked) this.runs.delete(task.taskId); }); this.runs.set(task.taskId, tracked); void tracked.catch(() => {});
    return this.#snapshot(task);
  }

  async get(taskId) {
    await this.recovery;
    if (this.tasks.has(taskId)) { const task = this.tasks.get(taskId); if (isTerminalTask(task)) { const pendingWrite = this.writes.get(taskId); if (pendingWrite) await pendingWrite; } return this.#snapshot(this.tasks.get(taskId)); }
    let raw; try { raw = JSON.parse(await fs.readFile(workerTaskPath(this.env, taskId), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (raw.status === 'queued' || raw.status === 'starting' || raw.status === 'running') await this.#markOrphaned(raw);
    this.tasks.set(taskId, raw); return this.#snapshot(raw);
  }

  async wait(taskId, { timeoutMs = WORKER_DEFAULT_TIMEOUT_MS, pollMs = 250 } = {}) { const deadline = this.now() + timeoutMs; while (true) { const task = await this.get(taskId); if (!task) return null; if (isTerminalTask(task)) return task; const remaining = deadline - this.now(); if (remaining <= 0) return task; await sleep(Math.min(pollMs, remaining)); } }

  async cancel(taskId, reason = 'cancelled by caller') {
    const task = await this.get(taskId); if (!task || isTerminalTask(task)) return task;
    const normalizedReason = String(reason || task.cancelReason || 'cancelled by caller').trim().slice(0, 500) || 'cancelled by caller';
    const cancelRequestedAt = task.cancelRequestedAt || iso(this.now());
    // Cancellation intent is authoritative before the App Server/process stop
    // signal is delivered. The runner checks this marker before publishing
    // completed/failed, so a stop-induced exit can never race cancellation
    // into a false failure or successful completion.
    if (!task.cancelRequestedAt) {
      await this.#update(taskId, { phase: 'cancelling', message: `正在取消 Worker：${normalizedReason}`, cancelRequestedAt, cancelReason: normalizedReason }, { type: 'worker.cancel_requested', message: `正在取消 Worker：${normalizedReason}` });
    }
    const canceler = this.cancelers.get(taskId);
    if (canceler) await invokeWithin(canceler, normalizedReason);
    const current = this.tasks.get(taskId); if (!current || isTerminalTask(current)) return this.get(taskId);
    const completedAt = iso(this.now());
    await this.#update(taskId, { status: 'cancelled', phase: 'cancelled', message: `Worker 已取消：${normalizedReason}`, completedAt, cancelledAt: completedAt, cancelRequestedAt, cancelReason: current.cancelReason || normalizedReason, durationMs: current.startedAt ? Math.max(0, this.now() - Date.parse(current.startedAt)) : null, error: { name: 'WorkerCancelledError', code: 'WORKER_CANCELLED', message: current.cancelReason || normalizedReason, method: null, data: null } }, { type: 'worker.cancelled', message: `Worker 已取消：${current.cancelReason || normalizedReason}` });
    return this.get(taskId);
  }

  async cancelAll(reason = 'cancelled by control plane') { const ids = [...this.tasks.values()].filter((task) => !isTerminalTask(task)).map((task) => task.taskId); return Promise.all(ids.map((taskId) => this.cancel(taskId, reason))); }

  async cleanup() {
    await this.recovery;
    const cutoff = this.now() - this.retentionMs;
    let removed = 0;
    const canRemove = (task) => isTerminalTask(task) && !this.runs.has(task.taskId) && !this.writes.has(task.taskId) && !this.pendingWrites.has(task.taskId);
    const ageOf = (task) => Date.parse(task?.completedAt || task?.updatedAt || task?.createdAt || '') || 0;
    const removeMemoryTask = async (task) => {
      if (!canRemove(task) || ageOf(task) > cutoff) return false;
      this.tasks.delete(task.taskId); this.lastPersistAt.delete(task.taskId); await fs.rm(workerTaskPath(this.env, task.taskId), { force: true }); removed += 1; return true;
    };
    for (const task of [...this.tasks.values()]) await removeMemoryTask(task);
    const entries = await fs.readdir(workerTasksDir(this.env), { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : (() => { throw error; })());
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const taskId = entry.name.slice(0, -5); if (this.tasks.has(taskId)) continue;
      let raw; try { raw = JSON.parse(await fs.readFile(workerTaskPath(this.env, taskId), 'utf8')); } catch { continue; }
      if (raw.status === 'queued' || raw.status === 'starting' || raw.status === 'running') await this.#markOrphaned(raw);
      if (isTerminalTask(raw) && ageOf(raw) <= cutoff) continue;
      if (isTerminalTask(raw)) { await fs.rm(workerTaskPath(this.env, taskId), { force: true }); removed += 1; }
    }
    const retained = [...this.tasks.values()].filter((task) => isTerminalTask(task)).sort((a, b) => ageOf(b) - ageOf(a));
    for (const task of retained.slice(this.maxRetainedTasks)) await removeMemoryTask({ ...task, completedAt: new Date(0).toISOString() });
    return { removed, retainedTasks: this.tasks.size };
  }

  async extend(taskId, { extraMs, reason = '主控确认 Worker 方向正确，续期继续执行', automatic = false, grace = false } = {}) {
    const task = await this.get(taskId); if (!task || isTerminalTask(task)) return task;
    if (this.extensionLocks.has(taskId)) { const error = new Error('Worker extension is already being processed'); error.code = 'WORKER_EXTENSION_IN_PROGRESS'; throw error; }
    if (!task.reviewDue) { const error = new Error('Worker extension is only allowed at the scheduled main-control review point'); error.code = 'WORKER_REVIEW_NOT_DUE'; throw error; }
    const normalizedExtraMs = normalizeWorkerExtension(extraMs); const startedAt = Date.parse(task.startedAt || '') || this.now(); const hardDeadline = startedAt + Math.min(Number(task.maxTotalTimeoutMs) || WORKER_MAX_TOTAL_TIMEOUT_MS, WORKER_MAX_TOTAL_TIMEOUT_MS); const currentDeadline = Date.parse(task.deadlineAt || '') || (startedAt + task.timeoutMs); const acceptedExtraMs = Math.min(normalizedExtraMs, Math.max(0, hardDeadline - currentDeadline));
    if (acceptedExtraMs < 1000) { const error = new Error('Worker reached its maximum total runtime and cannot be extended'); error.code = 'WORKER_MAX_TOTAL_TIMEOUT'; throw error; }
    const extender = this.extenders.get(taskId); if (!extender) { const error = new Error('Worker execution is not currently extendable'); error.code = 'WORKER_EXTENSION_UNAVAILABLE'; throw error; }
    this.extensionLocks.add(taskId);
    try { await extender(acceptedExtraMs); const deadlineAt = currentDeadline + acceptedExtraMs; const reviewAt = deadlineAt - reviewLeadMs(acceptedExtraMs); const normalizedReason = String(reason || '主控确认 Worker 方向正确，续期继续执行').trim().slice(0, 500) || '主控确认 Worker 方向正确，续期继续执行'; const updated = await this.#update(taskId, { phase: 'running', message: automatic ? (grace ? `主控自动观察给予一次心跳宽限，Worker 已续期 ${durationLabel(acceptedExtraMs)}` : `主控自动观察确认有实质进展，Worker 已续期 ${durationLabel(acceptedExtraMs)}`) : `主控已确认方向正常，Worker 已续期 ${durationLabel(acceptedExtraMs)}`, deadlineAt: iso(deadlineAt), reviewAt: iso(reviewAt), reviewDue: false, extensionCount: (Number(task.extensionCount) || 0) + 1, autoExtensionCount: automatic ? (Number(task.autoExtensionCount) || 0) + 1 : task.autoExtensionCount, autoReviewCount: automatic ? (Number(task.autoReviewCount) || 0) + 1 : task.autoReviewCount, lastReviewDecision: automatic ? 'extended' : 'manual_extended', lastReviewReason: normalizedReason }, { type: 'worker.extended', message: automatic ? '主控自动观察后续期 Worker' : '主控确认后续期 Worker', details: { extraMs: acceptedExtraMs, reason: normalizedReason, deadlineAt: iso(deadlineAt), reviewAt: iso(reviewAt), automatic, grace } }); this.#scheduleReview(taskId, reviewAt); return updated; }
    finally { this.extensionLocks.delete(taskId); }
  }

  async close(reason = 'control plane closed') {
    await this.recovery;
    if (this.closing) { await settleWithin([...this.runs.values(), ...this.writes.values()]); return; }
    this.closing = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer); this.sweepTimer = null;
    for (const timer of this.timers.values()) clearInterval(timer); this.timers.clear(); for (const timer of this.modeTimers.values()) clearInterval(timer); this.modeTimers.clear(); this.modeGuardedTasks.clear(); for (const timer of this.reviewTimers.values()) clearTimeout(timer); this.reviewTimers.clear();
    for (const timer of this.writeTimers.values()) clearTimeout(timer); this.writeTimers.clear();
    await this.cancelAll(reason).catch(() => {}); await settleWithin([...this.runs.values()]); await Promise.all([...this.pendingWrites.keys()].map((taskId) => this.#flushWrite(taskId).catch(() => {}))); await settleWithin([...this.writes.values()]); this.cancelers.clear(); this.extenders.clear(); this.extensionLocks.clear(); this.reviewLocks.clear();
  }

  async #run(taskId, runner) {
    if (isTerminalTask(this.tasks.get(taskId))) return;
    const startedAt = this.now(); const started = await this.#update(taskId, { status: 'running', phase: 'starting', progress: 5, message: 'Worker 已启动，正在连接 Codex App Server', startedAt: iso(startedAt), lastHeartbeatAt: iso(startedAt), lastProgressAt: iso(startedAt), deadlineAt: iso(startedAt + this.tasks.get(taskId).timeoutMs), reviewAt: iso(startedAt + this.tasks.get(taskId).timeoutMs - reviewLeadMs(this.tasks.get(taskId).timeoutMs)), reviewDue: false }, { type: 'worker.started', message: 'Worker 已启动' });
    if (!started || isTerminalTask(started)) return;
    this.#scheduleReview(taskId, Date.parse(started.reviewAt)); const heartbeat = setInterval(() => { void this.#update(taskId, { lastHeartbeatAt: iso(this.now()), message: 'Worker 仍在运行，等待下一阶段结果' }).catch(() => {}); }, this.heartbeatMs); this.timers.set(taskId, heartbeat);
    if (this.modeGuardedTasks.has(taskId)) { const modeTimer = setInterval(() => { void this.#enforceControlMode(taskId).catch(() => {}); }, this.modeGuardMs); this.modeTimers.set(taskId, modeTimer); }
    try { const result = await runner({ taskId, report: (patch = {}) => this.#update(taskId, { ...patch, lastHeartbeatAt: iso(this.now()) }, patch.event || null), heartbeat: () => this.#update(taskId, { lastHeartbeatAt: iso(this.now()) }), registerCancel: (handler) => this.#registerCancel(taskId, handler), registerExtend: (handler) => this.#registerExtend(taskId, handler) }); const current = this.tasks.get(taskId); if (isTerminalTask(current) || isCancellationRequested(current)) return; const completedAt = this.now(); const compact = compactWorkerResult(result); await this.#update(taskId, { status: 'completed', phase: 'completed', progress: 100, message: 'Worker 已完成并返回结果', completedAt: iso(completedAt), durationMs: Math.max(0, completedAt - startedAt), threadId: compact?.threadId || current?.threadId || null, turnId: compact?.turn?.id || current?.turnId || null, output: compact?.output || '', messages: Array.isArray(compact?.messages) ? compact.messages : [], result: compact }, { type: 'worker.completed', message: 'Worker 已完成' }); }
    catch (error) { const current = this.tasks.get(taskId); if (isTerminalTask(current) || isCancellationRequested(current)) return; const completedAt = this.now(); const timedOut = isWorkerTimeout(error); await this.#update(taskId, { status: timedOut ? 'timed_out' : 'failed', phase: timedOut ? 'timeout' : 'failed', progress: Math.min(current?.progress || 0, 95), message: timedOut ? 'Worker 超时；任务未返回完成事件' : 'Worker 执行失败', completedAt: iso(completedAt), durationMs: Math.max(0, completedAt - startedAt), error: errorDetails(error) }, { type: timedOut ? 'worker.timeout' : 'worker.failed', message: timedOut ? 'Worker 超时' : 'Worker 执行失败' }); }
    finally { clearInterval(heartbeat); this.timers.delete(taskId); const modeTimer = this.modeTimers.get(taskId); if (modeTimer) clearInterval(modeTimer); this.modeTimers.delete(taskId); this.modeGuardedTasks.delete(taskId); const reviewTimer = this.reviewTimers.get(taskId); if (reviewTimer) clearTimeout(reviewTimer); this.reviewTimers.delete(taskId); this.extenders.delete(taskId); }
  }

  async #recoverPersistedTasks() {
    const entries = await fs.readdir(workerTasksDir(this.env), { withFileTypes: true }).catch((error) => error.code === 'ENOENT' ? [] : (() => { throw error; })());
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const taskId = entry.name.slice(0, -5); if (this.tasks.has(taskId)) continue;
      let raw; try { raw = JSON.parse(await fs.readFile(workerTaskPath(this.env, taskId), 'utf8')); } catch { continue; }
      if (raw.status === 'queued' || raw.status === 'starting' || raw.status === 'running') await this.#markOrphaned(raw);
    }
  }

  async #markOrphaned(task) {
    if (!task || isTerminalTask(task)) return task;
    const now = this.now(); const completedAt = iso(now); const message = '控制面重启后无法继续原 Worker 进程';
    task.status = 'failed'; task.phase = 'orphaned'; task.message = message; task.error = { name: 'WorkerTaskOrphanedError', code: 'CONTROL_PLANE_RESTART', message, method: null, data: null }; task.completedAt = completedAt; task.updatedAt = completedAt; task.durationMs = task.startedAt ? Math.max(0, now - Date.parse(task.startedAt)) : null; task.lastProgressAt = completedAt;
    task.eventSeq = Number(task.eventSeq) || 0; task.events = Array.isArray(task.events) ? task.events : []; task.eventSeq += 1; task.events.push({ seq: task.eventSeq, at: completedAt, type: 'worker.orphaned', message, phase: task.phase, progress: task.progress || 0, details: { code: 'CONTROL_PLANE_RESTART' } }); if (task.events.length > WORKER_EVENT_LIMIT) task.events.splice(0, task.events.length - WORKER_EVENT_LIMIT);
    await this.#writeSnapshot(task, { immediate: true });
    if (this.onOrphan) await Promise.resolve(this.onOrphan({ task: this.#snapshot(task), reason: message })).catch(() => {});
    return task;
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
  #scheduleReview(taskId, reviewAt) { const previous = this.reviewTimers.get(taskId); if (previous) clearTimeout(previous); const delay = Math.max(0, Number(reviewAt) - this.now()); const timer = setTimeout(() => { this.reviewTimers.delete(taskId); void this.#markReviewDue(taskId).catch(() => {}); }, delay); timer.unref?.(); this.reviewTimers.set(taskId, timer); }
  async #markReviewDue(taskId) { const task = this.tasks.get(taskId); if (!task || isTerminalTask(task) || task.reviewDue) return; if (Date.parse(task.deadlineAt || '') <= this.now()) return; const marked = await this.#update(taskId, { phase: 'review', reviewDue: true, message: this.autoReview ? '已到主控自动观察点：正在检查心跳、实质进展和续期边界' : '已到主控观察点：请检查 Worker 进度、方向和安全性后续期或终止' }, { type: 'worker.review_due', message: this.autoReview ? '主控自动观察 Worker 进度' : '等待主控观察后决定续期或终止', details: { reviewAt: task.reviewAt, deadlineAt: task.deadlineAt, automatic: this.autoReview } }); if (marked?.reviewDue && this.autoReview) await this.#superviseReview(taskId); }

  async #superviseReview(taskId) {
    if (this.reviewLocks.has(taskId)) return this.get(taskId);
    this.reviewLocks.add(taskId);
    try {
      const task = await this.get(taskId); if (!task || isTerminalTask(task) || !task.reviewDue) return task;
      const mode = await this.#readControlMode(taskId);
      if (mode === 'MAIN' || mode === 'INVALID' || mode === 'MISSING') return this.#autoCancel(taskId, mode === 'MAIN' ? '主控自动观察：MAIN 模式已锁定，立即冻结 Worker' : '主控自动观察：控制状态不可用，安全终止 Worker');
      const evidence = progressEvidence(task, this.now(), this.heartbeatMs, this.progressStaleMs, this.heartbeatStaleMs);
      const initial = Number(task.timeoutMs) || WORKER_DEFAULT_TIMEOUT_MS;
      const hardTotal = Math.min(Number(task.maxTotalTimeoutMs) || WORKER_MAX_TOTAL_TIMEOUT_MS, WORKER_MAX_TOTAL_TIMEOUT_MS);
      const extensionMs = task.profile === 'quick' ? WORKER_QUICK_AUTO_EXTENSION_MS : WORKER_STANDARD_AUTO_EXTENSION_MS;
      const maxAutoExtensions = Math.max(0, Math.ceil(Math.max(0, hardTotal - initial) / extensionMs));
      const currentDeadline = Date.parse(task.deadlineAt || '') || (Date.parse(task.startedAt || '') + initial);
      const hardDeadline = (Date.parse(task.startedAt || '') || this.now()) + hardTotal;
      const remaining = Math.max(0, hardDeadline - currentDeadline);
      const heartbeatGrace = evidence.state === 'heartbeat_only' && Boolean(task.lastProgressType) && task.lastProgressType !== 'worker.started' && Number(task.autoReviewCount) === 0;
      if ((evidence.state === 'progressing' || heartbeatGrace) && Number(task.autoExtensionCount) < maxAutoExtensions && remaining >= 1000 && this.extenders.has(taskId)) {
        const accepted = Math.min(extensionMs, remaining);
        const reason = heartbeatGrace
          ? `主控自动观察：已进入真实执行阶段且心跳正常，暂时没有新事件，给予一次有界观察宽限；下一次仍无实质进展将终止`
          : `主控自动观察：${task.profile === 'quick' ? 'quick' : 'standard'} 任务有近期实质进展且心跳正常，自动续期；总时长仍受硬上限约束`;
        try {
          const extended = await this.extend(taskId, { extraMs: accepted, reason, automatic: true, grace: heartbeatGrace });
          await this.#notifyReview(extended, { decision: 'extended', evidence, reason, extensionMs: accepted, grace: heartbeatGrace });
          return extended;
        } catch (error) {
          if (error?.code === 'WORKER_EXTENSION_IN_PROGRESS' || error?.code === 'WORKER_REVIEW_NOT_DUE') return this.get(taskId);
          return this.#autoCancel(taskId, `主控自动观察：续期通道失败（${error?.code || error?.message || 'unknown error'}），安全终止 Worker`, evidence);
        }
      }
      let reason;
      if (evidence.state === 'stalled') reason = '主控自动观察：Worker 心跳已失效，安全终止以避免黑箱占用';
      else if (evidence.state === 'heartbeat_only') reason = '主控自动观察：已用过一次心跳宽限，仍然没有近期实质进展，安全终止以避免黑箱占用';
      else if (!this.extenders.has(taskId)) reason = '主控自动观察：Worker 续期通道不可用，安全终止以避免失控';
      else reason = '主控自动观察：已达到自动续期上限，安全终止以保持有界执行';
      return this.#autoCancel(taskId, reason, evidence);
    } finally { this.reviewLocks.delete(taskId); }
  }

  async #autoCancel(taskId, reason, evidence = null) {
    const task = await this.get(taskId); if (!task || isTerminalTask(task)) return task;
    const autoReviewCount = (Number(task.autoReviewCount) || 0) + 1;
    const marked = await this.#update(taskId, { autoReviewCount, lastReviewDecision: 'cancelled', lastReviewReason: reason }, { type: 'worker.auto_review', message: reason, details: { decision: 'cancelled', automatic: true, evidence: evidence?.state || 'control_guard', heartbeatAgeMs: evidence?.heartbeatAgeMs, meaningfulProgressAgeMs: evidence?.meaningfulProgressAgeMs, autoReviewCount } }).catch(() => task);
    const cancelled = await this.cancel(taskId, reason);
    await this.#notifyReview(cancelled || marked, { decision: 'cancelled', evidence, reason });
    return cancelled || marked;
  }

  async #notifyReview(task, details) {
    if (!this.onReview || !task) return;
    try { await this.onReview({ task: this.#snapshot(task), ...details, automatic: true }); } catch { /* audit hooks must never change task control decisions */ }
  }

  async #readControlMode(taskId) {
    if (!this.modeGuardedTasks.has(taskId)) return null;
    try { const state = JSON.parse(await fs.readFile(statePath(this.env), 'utf8')); return ['AUTO', 'DELEGATE', 'MAIN'].includes(state?.mode) ? state.mode : 'INVALID'; }
    catch { return 'MISSING'; }
  }

  async #update(taskId, patch = {}, event = null) {
    const task = this.tasks.get(taskId); if (!task) return null; if (isTerminalTask(task)) return this.#snapshot(task);
    for (const key of ['status', 'phase', 'progress', 'message', 'startedAt', 'completedAt', 'updatedAt', 'lastHeartbeatAt', 'durationMs', 'threadId', 'turnId', 'output', 'messages', 'result', 'error', 'cancelRequestedAt', 'cancelReason', 'cancelledAt', 'lastProgressAt', 'lastMeaningfulProgressAt', 'lastProgressType', 'deadlineAt', 'reviewAt', 'reviewDue', 'extensionCount', 'autoReviewCount', 'autoExtensionCount', 'lastReviewDecision', 'lastReviewReason']) if (patch[key] !== undefined) task[key] = patch[key];
    if (event) {
      const at = iso(this.now()); task.eventSeq += 1; task.events.push({ seq: task.eventSeq, at, type: event.type || 'worker.progress', message: event.message || task.message, phase: task.phase, progress: task.progress, details: safeEventDetails(event.details) });
      if (task.events.length > WORKER_EVENT_LIMIT) task.events.splice(0, task.events.length - WORKER_EVENT_LIMIT);
      if (isMeaningfulProgressEvent(event)) { task.lastMeaningfulProgressAt = at; task.lastProgressAt = at; task.lastProgressType = event.type || 'worker.progress'; }
    }
    task.updatedAt = iso(this.now()); await this.#writeSnapshot(task, { immediate: persistImmediately(event, task) }); return this.#snapshot(task);
  }

  #snapshot(task) { if (!task) return null; const snapshot = structuredClone(task); snapshot.progressEvidence = progressEvidence(snapshot, this.now(), this.heartbeatMs, this.progressStaleMs, this.heartbeatStaleMs); return snapshot; }

  async #writeSnapshot(task, { immediate = false } = {}) {
    const snapshot = structuredClone(task); const taskId = snapshot.taskId; let pending = this.pendingWrites.get(taskId);
    if (!pending) { pending = { snapshot, waiters: [] }; this.pendingWrites.set(taskId, pending); } else pending.snapshot = snapshot;
    if (immediate) { const timer = this.writeTimers.get(taskId); if (timer) clearTimeout(timer); this.writeTimers.delete(taskId); return this.#flushWrite(taskId); }
    if (!this.writeTimers.has(taskId)) {
      const elapsed = this.now() - (this.lastPersistAt.get(taskId) || 0); const delay = Math.max(this.persistDebounceMs, this.persistMinIntervalMs - elapsed);
      const timer = setTimeout(() => { this.writeTimers.delete(taskId); void this.#flushWrite(taskId).catch(() => {}); }, delay); timer.unref?.(); this.writeTimers.set(taskId, timer);
    }
    return new Promise((resolve, reject) => { pending.waiters.push({ resolve, reject }); });
  }

  async #flushWrite(taskId) {
    const pending = this.pendingWrites.get(taskId); if (!pending) return true;
    this.pendingWrites.delete(taskId);
    const previous = this.writes.get(taskId) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.#persist(pending.snapshot)).then(() => { this.lastPersistAt.set(taskId, this.now()); });
    const tracked = next.finally(() => { if (this.writes.get(taskId) === tracked) this.writes.delete(taskId); }); this.writes.set(taskId, tracked);
    try { await tracked; for (const waiter of pending.waiters) waiter.resolve(true); return true; }
    catch (error) { for (const waiter of pending.waiters) waiter.reject(error); throw error; }
  }

  async #persist(task) { const directory = workerTasksDir(this.env); const file = workerTaskPath(this.env, task.taskId); await fs.mkdir(directory, { recursive: true, mode: 0o700 }); const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`; let handle; try { handle = await fs.open(temporary, 'wx', 0o600); await handle.writeFile(`${JSON.stringify(task, null, 2)}\n`); await handle.sync(); await handle.close(); handle = null; await fs.rename(temporary, file); await fs.chmod(file, 0o600).catch(() => {}); const directoryHandle = await fs.open(directory, 'r'); try { await directoryHandle.sync(); } finally { await directoryHandle.close(); } } finally { if (handle) await handle.close().catch(() => {}); await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); } }
}
