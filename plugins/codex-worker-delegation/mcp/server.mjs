#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TERMINAL = new Set(['completed', 'failed', 'timed_out', 'cancelled', 'delegation_required']);
const DEFAULT_WAIT_MS = 170000;
const POLL_MS = 1000;

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { buffer += chunk; drain(); });

function drain() {
  while (true) {
    const i = buffer.indexOf('\n');
    if (i < 0) return;
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (line) {
      let message;
      try { message = JSON.parse(line); } catch (error) { continue; }
      handle(message).catch((error) => reply(message.id, null, { code: -32603, message: error.message }));
    }
  }
}

async function handle(msg) {
  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'codex-worker-delegation', version: '3.0.0' } });
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'tools/list') return reply(msg.id, { tools: [
    { name: 'delegation_status', description: 'Read current Web-controlled delegation mode and redacted provider/model routing.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'delegate_worker', description: 'Start the Web-selected Worker or Verifier and return its task ID, live state, heartbeat, progress events, and result. Under MAIN the server rejects delegation; if the task is still running, call worker_status. At reviewDue=true, inspect the task and call worker_extend or worker_cancel from root control.', inputSchema: { type: 'object', properties: { task: { type: 'string' }, role: { type: 'string', enum: ['worker', 'verifier'] }, cwd: { type: 'string' }, mode: { type: 'string', enum: ['AUTO', 'DELEGATE', 'MAIN'] }, timeoutMs: { type: 'number', minimum: 1000, maximum: 900000 }, waitMs: { type: 'number', minimum: 0, maximum: 170000 } }, required: ['task'], additionalProperties: false } },
    { name: 'worker_status', description: 'Read a Worker or Verifier task by task ID, including status, phase, progress, last heartbeat, last progress event, event history, error, and result.', inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false } },
    { name: 'worker_extend', description: 'Root-control action: after worker_status reports reviewDue=true and the work is demonstrably on scope and safe, extend that one Worker or Verifier lease. The extension is bounded by the hard total runtime cap and is not exposed as a Web user action.', inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, extraMs: { type: 'number', minimum: 1000, maximum: 900000 }, reason: { type: 'string', maxLength: 500 } }, required: ['taskId'], additionalProperties: false } },
    { name: 'worker_cancel', description: 'Root-control action: cancel one running Worker or Verifier task by task ID after inspecting worker_status. This terminates only that task App Server, is idempotent for terminal tasks, and is not exposed as a Web user action.', inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, reason: { type: 'string', maxLength: 500 } }, required: ['taskId'], additionalProperties: false } }
  ] });
  if (msg.method === 'tools/call' && msg.params?.name === 'delegation_status') {
    const current = await state();
    return toolReply(msg.id, { mode: current.mode, routing: current.routing || null, provider: current.provider && { name: current.provider.name, baseUrl: current.provider.baseUrl, protocol: current.provider.protocol }, protocolCache: current.protocolCache, installed: Boolean(current.installed) });
  }
  if (msg.method === 'tools/call' && msg.params?.name === 'delegate_worker') return toolReply(msg.id, await delegateWorker(msg.params?.arguments || {}));
  if (msg.method === 'tools/call' && msg.params?.name === 'worker_status') return toolReply(msg.id, await workerStatus(msg.params?.arguments || {}));
  if (msg.method === 'tools/call' && msg.params?.name === 'worker_extend') return toolReply(msg.id, await workerExtend(msg.params?.arguments || {}));
  if (msg.method === 'tools/call' && msg.params?.name === 'worker_cancel') return toolReply(msg.id, await workerCancel(msg.params?.arguments || {}));
  if (msg.id !== undefined) return reply(msg.id, null, { code: -32601, message: 'method not found' });
}

function toolReply(id, value) { return reply(id, { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }); }
function reply(id, result, error) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }) + '\n'); }
function baseDir() { return process.env.CWD_DATA_DIR || (process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')) + '/codex-worker-delegation'; }
async function state() { try { return JSON.parse(await fs.readFile(path.join(baseDir(), 'state.json'), 'utf8')); } catch { return { mode: 'AUTO', routing: null, provider: null, protocolCache: {}, installed: false }; } }
async function token() { return (await fs.readFile(path.join(baseDir(), 'gateway.token'), 'utf8')).trim(); }
function port() { return Number(process.env.CWD_PORT || 8788); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function requestJson(url, options = {}, timeoutMs = 10000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.error || `worker request failed (${response.status})`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function flattenCompleted(task, waitedMs) {
  if (task?.status !== 'completed' || !task.result) return { ...task, waitedMs, waitingTimedOut: !TERMINAL.has(task?.status), waitingReason: task?.reviewDue ? 'review_due' : (!TERMINAL.has(task?.status) ? 'poll_window_elapsed' : null) };
  return { ...task.result, taskId: task.taskId, task, waitedMs };
}

async function delegateWorker(args) {
  if (!args.task?.trim()) throw new Error('task is required');
  const current = await state();
  const requestedMode = args.mode || current.mode;
  if (current.mode === 'MAIN' || requestedMode === 'MAIN') throw new Error('MAIN mode disables worker spawning and delegation');
  const { waitMs, ...body } = args;
  const localToken = await token();
  const base = `http://127.0.0.1:${port()}`;
  const started = await requestJson(`${base}/internal/worker/start`, { method: 'POST', headers: { authorization: `Bearer ${localToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!started.taskId) return started;
  const requestedWait = waitMs === undefined ? DEFAULT_WAIT_MS : Number(waitMs);
  const limit = Math.min(Math.max(Number.isFinite(requestedWait) ? requestedWait : DEFAULT_WAIT_MS, 0), DEFAULT_WAIT_MS);
  const began = Date.now();
  let task = started;
  while (!TERMINAL.has(task.status) && !task.reviewDue && Date.now() - began < limit) {
    await sleep(Math.min(POLL_MS, Math.max(1, limit - (Date.now() - began))));
    task = await requestJson(`${base}/internal/worker/status/${encodeURIComponent(started.taskId)}`, { headers: { authorization: `Bearer ${localToken}` } });
  }
  const waitedMs = Date.now() - began;
  return flattenCompleted(task, waitedMs);
}

async function workerStatus(args) {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(args.taskId || ''))) throw new Error('taskId is required');
  const localToken = await token();
  return requestJson(`http://127.0.0.1:${port()}/internal/worker/status/${encodeURIComponent(args.taskId)}`, { headers: { authorization: `Bearer ${localToken}` } });
}

async function workerExtend(args) {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(args.taskId || ''))) throw new Error('taskId is required');
  const localToken = await token();
  return requestJson(`http://127.0.0.1:${port()}/internal/worker/extend/${encodeURIComponent(args.taskId)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${localToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ extraMs: args.extraMs, reason: String(args.reason || '主控确认 Worker 方向正常，续期继续执行').slice(0, 500) })
  });
}

async function workerCancel(args) {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(args.taskId || ''))) throw new Error('taskId is required');
  const localToken = await token();
  return requestJson(`http://127.0.0.1:${port()}/internal/worker/cancel/${encodeURIComponent(args.taskId)}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${localToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ reason: String(args.reason || 'cancelled by operator').slice(0, 500) })
  });
}
