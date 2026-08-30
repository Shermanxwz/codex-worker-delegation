import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateStore, publicState, activeRouting, setRoutingMode, ROUTING_MODES } from './store.mjs';
import { SecretVault } from './vault.mjs';
import { ResponsesGateway } from './gateway.mjs';
import { probeProvider, listProviderModels, modelKind } from './provider.mjs';
import { toCodexModelsResponse } from './codex-models.mjs';
import { CodexConfigManager, CODEX_GATEWAY_PROVIDER_ID, inspectTopLevel, sameTopLevelSelectors } from './codex-config.mjs';
import { CodexAppServerPool, withCodexAppServer, resolveCodexBinary } from './app-server.mjs';
import { executionPlan } from './policy.mjs';
import { buildModelCapabilityRegistry, reconcileRoleRoute, reconcileRoutingWithRegistry, validateRoleRoute } from './model-capabilities.mjs';
import { WebAuth, MIN_PASSWORD_LENGTH } from './web-auth.mjs';
import { readJson } from './http-json.mjs';
import { WorkerTaskManager, WORKER_MAX_TOTAL_TIMEOUT_MS, WORKER_QUICK_TIMEOUT_MS, WORKER_QUICK_MAX_TOTAL_TIMEOUT_MS, isTerminalTask, isWorkerTimeout, errorDetails, normalizeWorkerTimeout, normalizeWorkerMaxTotalTimeout } from './worker-jobs.mjs';
export { executionPlan } from './policy.mjs';

const VERSION = '3.2.0';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentTypes = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.webmanifest':'application/manifest+json' };
const MODES = new Set(ROUTING_MODES);
const ROLES = new Set(['main', 'worker', 'verifier']);
const PROVIDERS = new Set(['official', 'third_party']);
const WORKER_SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const WORKER_PROFILES = new Set(['standard', 'quick']);
const MAX_WORKER_TASK_BYTES = 512 * 1024;
const MAX_CWD_LENGTH = 4096;
const MAX_MODEL_ID_LENGTH = 512;
const MAX_PROVIDER_URL_LENGTH = 4096;
const MAX_EFFORT_LENGTH = 128;
const AUTH_MODES = new Set(['password', 'local_passwordless']);
const HOOK_HEALTH_DOMAIN = 'cwd-hook-health-v1';
const HOOK_NONCE = /^[a-f0-9]{48}$/;

function hmac(token, direction, nonce) { return crypto.createHmac('sha256', token).update(`${HOOK_HEALTH_DOMAIN}:${direction}:${nonce}`).digest('base64url'); }
function timingSafeText(a, b) { const left=Buffer.from(String(a||'')), right=Buffer.from(String(b||'')); return left.length===right.length && crypto.timingSafeEqual(left,right); }

export function createApp({ env = process.env, fetchImpl = fetch } = {}) {
  const store = new StateStore({ env });
  const vault = new SecretVault({ env });
  const webAuth = new WebAuth({ env });
  const gateway = new ResponsesGateway({ store, vault, fetchImpl });
  const workerJobs = new WorkerTaskManager({
    env,
    onReview: async ({ task, decision, evidence, reason, extensionMs, grace }) => {
      const base = {
        taskId: task.taskId,
        mode: task.mode,
        role: task.role,
        provider: task.provider,
        model: task.model,
        execution: task.execution,
        profile: task.profile,
        decision,
        automatic: true,
        reason: String(reason || '').slice(0, 500),
        evidence: evidence?.state || null,
        heartbeatAgeMs: evidence?.heartbeatAgeMs ?? null,
        meaningfulProgressAgeMs: evidence?.meaningfulProgressAgeMs ?? null,
        extensionMs: extensionMs || null,
        grace: grace === true,
        extensionCount: task.extensionCount || 0,
        autoReviewCount: task.autoReviewCount || 0,
        autoExtensionCount: task.autoExtensionCount || 0,
        deadlineAt: task.deadlineAt,
        reviewAt: task.reviewAt,
        threadId: task.threadId,
        turnId: task.turnId
      };
      await store.audit('worker.auto_review', base).catch(() => {});
      if (decision === 'cancelled') await store.audit('worker.cancelled', { ...base, automatic: true }).catch(() => {});
      if (decision === 'extended') await store.audit('worker.extended', { ...base, automatic: true }).catch(() => {});
    },
    onOrphan: async ({ task, reason }) => {
      await store.audit('worker.orphaned', {
        taskId: task.taskId,
        mode: task.mode,
        role: task.role,
        provider: task.provider,
        model: task.model,
        execution: task.execution,
        status: task.status,
        threadId: task.threadId,
        reason: String(reason || '').slice(0, 500)
      }).catch(() => {});
    }
  });
  const appServerPool = new CodexAppServerPool({ idleMs: Number(env.CWD_APP_SERVER_POOL_IDLE_MS || 5 * 60 * 1000) });
  const port = Number(env.CWD_PORT || 8788);
  const host = env.CWD_HOST || '127.0.0.1';
  const codex = new CodexConfigManager({ env, gatewayBaseUrl: `http://127.0.0.1:${port}/v1` });
  const runtimeContext = { store, vault, env, fetchImpl, codex, workerJobs, appServerPool };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && url.pathname === '/internal/hook-health') return authenticatedHookHealth(req, res, url, store);
      if (req.method === 'POST' && url.pathname === '/v1/responses') return gateway.handle(req, res, await readJson(req));
      if (req.method === 'GET' && url.pathname === '/v1/models') return serveGatewayModels(req, res, { store, vault, fetchImpl, nativeCatalog: url.searchParams.has('client_version') });
      if (req.method === 'POST' && url.pathname === '/internal/worker/start') {
        if (!await authorizeInternal(req, store)) return sendJson(res, 401, { error: 'invalid internal token' });
        const task = await startWorkerTask(await readJson(req), runtimeContext);
        return sendJson(res, task.taskId ? 202 : 200, task);
      }
      if (req.method === 'POST' && url.pathname.startsWith('/internal/worker/cancel/')) {
        if (!await authorizeInternal(req, store)) return sendJson(res, 401, { error: 'invalid internal token' });
        const taskId = decodeURIComponent(url.pathname.slice('/internal/worker/cancel/'.length));
        const task = await cancelWorkerTask(taskId, await readJson(req), { store, workerJobs });
        return task ? sendJson(res, 200, task) : sendJson(res, 404, { error: 'worker task not found', taskId });
      }
      if (req.method === 'POST' && url.pathname.startsWith('/internal/worker/extend/')) {
        if (!await authorizeInternal(req, store)) return sendJson(res, 401, { error: 'invalid internal token' });
        const taskId = decodeURIComponent(url.pathname.slice('/internal/worker/extend/'.length));
        try {
          const task = await extendWorkerTask(taskId, await readJson(req), { store, workerJobs });
          return task ? sendJson(res, 200, task) : sendJson(res, 404, { error: 'worker task not found', taskId });
        } catch (error) { error.statusCode = error.statusCode || 409; throw error; }
      }
      if (req.method === 'GET' && url.pathname.startsWith('/internal/worker/status/')) {
        if (!await authorizeInternal(req, store)) return sendJson(res, 401, { error: 'invalid internal token' });
        const taskId = decodeURIComponent(url.pathname.slice('/internal/worker/status/'.length));
        const task = await workerJobs.get(taskId);
        return task ? sendJson(res, 200, task) : sendJson(res, 404, { error: 'worker task not found', taskId });
      }
      if (req.method === 'POST' && url.pathname === '/internal/worker/run') {
        if (!await authorizeInternal(req, store)) return sendJson(res, 401, { error: 'invalid internal token' });
        const body = await readJson(req);
        if (body.waitForCompletion === true) return sendJson(res, 200, await executeWorker(body, runtimeContext));
        const task = await startWorkerTask(body, runtimeContext);
        return sendJson(res, task.taskId ? 202 : 200, task);
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/status') return sendJson(res, 200, await authStatus({ req, env, host, webAuth }));
      if (req.method === 'POST' && url.pathname === '/api/auth/setup') {
        if (!isLoopback(host) && (!env.CWD_WEB_TOKEN || req.headers.authorization !== `Bearer ${env.CWD_WEB_TOKEN}`)) return sendJson(res, 401, { error: 'bootstrap token required for public password setup' });
        const body = await readJson(req);
        if (body.password !== body.confirmPassword) return sendJson(res, 400, { error: 'password confirmation does not match' });
        await webAuth.setPassword(body.password);
        const session = await webAuth.login(body.password, req.socket.remoteAddress || 'unknown');
        return sendJson(res, 200, { ok: true, configured: true }, { 'set-cookie': webAuth.cookie(session, secureCookie(env, host)) });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        const body = await readJson(req);
        const session = await webAuth.login(body.password, req.socket.remoteAddress || 'unknown');
        return sendJson(res, 200, { ok: true, authenticated: true }, { 'set-cookie': webAuth.cookie(session, secureCookie(env, host)) });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        webAuth.clear(req);
        return sendJson(res, 200, { ok: true }, { 'set-cookie': webAuth.clearCookie() });
      }
      if (url.pathname.startsWith('/api/')) {
        if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true, version: VERSION, host, port, codexBinary: resolveCodexBinary(env), authRequired: (await authPolicy({ env, host, webAuth })).required });
        if (!await authorizeUi(req, env, host, webAuth)) return sendJson(res, 401, { error: 'unauthorized' });
        if (req.method === 'POST' && url.pathname === '/api/auth/mode') {
          const policy = await authPolicy({ env, host, webAuth });
          if (!policy.passwordlessAvailable) return sendJson(res, 403, { error: 'local passwordless mode is available only for an explicitly non-authenticated loopback launch' });
          const body = await readJson(req);
          if (!AUTH_MODES.has(body.mode)) return sendJson(res, 400, { error: 'auth mode must be password or local_passwordless' });
          if (body.mode === 'local_passwordless' && policy.configured) await webAuth.setLocalPasswordless(true);
          if (body.mode === 'password') {
            if (!policy.configured) return sendJson(res, 409, { error: 'set a web password before selecting password mode' });
            await webAuth.setLocalPasswordless(false);
          }
          await store.audit('auth.mode_changed', { mode: body.mode, loopback: policy.loopback, passwordlessAvailable: policy.passwordlessAvailable });
          return sendJson(res, 200, { ok: true, ...(await authStatus({ req, env, host, webAuth })) });
        }
        if (req.method === 'GET' && url.pathname === '/api/state') return sendJson(res, 200, publicState(await store.read()));
        if (req.method === 'GET' && url.pathname === '/api/catalog') return sendJson(res, 200, await loadCatalog(runtimeContext));
        if (req.method === 'GET' && url.pathname === '/api/runtime') {
          const catalog = await loadCatalog(runtimeContext);
          return sendJson(res, 200, catalog.runtime);
        }
        if (req.method === 'PUT' && url.pathname === '/api/mode') {
          const { mode } = await readJson(req);
          if (!MODES.has(mode)) return sendJson(res, 400, { error: `mode must be ${ROUTING_MODES.join(', ')}` });
          const state = await store.update((s) => { s.mode = mode; return s; });
          const cancelled = mode === 'OFFICIAL' || mode === 'MAIN' ? await workerJobs.cancelAll(`${mode} mode activated by Web control`) : [];
          const reasoningSync = await syncTopLevelReasoning(state, codex);
          await store.audit('mode.changed', { mode, reasoningSync, cancelledTaskIds: cancelled.map((task)=>task.taskId) });
          return sendJson(res, 200, publicState(state));
        }
        if (req.method === 'PUT' && url.pathname === '/api/routing') {
          const body = await readJson(req);
          const current = await store.read();
          const mode = body.mode || current.mode;
          if (!MODES.has(mode)) return sendJson(res, 400, { error: 'invalid mode' });
          if (mode === 'OFFICIAL') {
            const error = new Error('OFFICIAL mode is owned by native Codex defaults and does not accept custom routing');
            error.code = 'OFFICIAL_MODE_NATIVE'; error.statusCode = 409; throw error;
          }
          const catalog = await loadCatalog(runtimeContext);
          const normalizedRoles = validateRouting(body.roles, mode, catalog.registry);
          const state = await store.update((s) => setRoutingMode(s, mode, normalizedRoles));
          const reasoningSync = await syncTopLevelReasoning(state, codex);
          await store.audit('routing.changed', { mode, roles: normalizedRoles, reasoningSync, registryGeneratedAt: catalog.registry.generatedAt });
          return sendJson(res, 200, publicState(state));
        }
        if (req.method === 'PUT' && url.pathname === '/api/provider') {
          const body = await readJson(req); validateProvider(body);
          const current = await store.read();
          const cipher = body.apiKey ? await vault.encrypt(body.apiKey) : current.provider?.apiKeyCipher;
          if (!cipher) return sendJson(res, 400, { error: 'apiKey is required on first configuration' });
          const provider = { name: body.name || 'New API', baseUrl: body.baseUrl, protocol: body.protocol || 'auto', apiKeyCipher: cipher, forwardReasoningEffort: body.forwardReasoningEffort === true, headers: sanitizeHeaders(body.headers) };
          const state = await store.update((s) => { s.provider = provider; s.protocolCache = {}; return s; });
          await store.audit('provider.saved', { name: provider.name, baseUrl: provider.baseUrl, protocol: provider.protocol });
          return sendJson(res, 200, publicState(state));
        }
        if (req.method === 'POST' && url.pathname === '/api/provider/probe') {
          const state = await store.read(); if (!state.provider) return sendJson(res, 400, { error: 'configure provider first' });
          const body = await readJson(req); const selected = body.model || firstThirdPartyModel(state) || activeRouting(state).worker.model || activeRouting(state).main.model;
          if (!selected) return sendJson(res, 400, { error: 'model is required' });
          const apiKey = await vault.decrypt(state.provider.apiKeyCipher);
          const result = await probeProvider({ baseUrl: state.provider.baseUrl, apiKey, model: selected, fetchImpl, extraHeaders: state.provider.headers });
          if (result.protocol !== 'unknown') await store.update((s) => { s.protocolCache[selected] = { protocol: result.protocol, detectedAt: new Date().toISOString(), probeOk: result.ok }; return s; });
          await store.audit('provider.probed', { model: selected, protocol: result.protocol, ok: result.ok, status: result.status });
          return sendJson(res, 200, result);
        }
        if (req.method === 'POST' && url.pathname === '/api/provider/connectivity') {
          const state = await store.read(); if (!state.provider) return sendJson(res, 400, { error: 'configure provider first' });
          const body = await readJson(req); const apiKey = await vault.decrypt(state.provider.apiKeyCipher);
          const listed = Array.isArray(body.models)
            ? body.models.map((model) => ({ id: String(model || '').trim(), kind: modelKind(model) }))
            : await listProviderModels({ baseUrl: state.provider.baseUrl, apiKey, fetchImpl, extraHeaders: state.provider.headers });
          const modelKinds = new Map(); for (const item of listed) { const id = String(item?.id || '').trim(); if (id && !modelKinds.has(id)) modelKinds.set(id, item.kind || modelKind(id)); }
          const models = [...modelKinds.keys()];
          if (!models.length) return sendJson(res, 400, { error: 'no models available to test' });
          if (models.length > 2000 || models.some((model)=>model.length > MAX_MODEL_ID_LENGTH)) return sendJson(res, 400, { error: 'model connectivity request exceeds safe limits' });
          const results = await testProviderModels({ models, modelKinds, state, apiKey, fetchImpl });
          await store.update((s) => { for (const result of results) if (result.ok && result.protocol !== 'unknown') s.protocolCache[result.model] = { protocol: result.protocol, detectedAt: new Date().toISOString(), probeOk: true }; return s; });
          return sendJson(res, 200, { results });
        }
        if (req.method === 'POST' && url.pathname === '/api/codex/install') {
          const snap = await ensureCodexIntegration({ store, codex, appServerPool });
          const next = await store.read();
          await store.audit('codex.installed', { providerId: snap.providerId, agents: snap.agents, topLevelPreserved: snap.topLevelPreserved });
          return sendJson(res, 200, publicState(next));
        }
        if (req.method === 'POST' && url.pathname === '/api/auth/change') {
          const policy = await authPolicy({ env, host, webAuth });
          if (!webAuth.authenticated(req) && !policy.passwordlessLocal) return sendJson(res, 401, { error: 'login required' });
          const body = await readJson(req);
          if (!await webAuth.verifyPassword(body.currentPassword)) return sendJson(res, 401, { error: 'current password is invalid' });
          if (body.newPassword !== body.confirmPassword) return sendJson(res, 400, { error: 'password confirmation does not match' });
          await webAuth.changePassword(body.newPassword);
          webAuth.clear(req);
          const session = await webAuth.login(body.newPassword, req.socket.remoteAddress || 'unknown');
          return sendJson(res, 200, { ok: true, authenticated: true }, { 'set-cookie': webAuth.cookie(session, secureCookie(env, host)) });
        }
        if (req.method === 'POST' && url.pathname === '/api/verify/coexistence') {
          const body = await readJson(req);
          return sendJson(res, 200, await verifyCoexistence({ body, ...runtimeContext }));
        }
        if (req.method === 'POST' && url.pathname === '/api/worker/start') {
          const task = await startWorkerTask(await readJson(req), runtimeContext);
          return sendJson(res, task.taskId ? 202 : 200, task);
        }
        if (req.method === 'GET' && url.pathname.startsWith('/api/worker/status/')) {
          const taskId = decodeURIComponent(url.pathname.slice('/api/worker/status/'.length));
          const task = await workerJobs.get(taskId);
          return task ? sendJson(res, 200, task) : sendJson(res, 404, { error: 'worker task not found', taskId });
        }
        if (req.method === 'POST' && url.pathname === '/api/worker/run') {
          const body = await readJson(req);
          if (body.waitForCompletion === true) return sendJson(res, 200, await executeWorker(body, runtimeContext));
          const task = await startWorkerTask(body, runtimeContext);
          return sendJson(res, task.taskId ? 202 : 200, task);
        }
        if (req.method === 'POST' && url.pathname === '/api/main/run') {
          return sendJson(res, 200, await runStandaloneMain(await readJson(req), runtimeContext));
        }
        return sendJson(res, 404, { error: 'not found' });
      }
      return serveStatic(url.pathname, res);
    } catch (error) {
      if (!error.statusCode || error.statusCode >= 500) console.error(error);
      return sendJson(res, error.statusCode || 500, { error: error.message, code: error.code || null, taskId: error.taskId || null });
    }
  });
  server.on('close', () => { void workerJobs.close(); void appServerPool.close(); });
  return { server, host, port, store, workerJobs, appServerPool };
}

async function authenticatedHookHealth(req, res, url, store) {
  const nonce = String(url.searchParams.get('nonce') || '');
  if (!HOOK_NONCE.test(nonce)) return sendJson(res, 400, { error: 'invalid hook health nonce' });
  const token = await store.ensureGatewayToken();
  const supplied = String(req.headers['x-cwd-hook-proof'] || '');
  const expected = hmac(token, 'request', nonce);
  if (!timingSafeText(supplied, expected)) return sendJson(res, 401, { error: 'invalid hook health proof' });
  return sendJson(res, 200, { ok: true, version: 1, nonce, proof: hmac(token, 'response', nonce) });
}

async function authorizeInternal(req, store) {
  const token = await store.ensureGatewayToken();
  return req.headers.authorization === `Bearer ${token}`;
}

async function serveGatewayModels(req, res, { store, vault, fetchImpl, nativeCatalog = false }) {
  if (!await authorizeInternal(req, store)) return sendJson(res, 401, { error: { message: 'Invalid local gateway token', type: 'authentication_error' } });
  const state = await store.read();
  if (!state.provider) return sendJson(res, 503, { error: { message: 'No third-party provider configured', type: 'configuration_error' } });
  const apiKey = await vault.decrypt(state.provider.apiKeyCipher);
  const models = await listProviderModels({ baseUrl: state.provider.baseUrl, apiKey, fetchImpl, extraHeaders: state.provider.headers });
  if (nativeCatalog) return sendJson(res, 200, toCodexModelsResponse(models));
  return sendJson(res, 200, { object: 'list', data: models.map((item) => ({ id: item.id, object: 'model', owned_by: item.ownedBy || state.provider.name || 'third-party', kind: item.kind || modelKind(item.id), supported_reasoning_levels: item.supportedReasoningEfforts || undefined, default_reasoning_level: item.defaultReasoningEffort || undefined })) });
}

async function prepareWorker(body, context) {
  const { store, env } = context;
  const state = await store.read();
  const mode = state.mode;
  const roleName = body.role || 'worker';
  if (body.mode && body.mode !== state.mode) { const error = new Error(`requested mode ${body.mode} does not match active Web mode ${state.mode}`); error.code = 'ACTIVE_MODE_MISMATCH'; error.statusCode = 409; throw error; }
  if (!MODES.has(mode) || !['worker', 'verifier'].includes(roleName)) throw new Error('invalid mode or worker role');
  if (mode === 'OFFICIAL') { const error = new Error('OFFICIAL mode delegates behavior to native Codex and disables plugin-managed Worker execution'); error.code = 'OFFICIAL_MODE_NATIVE'; error.statusCode = 409; throw error; }
  if (mode === 'MAIN') { const error = new Error('MAIN mode disables delegation'); error.code = 'MAIN_MODE_LOCKED'; error.statusCode = 409; throw error; }
  if (typeof body.task !== 'string' || !body.task.trim()) throw new Error('task is required');
  if (Buffer.byteLength(body.task, 'utf8') > MAX_WORKER_TASK_BYTES) { const error = new Error(`task exceeds ${MAX_WORKER_TASK_BYTES} bytes`); error.statusCode = 413; error.code = 'WORKER_TASK_TOO_LARGE'; throw error; }

  const catalog = await loadCatalog(context);
  const routes = activeRouting(state, mode);
  const mainReconciled = reconcileRoleRoute(routes.main, { role: 'main', registry: catalog.registry });
  const main = { provider: mainReconciled.provider, model: mainReconciled.model, effort: mainReconciled.effort };
  const validated = validateRoleRoute(routes[roleName], { role: roleName, registry: catalog.registry, requireModel: true });
  const route = { provider: validated.provider, model: validated.model, effort: validated.effort };
  const plan = executionPlan(main, route, roleName);
  if (plan.execution === 'native_subagent_required') return { kind: 'native', ...plan, mode, role: roleName, provider: route.provider, model: route.model, effort: route.effort || 'auto', instruction: `Use Codex native spawn_agent with agent_type=${plan.agentType} and model=${route.model}${route.effort && route.effort !== 'auto' ? ` and reasoning_effort=${route.effort}` : ''}. This route stays on the built-in OpenAI provider.` };
  const rawCwd = body.cwd || process.cwd();
  if (typeof rawCwd !== 'string' || !rawCwd.trim() || rawCwd.length > MAX_CWD_LENGTH) throw new Error('cwd must be a non-empty path no longer than 4096 characters');
  const cwd = path.resolve(rawCwd);
  let stat; try { stat = await fs.stat(cwd); } catch (error) { error.statusCode = 400; error.message = `cwd is not accessible: ${cwd}`; throw error; }
  if (!stat.isDirectory()) { const error = new Error(`cwd is not a directory: ${cwd}`); error.statusCode = 400; throw error; }
  const sandbox = roleName === 'verifier' ? 'read-only' : String(body.sandbox || 'workspace-write');
  if (!WORKER_SANDBOXES.has(sandbox)) { const error = new Error('sandbox must be read-only, workspace-write, or danger-full-access'); error.statusCode = 400; throw error; }
  if (sandbox === 'danger-full-access' && env.CWD_ALLOW_DANGER_FULL_ACCESS !== '1') { const error = new Error('danger-full-access is disabled for automated Worker routes; set CWD_ALLOW_DANGER_FULL_ACCESS=1 only after an explicit operator risk decision'); error.statusCode = 403; error.code = 'DANGER_SANDBOX_DISABLED'; throw error; }
  const profile = String(body.profile || 'standard').trim().toLowerCase();
  if (!WORKER_PROFILES.has(profile)) { const error = new Error('profile must be standard or quick'); error.statusCode = 400; error.code = 'INVALID_WORKER_PROFILE'; throw error; }
  const timeoutMs = body.timeoutMs === undefined && profile === 'quick' ? WORKER_QUICK_TIMEOUT_MS : normalizeWorkerTimeout(body.timeoutMs);
  const defaultMaxTotal = profile === 'quick' ? WORKER_QUICK_MAX_TOTAL_TIMEOUT_MS : WORKER_MAX_TOTAL_TIMEOUT_MS;
  const maxTotalTimeoutMs = normalizeWorkerMaxTotalTimeout(body.maxTotalTimeoutMs === undefined ? defaultMaxTotal : body.maxTotalTimeoutMs, timeoutMs);
  return { kind: 'app_server', state, mode, role: roleName, route, main, plan, task: body.task, cwd, sandbox, profile, timeoutMs, maxTotalTimeoutMs };
}

function progressFromNotification(message) {
  const method = String(message?.method || ''); const params = message.params || {}; const item = params.item || params.itemSummary || {};
  const details = { method, threadId: params.threadId, turnId: params.turn?.id, itemId: item.id, itemType: item.type, status: params.turn?.status || item.status, phase: params.phase };
  if (method === 'thread/started') return { threadId: params.threadId, phase: 'thread_start', progress: 15, message: 'Codex App Server 线程已创建', event: { type: method, message: 'Codex App Server 线程已创建', details } };
  if (method === 'turn/started') return { turnId: params.turn?.id || null, phase: 'turn_start', progress: 20, message: 'Worker 已提交任务，等待模型执行', event: { type: method, message: 'Worker 已提交任务', details } };
  if (method.includes('item/started')) return { phase: 'executing', progress: 35, message: `Worker 正在执行：${item.type || '任务步骤'}`, event: { type: method, message: `开始：${item.type || '任务步骤'}`, details } };
  if (method.includes('item/completed')) return { phase: 'executing', progress: 70, message: `Worker 已完成：${item.type || '任务步骤'}`, event: { type: method, message: `完成：${item.type || '任务步骤'}`, details } };
  if (method === 'turn/completed') return { phase: 'completion', progress: 95, message: 'Worker 已收到完成事件，正在整理结果', event: { type: method, message: '收到完成事件', details } };
  if (method) return { phase: 'running', message: `Worker 收到进度事件：${method}`, event: { type: method, message: `收到：${method}`, details } };
  return null;
}

async function startWorkerTask(body, context) {
  const { store, env, codex, workerJobs, appServerPool } = context;
  const prepared = await prepareWorker(body, context);
  if (prepared.kind === 'native') return { ...prepared, status: 'delegation_required', taskId: null, message: '当前官方路由需要由主控 Codex 使用 native spawn_agent 执行。' };
  const { mode, role, route, plan, task, cwd, sandbox, profile, timeoutMs, maxTotalTimeoutMs } = prepared;
  return workerJobs.start({ mode, role, execution: plan.execution, provider: route.provider, model: route.model, effort: route.effort || 'auto', profile, cwd, timeoutMs, maxTotalTimeoutMs }, async ({ taskId, report, registerCancel, registerExtend }) => {
    const auditBase = { taskId, mode, role, provider: route.provider, model: route.model, execution: plan.execution, effort: route.effort || 'auto', profile };
    let unregisterCancel = () => {}; let unregisterExtend = () => {}; let activeClient = null; let turnTimeoutMs = timeoutMs;
    try {
      unregisterExtend = registerExtend((extraMs) => { turnTimeoutMs += extraMs; return activeClient ? activeClient.extendTurnTimeout(extraMs) : { extraMs, pending: true, deadlineAt: null }; });
      if (route.provider === 'third_party') {
        await report({ phase: 'integration', progress: 8, message: '正在确认 namespaced Codex provider 集成', event: { type: 'integration.start', message: '确认 Codex provider 集成' } });
        await ensureCodexIntegration({ store, codex, appServerPool });
        await report({ phase: 'integration', progress: 12, message: 'Codex provider 集成已确认', event: { type: 'integration.completed', message: 'Codex provider 集成已确认' } });
      }
      const result = await withCodexAppServer((client) => {
        activeClient = client;
        unregisterCancel = registerCancel((reason) => client.abort(reason));
        return client.runThread({ model: route.model, modelProvider: route.provider === 'third_party' ? CODEX_GATEWAY_PROVIDER_ID : 'openai', prompt: task, cwd, sandbox, effort: route.effort || 'auto', timeoutMs: turnTimeoutMs, onProgress: (message) => { const progress = progressFromNotification(message); if (progress) void report(progress); }, developerInstructions: role === 'verifier' ? 'Verify independently. Prefer inspection and tests; do not modify implementation files.' : 'Execute the assigned implementation task and report concrete results.' });
      }, { env, pool: appServerPool, overallTimeoutMs: maxTotalTimeoutMs + 5000 });
      if (result.status !== 'completed') { const error = new Error(`worker execution failed: status=${result.status || 'unknown'}`); error.code = 'WORKER_FAILED'; error.threadId = result.threadId; throw error; }
      const output = { ...plan, mode, role, provider: route.provider, model: route.model, taskId, ...result };
      await store.audit('worker.completed', { ...auditBase, threadId: result.threadId, status: result.status, error: null }).catch(() => {});
      return output;
    } catch (error) {
      if (error?.code !== 'WORKER_CANCELLED') await store.audit('worker.failed', { ...auditBase, threadId: error.threadId || null, status: isWorkerTimeout(error) ? 'timed_out' : 'failed', error: errorDetails(error) }).catch(() => {});
      throw error;
    } finally { unregisterCancel(); unregisterExtend(); activeClient = null; }
  });
}

async function cancelWorkerTask(taskId, body = {}, { store, workerJobs }) {
  const before = await workerJobs.get(taskId); if (!before) return null;
  const reason = String(body.reason || 'cancelled by operator').trim().slice(0, 500) || 'cancelled by operator';
  const task = await workerJobs.cancel(taskId, reason);
  if (task?.status === 'cancelled' && before.status !== 'cancelled') await store.audit('worker.cancelled', { taskId, mode: task.mode, role: task.role, provider: task.provider, model: task.model, execution: task.execution, threadId: task.threadId, turnId: task.turnId, reason }).catch(() => {});
  return task;
}

async function extendWorkerTask(taskId, body = {}, { store, workerJobs }) {
  const state = await store.read();
  if (state.mode === 'OFFICIAL') { const error = new Error('OFFICIAL mode disables plugin-managed Worker lease extension'); error.code='OFFICIAL_MODE_NATIVE'; error.statusCode=409; throw error; }
  if (state.mode === 'MAIN') { const error = new Error('MAIN mode disables Worker lease extension'); error.code='MAIN_MODE_LOCKED'; error.statusCode=409; throw error; }
  const task = await workerJobs.get(taskId); if (!task) return null;
  const extended = await workerJobs.extend(taskId, { extraMs: body.extraMs, reason: body.reason });
  if (extended?.extensionCount !== task.extensionCount) await store.audit('worker.extended', { taskId, mode: extended.mode, role: extended.role, provider: extended.provider, model: extended.model, execution: extended.execution, extraMs: Date.parse(extended.deadlineAt) - Date.parse(task.deadlineAt), extensionCount: extended.extensionCount, reviewAt: extended.reviewAt, deadlineAt: extended.deadlineAt, reason: String(body.reason || '主控确认 Worker 方向正常，续期继续执行').slice(0, 500) }).catch(() => {});
  return extended;
}

async function executeWorker(body, context) {
  const { workerJobs } = context;
  const started = await startWorkerTask(body, context);
  if (!started.taskId) return started;
  const waited = await workerJobs.wait(started.taskId, { timeoutMs: Number(started.maxTotalTimeoutMs || WORKER_MAX_TOTAL_TIMEOUT_MS) + 5000 });
  if (!waited || !isTerminalTask(waited)) { const error = new Error(`Worker task is still running; taskId=${started.taskId}`); error.code = 'WORKER_TIMEOUT'; error.taskId = started.taskId; throw error; }
  if (waited.status !== 'completed') { const error = new Error(waited.error?.message || `Worker task ${waited.status}`); error.code = waited.status === 'timed_out' ? 'WORKER_TIMEOUT' : waited.status === 'cancelled' ? 'WORKER_CANCELLED' : 'WORKER_FAILED'; error.taskId = started.taskId; throw error; }
  return { ...waited.result, taskId: started.taskId, task: waited };
}

async function runStandaloneMain(body, context) {
  const { store, env, codex, appServerPool } = context;
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new Error('prompt is required');
  if (Buffer.byteLength(body.prompt, 'utf8') > MAX_WORKER_TASK_BYTES) { const error = new Error(`prompt exceeds ${MAX_WORKER_TASK_BYTES} bytes`); error.statusCode = 413; throw error; }
  const state = await store.read();
  if (state.mode === 'OFFICIAL') { const error = new Error('OFFICIAL mode uses the native Codex Main and does not launch a standalone Main'); error.code='OFFICIAL_MODE_NATIVE'; error.statusCode=409; throw error; }
  const catalog = await loadCatalog(context);
  if (catalog.registry.authentication.officialOAuth) {
    const error = new Error('ChatGPT OAuth is active; Main is the official Codex root. Standalone Main execution is disabled to avoid a false provider switch.');
    error.code = 'OFFICIAL_MAIN_IS_CHATGPT_ROOT'; error.statusCode = 409; throw error;
  }
  const route = activeRouting(state, state.mode).main;
  const validated = validateRoleRoute(route, { role: 'main', registry: catalog.registry, requireModel: true });
  const rawCwd = body.cwd || process.cwd();
  if (typeof rawCwd !== 'string' || !rawCwd.trim() || rawCwd.length > MAX_CWD_LENGTH) throw new Error('cwd must be a non-empty path no longer than 4096 characters');
  const cwd = path.resolve(rawCwd);
  const stat = await fs.stat(cwd).catch(() => null); if (!stat?.isDirectory()) { const error = new Error(`cwd is not an accessible directory: ${cwd}`); error.statusCode=400; throw error; }
  if (validated.provider === 'third_party') await ensureCodexIntegration({ store, codex, appServerPool });
  const timeoutMs = Math.min(Math.max(Number(body.timeoutMs || 180000), 1000), 3600000);
  const result = await withCodexAppServer((client) => client.runThread({
    model: validated.model,
    modelProvider: validated.provider === 'third_party' ? CODEX_GATEWAY_PROVIDER_ID : 'openai',
    prompt: body.prompt,
    cwd,
    sandbox: 'workspace-write',
    effort: validated.effort,
    timeoutMs,
    developerInstructions: 'You are the standalone Main coordinator selected by Codex Worker Delegation. Respect the active Web mode. In DELEGATE coordinate via the installed delegation tools; in AUTO use them when beneficial; in MAIN perform the work yourself.'
  }), { env, pool: appServerPool, overallTimeoutMs: timeoutMs + 15000 });
  await store.audit('main.standalone_completed', { mode: state.mode, provider: validated.provider, model: validated.model, effort: validated.effort, threadId: result.threadId, status: result.status });
  return { standalone: true, mode: state.mode, provider: validated.provider, model: validated.model, ...result };
}

async function verifyCoexistence({ body, store, codex, env, appServerPool, ...context }) {
  const state = await store.read(); if (!state.provider) throw new Error('configure New API before coexistence verification');
  const catalog = await loadCatalog({ body, store, codex, env, appServerPool, ...context });
  const model = String(body.model || catalog.registry.providers.third_party.defaultModel || firstThirdPartyModel(state) || '').trim(); if (!model) throw new Error('select at least one third-party model before coexistence verification');
  validateRoleRoute({ provider:'third_party', model, effort:'auto' }, { role:'worker', registry:catalog.registry, requireModel:true });
  const selectorsBefore = inspectTopLevel(await codex.read()); const integration = await ensureCodexIntegration({ store, codex, appServerPool });
  const proof = await withCodexAppServer(async (client) => {
    const before = await client.getAccount({ refreshToken: false });
    const thread = await client.runThread({ model, modelProvider: CODEX_GATEWAY_PROVIDER_ID, prompt: 'Reply with exactly CWD_COEXISTENCE_OK. Do not use tools.', cwd: body.cwd || process.cwd(), sandbox: 'read-only', effort: 'auto', developerInstructions: 'This is a read-only provider coexistence probe. Do not use tools or modify files; answer only with the requested marker.', timeoutMs: Number(body.timeoutMs || 120000) });
    const after = await client.getAccount({ refreshToken: false }); return { before, thread, after };
  }, { env, pool: appServerPool, overallTimeoutMs: Number(body.timeoutMs || 120000) + 15000 });
  const selectorsAfter = inspectTopLevel(await codex.read()); const officialBefore = proof.before?.account?.type === 'chatgpt'; const officialAfter = proof.after?.account?.type === 'chatgpt'; const selectorStable = sameTopLevelSelectors(selectorsBefore, selectorsAfter); const thirdPartyThreadOk = proof.thread?.status === 'completed' && Boolean(proof.thread?.output?.trim()); const markerObserved = proof.thread?.output?.includes('CWD_COEXISTENCE_OK') || false;
  const result = { ok: officialBefore && officialAfter && selectorStable && thirdPartyThreadOk, officialChatGPTBefore: summarizeAccount(proof.before), officialChatGPTAfter: summarizeAccount(proof.after), thirdParty: { model, modelProvider: CODEX_GATEWAY_PROVIDER_ID, threadId: proof.thread?.threadId || null, status: proof.thread?.status || null, markerObserved }, integrationInstalled: true, integrationProviderId: integration.providerId, globalSelectorUntouched: selectorStable, selectorsBefore: publicSelectors(selectorsBefore), selectorsAfter: publicSelectors(selectorsAfter), proof: 'A third-party App Server thread completed between two account/read checks while the top-level official selector stayed byte-equivalent at the parsed selector level.' };
  await store.audit('coexistence.verified', { ok: result.ok, model, markerObserved, officialBefore, officialAfter, selectorStable }); return result;
}

function firstThirdPartyModel(state) { for (const mode of [...new Set([state.mode, 'DELEGATE', 'AUTO', 'MAIN', 'OFFICIAL'])]) { const routes = activeRouting(state, mode); for (const roleName of ['worker', 'verifier', 'main']) if (routes[roleName]?.provider === 'third_party' && routes[roleName]?.model) return routes[roleName].model; } return ''; }
function summarizeAccount(result) { const a = result?.account || null; return a ? { type: a.type || null, planType: a.planType || null, email: a.email || null, requiresOpenaiAuth: result?.requiresOpenaiAuth ?? null } : { type: null, planType: null, email: null, requiresOpenaiAuth: result?.requiresOpenaiAuth ?? null }; }
function publicSelectors(value = {}) { return Object.fromEntries(['model_provider','model'].filter((k)=>value[k]?.raw).map((k)=>[k,value[k].raw])); }

async function loadCatalog({ store, vault, env, fetchImpl, appServerPool }) {
  const state = await store.read();
  const result = {
    official: { ok: false, models: [], account: null, requiresOpenaiAuth: null, providerCapabilities: null, providerCapabilitiesError: null, error: null },
    thirdParty: { ok: false, models: [], configured: Boolean(state.provider), error: null },
    registry: null,
    reconciliation: { changes: [] },
    runtime: null
  };
  let accountRead = null;
  try {
    const official = await withCodexAppServer(async (client) => {
      const [models, account] = await Promise.all([client.listModels(), client.getAccount({ refreshToken: false })]);
      let providerCapabilities = null; let providerCapabilitiesError = null;
      try { providerCapabilities = await client.getModelProviderCapabilities(); }
      catch (error) { providerCapabilitiesError = error.message; }
      return { models, account, providerCapabilities, providerCapabilitiesError };
    }, { env, pool: appServerPool, overallTimeoutMs: 30000 });
    accountRead = official.account;
    result.official.models = official.models;
    result.official.account = official.account?.account || null;
    result.official.requiresOpenaiAuth = Boolean(official.account?.requiresOpenaiAuth);
    result.official.providerCapabilities = official.providerCapabilities;
    result.official.providerCapabilitiesError = official.providerCapabilitiesError;
    result.official.ok = true;
  } catch (error) { result.official.error = error.message; }

  if (!state.provider) result.thirdParty.error = 'New API provider is not configured';
  else {
    try {
      const apiKey = await vault.decrypt(state.provider.apiKeyCipher);
      result.thirdParty.models = await listProviderModels({ baseUrl: state.provider.baseUrl, apiKey, fetchImpl, extraHeaders: state.provider.headers });
      result.thirdParty.ok = true;
    } catch (error) { result.thirdParty.error = error.message; }
  }

  result.registry = buildModelCapabilityRegistry({
    officialModels: result.official.models,
    thirdPartyModels: result.thirdParty.models,
    accountRead,
    officialProviderCapabilities: result.official.providerCapabilities,
    thirdPartyConfigured: Boolean(state.provider)
  });
  result.reconciliation = reconcileRoutingWithRegistry(state.routing, result.registry);
  result.runtime = buildRuntimeStatus(state, result);
  return result;
}

function buildRuntimeStatus(state, catalog) {
  const mode = state.mode;
  const effectiveRouting = catalog.reconciliation.routing?.[mode] || activeRouting(state, mode);
  const roleNames = mode === 'AUTO' || mode === 'DELEGATE' ? ['main','worker','verifier'] : ['main'];
  const routeErrors = [];
  if (mode !== 'OFFICIAL') {
    for (const role of roleNames) {
      try { validateRoleRoute(effectiveRouting[role], { role, registry: catalog.registry, requireModel: true }); }
      catch (error) { routeErrors.push({ role, code: error.code || null, error: error.message }); }
    }
  }
  const thirdPartyUsed = mode !== 'OFFICIAL' && roleNames.some((role) => effectiveRouting?.[role]?.provider === 'third_party');
  const effective = mode === 'OFFICIAL'
    ? catalog.official.ok
    : routeErrors.length === 0 && catalog.official.ok && (!thirdPartyUsed || catalog.thirdParty.ok);
  return {
    mode,
    modeLabel: mode === 'OFFICIAL' ? '官方默认' : mode === 'DELEGATE' ? 'WORKER' : mode,
    effective,
    status: effective ? 'effective' : 'not_effective',
    officialOAuth: Boolean(catalog.registry.authentication.officialOAuth),
    mainProviderLocked: Boolean(catalog.registry.mainPolicy.providerLocked),
    mainPolicy: catalog.registry.mainPolicy,
    effectiveRouting,
    reconciliationChanges: catalog.reconciliation.changes,
    routeErrors,
    officialHealthy: catalog.official.ok,
    thirdPartyConfigured: catalog.thirdParty.configured,
    thirdPartyHealthy: catalog.thirdParty.ok,
    thirdPartyUsed,
    integrationInstalled: Boolean(state.installed),
    officialProviderCapabilities: catalog.official.providerCapabilities || null
  };
}

async function authPolicy({ env, host, webAuth }) {
  const configured = await webAuth.isConfigured();
  const loopback = isLoopback(host);
  const passwordlessAvailable = loopback && env.CWD_REQUIRE_AUTH === '0';
  const passwordlessLocal = loopback && env.CWD_REQUIRE_AUTH !== '1' && (!configured || (passwordlessAvailable && await webAuth.isLocalPasswordless()));
  const required = !passwordlessLocal && (configured || env.CWD_REQUIRE_AUTH === '1' || !loopback);
  return { configured, loopback, passwordlessAvailable, passwordlessLocal, required };
}
async function authorizeUi(req, env, host, webAuth) {
  const token = env.CWD_WEB_TOKEN;
  if (token && req.headers.authorization === `Bearer ${token}`) return true;
  const policy = await authPolicy({ env, host, webAuth });
  if (policy.passwordlessLocal) return true;
  return policy.configured ? webAuth.authenticated(req) : false;
}
function isLoopback(host) { return ['127.0.0.1', '::1', 'localhost'].includes(host); }
function secureCookie(env, host) { return env.CWD_COOKIE_SECURE === '1' || !isLoopback(host); }
async function authStatus({ req, env, host, webAuth }) {
  const policy = await authPolicy({ env, host, webAuth });
  return {
    configured: policy.configured,
    authenticated: policy.passwordlessLocal || (policy.configured && webAuth.authenticated(req)),
    required: policy.required,
    mode: policy.passwordlessLocal ? 'local_passwordless' : 'password',
    passwordlessLocal: policy.passwordlessLocal,
    passwordlessAvailable: policy.passwordlessAvailable,
    minPasswordLength: MIN_PASSWORD_LENGTH,
    loopback: policy.loopback
  };
}
async function ensureCodexIntegration({ store, codex, appServerPool }) {
  await store.ensureGatewayToken(); const state = await store.read();
  if (state.installed && await codex.isInstalled()) return { providerId: CODEX_GATEWAY_PROVIDER_ID, agents: ['cwd-worker', 'cwd-verifier'], topLevelPreserved: true, cached: true };
  const snap = await codex.install(); await store.update((s) => { s.installed = true; return s; }); await appServerPool?.reset(); return snap;
}
async function syncTopLevelReasoning(state, codex) {
  if (state.mode === 'OFFICIAL') return { changed:false, scope:'codex-native-default', effort:'native' };
  const main = activeRouting(state, state.mode).main;
  if (main?.provider !== 'official' || !main.effort || main.effort === 'auto') return { changed: false, scope: 'app-server-route-only', effort: main?.effort || 'auto' };
  return { ...(await codex.setReasoningEffort(main.effort)), scope: 'official-top-level-default' };
}
function validateRouting(roles, mode, registry) {
  if (!roles || typeof roles !== 'object' || Array.isArray(roles)) throw new Error('roles is required');
  const expected = mode === 'AUTO' || mode === 'DELEGATE' ? ['main','worker','verifier'] : ['main'];
  const output = {};
  for (const name of Object.keys(roles)) if (!ROLES.has(name) || !expected.includes(name)) throw new Error(`unknown or inactive role ${name} for mode ${mode}`);
  for (const name of expected) {
    const value = roles[name];
    if (!value || typeof value !== 'object') throw new Error(`${name} route is required`);
    if (!PROVIDERS.has(value.provider)) throw new Error(`${name}.provider must be official or third_party`);
    if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > MAX_MODEL_ID_LENGTH) throw new Error(`${name}.model must be a non-empty string no longer than ${MAX_MODEL_ID_LENGTH} characters`);
    if (value.effort !== undefined && (typeof value.effort !== 'string' || !value.effort.trim() || value.effort.length > MAX_EFFORT_LENGTH)) throw new Error(`${name}.effort must be auto or an upstream-advertised non-empty value`);
    const validated = validateRoleRoute(value, { role:name, registry, requireModel:true });
    output[name] = { provider:validated.provider, model:validated.model, effort:validated.effort };
  }
  return output;
}
function validateProvider(body) {
  if (!body?.baseUrl || typeof body.baseUrl !== 'string' || body.baseUrl.length > MAX_PROVIDER_URL_LENGTH) throw new Error('baseUrl is required and must be no longer than 4096 characters');
  const url = new URL(body.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('baseUrl must be an http(s) URL without embedded credentials');
  if (!['auto', 'responses', 'chat'].includes(body.protocol || 'auto')) throw new Error('protocol must be auto, responses, or chat');
}
async function testProviderModels({ models, modelKinds = new Map(), state, apiKey, fetchImpl }) {
  const results = []; let cursor = 0;
  const worker = async () => { while (cursor < models.length) { const index = cursor++; const model = models[index]; const kind = modelKinds.get(model) || modelKind(model); const startedAt = Date.now(); try { const result = await probeProvider({ baseUrl: state.provider.baseUrl, apiKey, model, kind, fetchImpl, extraHeaders: state.provider.headers, timeoutMs: 30000 }); results[index] = { model, kind, ok: result.ok === true, protocol: result.protocol, status: result.status || null, latencyMs: Date.now() - startedAt, endpointExists: result.endpointExists ?? true, error: result.error || null }; } catch (error) { results[index] = { model, kind, ok: false, protocol: 'unknown', status: null, latencyMs: Date.now() - startedAt, endpointExists: false, error: error.message }; } } };
  await Promise.all(Array.from({ length: Math.min(3, models.length) }, worker)); return results;
}
function sanitizeHeaders(headers) { if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {}; const out = {}; let count=0; for (const [k,v] of Object.entries(headers)) { if (count>=32) break; if (/^[A-Za-z0-9-]{1,64}$/.test(k) && typeof v === 'string' && v.length <= 8192 && !/[\0\r\n]/.test(v) && !['authorization','proxy-authorization','content-type','content-length','host','connection','cookie','set-cookie'].includes(k.toLowerCase())) { out[k] = v; count++; } } return out; }
function sendJson(res, status, body, headers = {}) { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', ...headers }); res.end(JSON.stringify(body)); }
async function serveStatic(urlPath, res) { const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, ''); const file = path.resolve(root, 'public', relative); const publicRoot = path.resolve(root, 'public'); if (!file.startsWith(publicRoot + path.sep) && file !== path.join(publicRoot, 'index.html')) return sendJson(res, 403, { error:'forbidden' }); try { const data = await fs.readFile(file); res.writeHead(200, { 'content-type': contentTypes[path.extname(file)] || 'application/octet-stream', 'cache-control':'no-cache' }); res.end(data); } catch (e) { if (e.code === 'ENOENT') return sendJson(res, 404, { error:'not found' }); throw e; } }
if (process.argv[1] === fileURLToPath(import.meta.url)) { const app = createApp(); app.server.listen(app.port, app.host, () => console.log(`Codex Worker Delegation: http://${app.host}:${app.port}`)); }
