import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 15000;
const REASONING_EFFORTS = new Set(['auto', 'none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const SANDBOX_ALIASES = new Map([
  ['read-only', 'read-only'], ['readonly', 'read-only'], ['readOnly', 'read-only'],
  ['workspace-write', 'workspace-write'], ['workspacewrite', 'workspace-write'], ['workspaceWrite', 'workspace-write'],
  ['danger-full-access', 'danger-full-access'], ['dangerfullaccess', 'danger-full-access'], ['dangerFullAccess', 'danger-full-access']
]);

export function normalizeSandboxMode(value = 'workspace-write') {
  const normalized = SANDBOX_ALIASES.get(String(value));
  if (!normalized) throw new Error(`Unsupported Codex sandbox mode: ${value}`);
  return normalized;
}

function jsonText(value, maxLength = 8000) {
  if (value === undefined) return '';
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value); }
  catch { text = String(value); }
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export class CodexAppServerError extends Error {
  constructor({ method, error, stderr = '' }) {
    const code = error?.code === undefined ? '' : ` (code ${error.code})`;
    const message = error?.message || 'unknown Codex App Server error';
    const data = error?.data === undefined ? '' : ` data=${jsonText(error.data)}`;
    const diagnostics = stderr.trim() ? ` stderr=${stderr.trim().slice(-4000)}` : '';
    super(`Codex App Server request failed: ${method}${code}: ${message}${data}${diagnostics}`);
    this.name = 'CodexAppServerError';
    this.method = method;
    this.code = error?.code;
    this.data = error?.data;
    this.rpcError = error;
    this.stderr = stderr;
  }
}

export function codexBinaryCandidates(env = process.env) {
  const explicit = [env.CODEX_CLI_PATH, env.CODEX_BIN].filter(Boolean);
  const home = env.HOME || os.homedir();
  return [
    ...explicit,
    '/usr/lib/chatgpt/resources/codex',
    path.join(home, '.local', 'bin', 'codex'),
    path.join(home, '.codex', 'bin', 'codex'),
    path.join(home, '.codex', 'packages', 'standalone', 'current', 'bin', 'codex'),
    path.join(home, '.codex', 'packages', 'standalone', 'current', 'codex')
  ];
}

export function resolveCodexBinary(env = process.env) {
  for (const candidate of codexBinaryCandidates(env)) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  const probe = spawnSync('sh', ['-lc', 'command -v codex'], { encoding: 'utf8', env });
  const discovered = probe.status === 0 ? probe.stdout.trim() : '';
  return discovered || 'codex';
}

export class CodexAppServerClient {
  constructor({ env = process.env, binary = resolveCodexBinary(env), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.env = env;
    this.binary = binary;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationWaiters = [];
    this.pendingTurnExtensionMs = 0;
    this.notificationListeners = new Set();
    this.stderr = '';
    this.buffer = '';
    this.process = null;
  }

  async start() {
    if (this.process) return this;
    const child = spawn(this.binary, ['app-server', '--stdio'], { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.process = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#feed(chunk));
    child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-12000); });
    child.on('error', (error) => this.#failAll(error));
    child.on('exit', (code, signal) => {
      if (code !== 0 || signal) {
        const error = new Error(`codex app-server exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}: ${this.stderr.trim()}`);
        error.code = 'CODEX_APP_SERVER_EXITED';
        error.signal = signal || null;
        this.#failAll(error);
      }
      this.process = null;
    });
    await this.request('initialize', {
      clientInfo: { name: 'codex_worker_delegation', title: 'Codex Worker Delegation', version: '3.0.0' },
      capabilities: { experimentalApi: true }
    });
    this.notify('initialized', {});
    return this;
  }

  async close() {
    this.#terminate(new Error('codex app-server closed'));
  }

  abort(reason = 'Worker cancelled') {
    const error = new Error(String(reason || 'Worker cancelled'));
    error.code = 'WORKER_CANCELLED';
    this.#terminate(error);
  }

  #terminate(error) {
    const child = this.process;
    this.process = null;
    if (!child) return;
    this.#failAll(error);
    try { child.stdin.end(); } catch {}
    if (!child.killed) child.kill('SIGTERM');
  }

  notify(method, params = {}) {
    if (!this.process) throw new Error('codex app-server is not running');
    this.process.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  request(method, params = {}, timeoutMs = this.timeoutMs) {
    if (!this.process) return Promise.reject(new Error('codex app-server is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`codex app-server request timed out: ${method}`);
        error.code = 'CODEX_REQUEST_TIMEOUT';
        error.method = method;
        error.timeoutMs = timeoutMs;
        reject(error);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.process.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  waitForNotification(method, predicate = () => true, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const extensionMs = method === 'turn/completed' ? this.pendingTurnExtensionMs : 0;
      if (method === 'turn/completed') this.pendingTurnExtensionMs = 0;
      const waiter = { method, predicate, resolve, reject, timer: null, deadlineAt: Date.now() + timeoutMs + extensionMs, baseTimeoutMs: timeoutMs };
      this.#armNotificationWaiter(waiter);
      this.notificationWaiters.push(waiter);
    });
  }

  extendTurnTimeout(extraMs) {
    const parsed = Number(extraMs);
    if (!Number.isFinite(parsed) || parsed < 1000) throw new Error('extraMs must be at least 1000 milliseconds');
    const added = Math.trunc(parsed);
    const waiter = this.notificationWaiters.find((candidate) => candidate.method === 'turn/completed');
    if (!waiter) {
      this.pendingTurnExtensionMs += added;
      return { extraMs: added, pending: true, deadlineAt: null };
    }
    waiter.deadlineAt = Math.max(Date.now(), waiter.deadlineAt) + added;
    this.#armNotificationWaiter(waiter);
    return { extraMs: added, pending: false, deadlineAt: new Date(waiter.deadlineAt).toISOString() };
  }

  subscribeNotifications(listener) {
    if (typeof listener !== 'function') return () => {};
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  async getAccount({ refreshToken = false } = {}) { return this.request('account/read', { refreshToken }); }

  async listModels({ includeHidden = false } = {}) {
    const all = []; let cursor = null;
    do {
      const response = await this.request('model/list', { cursor, limit: 100, includeHidden });
      all.push(...(response?.data || []));
      cursor = response?.nextCursor || null;
    } while (cursor);
    return all;
  }

  async runThread({ model, modelProvider, prompt, cwd = process.cwd(), sandbox = 'workspace-write', developerInstructions, effort = 'auto', timeoutMs = 180000, onProgress }) {
    if (!model) throw new Error('model is required');
    if (!modelProvider) throw new Error('modelProvider is required');
    if (!prompt?.trim()) throw new Error('prompt is required');
    if (!REASONING_EFFORTS.has(effort)) throw new Error(`unsupported reasoning effort: ${effort}`);
    const started = await this.request('thread/start', {
      model,
      modelProvider,
      cwd,
      sandbox: normalizeSandboxMode(sandbox),
      approvalPolicy: 'never',
      ephemeral: true,
      serviceName: 'codex-worker-delegation',
      ...(developerInstructions ? { developerInstructions } : {})
    });
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error(`thread/start did not return a thread id: ${JSON.stringify(started)}`);
    const emit = (message) => {
      if (typeof onProgress !== 'function') return;
      try { Promise.resolve(onProgress(message)).catch(() => {}); } catch {}
    };
    const unsubscribe = this.subscribeNotifications((message) => {
      if (message?.params?.threadId === threadId) emit(message);
    });
    try {
      emit({ method: 'thread/started', params: { threadId, model, modelProvider } });
      const completion = this.waitForNotification('turn/completed', (params) => params?.threadId === threadId, timeoutMs);
      const turnStarted = await this.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: String(prompt), text_elements: [] }],
        ...(effort !== 'auto' ? { effort } : {})
      });
      emit({ method: 'turn/started', params: { threadId, turn: turnStarted?.turn || null } });
      const params = await completion;
      const items = params?.turn?.items || [];
      const messages = items.filter((item) => item?.type === 'agentMessage' && typeof item.text === 'string').map((item) => item.text);
      return {
        threadId,
        model: started?.model || model,
        modelProvider: started?.modelProvider || modelProvider,
        effort,
        status: params?.turn?.status || 'completed',
        output: messages.at(-1) || '',
        messages,
        turn: params?.turn || null
      };
    } finally {
      unsubscribe();
    }
  }

  #feed(chunk) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.method) {
        for (const listener of this.notificationListeners) {
          try { listener(message); } catch {}
        }
      }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new CodexAppServerError({ method: pending.method, error: message.error, stderr: this.stderr }));
        else pending.resolve(message.result);
        continue;
      }
      if (!message.method) continue;
      const survivors = [];
      for (const waiter of this.notificationWaiters) {
        if (waiter.method === message.method && waiter.predicate(message.params)) {
          clearTimeout(waiter.timer); waiter.resolve(message.params);
        } else survivors.push(waiter);
      }
      this.notificationWaiters = survivors;
    }
  }

  #armNotificationWaiter(waiter) {
    clearTimeout(waiter.timer);
    const remaining = Math.max(0, waiter.deadlineAt - Date.now());
    waiter.timer = setTimeout(() => {
      this.notificationWaiters = this.notificationWaiters.filter((candidate) => candidate !== waiter);
      const error = new Error(`timed out waiting for ${waiter.method}`);
      error.code = waiter.method === 'turn/completed' ? 'CODEX_TURN_TIMEOUT' : 'CODEX_NOTIFICATION_TIMEOUT';
      error.method = waiter.method;
      error.timeoutMs = waiter.baseTimeoutMs;
      error.deadlineAt = new Date(waiter.deadlineAt).toISOString();
      waiter.reject(error);
    }, remaining);
  }

  #failAll(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const waiter of this.notificationWaiters) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.notificationWaiters = [];
    this.pendingTurnExtensionMs = 0;
  }
}

export async function withCodexAppServer(fn, options = {}) {
  const { overallTimeoutMs = 0, ...clientOptions } = options;
  const client = new CodexAppServerClient(clientOptions);
  let timedOut = false;
  const deadline = Number(overallTimeoutMs);
  const runWithDeadline = async (operation, label) => {
    if (!Number.isFinite(deadline) || deadline <= 0) return operation;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        const error = new Error(`Codex App Server ${label} timed out after ${deadline}ms`);
        error.code = 'CODEX_APP_SERVER_OVERALL_TIMEOUT';
        error.timeoutMs = deadline;
        error.phase = label;
        reject(error);
      }, deadline);
      Promise.resolve(operation).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
  };
  try {
    await runWithDeadline(client.start(), 'startup');
    return await runWithDeadline(Promise.resolve().then(() => fn(client)), 'operation');
  } finally {
    if (timedOut) client.abort('Codex App Server overall timeout');
    else await client.close();
  }
}
