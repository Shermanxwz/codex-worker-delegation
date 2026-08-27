#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TERMINAL = new Set(['completed', 'failed', 'timed_out', 'cancelled', 'delegation_required']);
const DEFAULT_WAIT_MS = 170000;
const POLL_MS = 1000;
const MAX_RPC_BUFFER = 1024 * 1024;
const MAX_TASK_LENGTH = 512 * 1024;
const MAX_LOCAL_RESPONSE_BYTES = 4 * 1024 * 1024;
const MODES = new Set(['OFFICIAL', 'AUTO', 'DELEGATE', 'MAIN']);

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  if (Buffer.byteLength(buffer, 'utf8') > MAX_RPC_BUFFER) {
    process.stderr.write('codex-worker-delegation: MCP input exceeded 1 MiB without a complete message\n');
    process.exitCode = 78; process.stdin.pause(); return;
  }
  drain();
});

function drain() {
  while (true) {
    const i = buffer.indexOf('\n'); if (i < 0) return;
    const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
    if (line) { let message; try { message = JSON.parse(line); } catch { continue; } handle(message).catch((error) => reply(message.id, null, { code: -32603, message: error.message })); }
  }
}

async function handle(msg) {
  if (msg.method === 'initialize') return reply(msg.id, { protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'codex-worker-delegation', version: '3.2.0' } });
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'tools/list') return reply(msg.id, { tools: [
    { name: 'delegation_status', description: 'Read current Web-controlled delegation mode and redacted provider/model routing. OFFICIAL means this plugin is dormant and Codex native policy is authoritative. Fails closed when control state is unavailable.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'delegate_worker', description: 'Start the Web-selected Worker or Verifier and return its task ID, live state, heartbeat, progress events, and result. Available only in AUTO/WORKER modes; OFFICIAL defers to native Codex and MAIN disables delegation.', inputSchema: { type: 'object', properties: { task: { type: 'string', minLength: 1, maxLength: MAX_TASK_LENGTH }, role: { type: 'string', enum: ['worker', 'verifier'] }, cwd: { type: 'string', maxLength: 4096 }, mode: { type: 'string', enum: ['OFFICIAL', 'AUTO', 'DELEGATE', 'MAIN'] }, profile: { type: 'string', enum: ['quick', 'standard'] }, timeoutMs: { type: 'number', minimum: 1000, maximum: 900000 }, maxTotalTimeoutMs: { type: 'number', minimum: 1000, maximum: 3600000 }, waitMs: { type: 'number', minimum: 0, maximum: 170000 } }, required: ['task'], additionalProperties: false } },
    { name: 'worker_status', description: 'Read a Worker or Verifier task by task ID, including status, phase, progress, last heartbeat, last progress event, event history, error, and result.', inputSchema: { type: 'object', properties: { taskId: { type: 'string', minLength: 8, maxLength: 128 } }, required: ['taskId'], additionalProperties: false } },
    { name: 'worker_extend', description: 'Root-control fallback for an existing plugin-managed Worker/Verifier lease. OFFICIAL and MAIN reject extension.', inputSchema: { type: 'object', properties: { taskId: { type: 'string', minLength: 8, maxLength: 128 }, extraMs: { type: 'number', minimum: 1000, maximum: 900000 }, reason: { type: 'string', maxLength: 500 } }, required: ['taskId'], additionalProperties: false } },
    { name: 'worker_cancel', description: 'Cancel one existing plugin-managed Worker or Verifier task by task ID. This remains available for cleanup even after switching modes.', inputSchema: { type: 'object', properties: { taskId: { type: 'string', minLength: 8, maxLength: 128 }, reason: { type: 'string', maxLength: 500 } }, required: ['taskId'], additionalProperties: false } }
  ] });
  if (msg.method === 'tools/call' && msg.params?.name === 'delegation_status') { const current = await state(); return toolReply(msg.id, { mode: current.mode, routing: current.routing || null, provider: current.provider && { name: current.provider.name, baseUrl: current.provider.baseUrl, protocol: current.provider.protocol }, protocolCache: current.protocolCache, installed: Boolean(current.installed) }); }
  if (msg.method === 'tools/call' && msg.params?.name === 'delegate_worker') return toolReply(msg.id, await delegateWorker(msg.params?.arguments || {}));
  if (msg.method === 'tools/call' && msg.params?.name === 'worker_status') return toolReply(msg.id, await workerStatus(msg.params?.arguments || {}));
  if (msg.method === 'tools/call' && msg.params?.name === 'worker_extend') return toolReply(msg.id, await workerExtend(msg.params?.arguments || {}));
  if (msg.method === 'tools/call' && msg.params?.name === 'worker_cancel') return toolReply(msg.id, await workerCancel(msg.params?.arguments || {}));
  if (msg.id !== undefined) return reply(msg.id, null, { code: -32601, message: 'method not found' });
}

function toolReply(id, value) { return reply(id, { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }); }
function reply(id, result, error) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }) + '\n'); }
function baseDir() { if (process.env.CWD_DATA_DIR) return path.resolve(process.env.CWD_DATA_DIR); const home = process.env.HOME || os.homedir(); return path.join(home, '.local', 'share', 'codex-worker-delegation'); }
async function state() { const file = path.join(baseDir(), 'state.json'); try { const parsed = JSON.parse(await fs.readFile(file, 'utf8')); if (!MODES.has(parsed?.mode)) throw new Error(`invalid mode ${String(parsed?.mode)}`); return parsed; } catch (error) { const wrapped = new Error(`delegation control state is unavailable: ${error.message}`); wrapped.code = 'DELEGATION_STATE_UNAVAILABLE'; throw wrapped; } }
async function token() { const value = (await fs.readFile(path.join(baseDir(), 'gateway.token'), 'utf8')).trim(); if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('gateway token is unavailable or malformed'); return value; }
function port() { const value=Number(process.env.CWD_PORT || 8788); if(!Number.isSafeInteger(value)||value<1||value>65535)throw new Error('CWD_PORT must be an integer from 1 to 65535'); return value; }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function readLimited(response) {
  const declared=Number(response.headers.get('content-length')); if(Number.isFinite(declared)&&declared>MAX_LOCAL_RESPONSE_BYTES)throw new Error('control-plane response exceeds safe limit');
  if(!response.body)return '';
  const chunks=[];let total=0;for await(const chunk of response.body){total+=chunk.byteLength;if(total>MAX_LOCAL_RESPONSE_BYTES){try{await response.body.cancel()}catch{}throw new Error('control-plane response exceeds safe limit')}chunks.push(Buffer.from(chunk))}return Buffer.concat(chunks).toString('utf8');
}
async function requestJson(url, options = {}, timeoutMs = 10000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const text = await readLimited(response); let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0,4096) }; }
  if (!response.ok) { const error = new Error(body?.error?.message || body?.error || `worker request failed (${response.status})`); error.status = response.status; error.body = body; throw error; }
  return body;
}

function flattenCompleted(task, waitedMs) { if (task?.status !== 'completed' || !task.result) return { ...task, waitedMs, waitingTimedOut: !TERMINAL.has(task?.status), waitingReason: task?.reviewDue ? 'review_due' : (!TERMINAL.has(task?.status) ? 'poll_window_elapsed' : null) }; return { ...task.result, taskId: task.taskId, task, waitedMs }; }

async function delegateWorker(args) {
  if (typeof args.task !== 'string' || !args.task.trim()) throw new Error('task is required');
  if (Buffer.byteLength(args.task,'utf8') > MAX_TASK_LENGTH) throw new Error(`task exceeds ${MAX_TASK_LENGTH} bytes`);
  const current = await state(); const requestedMode = args.mode || current.mode;
  if (current.mode === 'OFFICIAL' || requestedMode === 'OFFICIAL') throw new Error('OFFICIAL mode delegates behavior to native Codex and disables plugin-managed Worker spawning');
  if (current.mode === 'MAIN' || requestedMode === 'MAIN') throw new Error('MAIN mode disables worker spawning and delegation');
  const localToken = await token(); const base = `http://127.0.0.1:${port()}`;
  const body={ task: args.task };
  if(args.role!==undefined)body.role=args.role;if(args.cwd!==undefined)body.cwd=args.cwd;if(args.mode!==undefined)body.mode=args.mode;if(args.profile!==undefined)body.profile=args.profile;if(args.timeoutMs!==undefined)body.timeoutMs=args.timeoutMs;if(args.maxTotalTimeoutMs!==undefined)body.maxTotalTimeoutMs=args.maxTotalTimeoutMs;
  const started = await requestJson(`${base}/internal/worker/start`, { method: 'POST', headers: { authorization: `Bearer ${localToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!started.taskId) return started;
  const requestedWait = args.waitMs === undefined ? DEFAULT_WAIT_MS : Number(args.waitMs); const limit = Math.min(Math.max(Number.isFinite(requestedWait) ? requestedWait : DEFAULT_WAIT_MS, 0), DEFAULT_WAIT_MS); const began = Date.now(); let task = started;
  while (!TERMINAL.has(task.status) && Date.now() - began < limit) { await sleep(Math.min(POLL_MS, Math.max(1, limit - (Date.now() - began)))); task = await requestJson(`${base}/internal/worker/status/${encodeURIComponent(started.taskId)}`, { headers: { authorization: `Bearer ${localToken}` } }); }
  return flattenCompleted(task, Date.now() - began);
}

async function workerStatus(args) { if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(args.taskId || ''))) throw new Error('taskId is required'); const localToken = await token(); return requestJson(`http://127.0.0.1:${port()}/internal/worker/status/${encodeURIComponent(args.taskId)}`, { headers: { authorization: `Bearer ${localToken}` } }); }
async function workerExtend(args) { if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(args.taskId || ''))) throw new Error('taskId is required'); const current = await state(); if (current.mode === 'OFFICIAL') throw new Error('OFFICIAL mode disables plugin-managed Worker lease extension'); if (current.mode === 'MAIN') throw new Error('MAIN mode disables Worker lease extension'); const localToken = await token(); return requestJson(`http://127.0.0.1:${port()}/internal/worker/extend/${encodeURIComponent(args.taskId)}`, { method: 'POST', headers: { authorization: `Bearer ${localToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ extraMs: args.extraMs, reason: String(args.reason || '主控确认 Worker 方向正常，续期继续执行').slice(0, 500) }) }); }
async function workerCancel(args) { if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(args.taskId || ''))) throw new Error('taskId is required'); const localToken = await token(); return requestJson(`http://127.0.0.1:${port()}/internal/worker/cancel/${encodeURIComponent(args.taskId)}`, { method: 'POST', headers: { authorization: `Bearer ${localToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ reason: String(args.reason || 'cancelled by operator').slice(0, 500) }) }); }
