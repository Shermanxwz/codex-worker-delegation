import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { StateStore, publicState } from './store.mjs';
import { SecretVault } from './vault.mjs';
import { ResponsesGateway } from './gateway.mjs';
import { probeProvider } from './provider.mjs';
import { CodexConfigManager } from './codex-config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentTypes = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml' };
const MODES = new Set(['AUTO', 'DELEGATE', 'MAIN']);

export function createApp({ env = process.env, fetchImpl = fetch } = {}) {
  const store = new StateStore({ env }); const vault = new SecretVault({ env });
  const gateway = new ResponsesGateway({ store, vault, fetchImpl });
  const port = Number(env.CWD_PORT || 8788); const host = env.CWD_HOST || '127.0.0.1';
  const codex = new CodexConfigManager({ env, gatewayBaseUrl: `http://127.0.0.1:${port}/v1` });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'POST' && url.pathname === '/v1/responses') return gateway.handle(req, res, await readJson(req));
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        const token = await store.ensureGatewayToken();
        if ((req.headers.authorization || '') !== `Bearer ${token}`) return sendJson(res, 401, { error: { message: 'Invalid local gateway token', type: 'authentication_error' } });
        const state = await store.read(); const names = [...new Set(Object.values(state.models || {}).filter(Boolean))];
        return sendJson(res, 200, { object: 'list', data: names.map((id) => ({ id, object: 'model', owned_by: state.provider?.name || 'third-party' })) });
      }
      if (url.pathname.startsWith('/api/')) {
        if (!authorizeUi(req, env, host)) return sendJson(res, 401, { error: 'unauthorized' });
        if (req.method === 'GET' && url.pathname === '/api/state') return sendJson(res, 200, publicState(await store.read()));
        if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true, version: '1.0.0', host, port });
        if (req.method === 'PUT' && url.pathname === '/api/mode') {
          const { mode } = await readJson(req); if (!MODES.has(mode)) return sendJson(res, 400, { error: 'mode must be AUTO, DELEGATE, or MAIN' });
          const state = await store.update((s) => { s.mode = mode; return s; }); await store.audit('mode.changed', { mode }); return sendJson(res, 200, publicState(state));
        }
        if (req.method === 'PUT' && url.pathname === '/api/provider') {
          const body = await readJson(req); validateProvider(body);
          const current = await store.read();
          const cipher = body.apiKey ? await vault.encrypt(body.apiKey) : current.provider?.apiKeyCipher;
          if (!cipher) return sendJson(res, 400, { error: 'apiKey is required on first configuration' });
          const provider = { name: body.name || 'New API', baseUrl: body.baseUrl, protocol: body.protocol || 'auto', apiKeyCipher: cipher, forwardReasoningEffort: body.forwardReasoningEffort === true, headers: sanitizeHeaders(body.headers) };
          const state = await store.update((s) => { s.provider = provider; s.models = { ...s.models, ...(body.models || {}) }; s.protocolCache = {}; return s; });
          await store.audit('provider.saved', { name: provider.name, baseUrl: provider.baseUrl, protocol: provider.protocol }); return sendJson(res, 200, publicState(state));
        }
        if (req.method === 'POST' && url.pathname === '/api/provider/probe') {
          const state = await store.read(); if (!state.provider) return sendJson(res, 400, { error: 'configure provider first' });
          const body = await readJson(req); const model = body.model || state.models.worker || state.models.main; const apiKey = await vault.decrypt(state.provider.apiKeyCipher);
          const result = await probeProvider({ baseUrl: state.provider.baseUrl, apiKey, model, fetchImpl, extraHeaders: state.provider.headers });
          if (result.protocol !== 'unknown') await store.update((s) => { s.protocolCache[model] = { protocol: result.protocol, detectedAt: new Date().toISOString(), probeOk: result.ok }; return s; });
          await store.audit('provider.probed', { model, protocol: result.protocol, ok: result.ok, status: result.status }); return sendJson(res, 200, result);
        }
        if (req.method === 'POST' && url.pathname === '/api/codex/install') {
          const state = await store.read(); const workerModel = state.models.worker || state.models.main; if (!workerModel) return sendJson(res, 400, { error: 'worker model is required' });
          await store.ensureGatewayToken(); const snap = await codex.install({ workerModel, verifierModel: state.models.verifier || workerModel });
          const next = await store.update((s) => { if (!s.originalTopLevel) s.originalTopLevel = snap.originalTopLevel; s.installed = true; return s; });
          await store.audit('codex.installed', { workerModel }); return sendJson(res, 200, publicState(next));
        }
        if (req.method === 'POST' && url.pathname === '/api/codex/third-party-main') {
          const state = await store.read(); const body = await readJson(req); const model = body.model || state.models.main || state.models.worker; if (!model) return sendJson(res, 400, { error: 'main model is required' });
          await codex.activateThirdPartyMain(model); const next = await store.update((s) => { s.mainSource = 'third_party'; s.models.main = model; return s; }); await store.audit('codex.main.third_party', { model }); return sendJson(res, 200, publicState(next));
        }
        if (req.method === 'POST' && url.pathname === '/api/codex/official') {
          const state = await store.read(); await codex.restoreOfficial(state.originalTopLevel || {}); const next = await store.update((s) => { s.mainSource = 'official'; return s; }); await store.audit('codex.main.official'); return sendJson(res, 200, publicState(next));
        }
        return sendJson(res, 404, { error: 'not found' });
      }
      return serveStatic(url.pathname, res);
    } catch (error) { console.error(error); return sendJson(res, 500, { error: error.message }); }
  });
  return { server, host, port, store };
}

function authorizeUi(req, env, host) {
  const token = env.CWD_WEB_TOKEN;
  if (!token) return ['127.0.0.1', '::1', 'localhost'].includes(host);
  return req.headers.authorization === `Bearer ${token}`;
}
function validateProvider(body) {
  if (!body?.baseUrl) throw new Error('baseUrl is required'); new URL(body.baseUrl);
  if (!['auto', 'responses', 'chat'].includes(body.protocol || 'auto')) throw new Error('protocol must be auto, responses, or chat');
}
function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {};
  const out = {}; for (const [k,v] of Object.entries(headers)) if (/^[A-Za-z0-9-]{1,64}$/.test(k) && typeof v === 'string' && k.toLowerCase() !== 'authorization') out[k] = v; return out;
}
async function readJson(req, limit = 8 * 1024 * 1024) {
  let size = 0; const chunks = []; for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('request too large'); chunks.push(Buffer.from(chunk)); }
  if (!chunks.length) return {}; let body = Buffer.concat(chunks);
  const enc = String(req.headers['content-encoding'] || '').toLowerCase().trim();
  if (enc === 'zstd') body = zlib.zstdDecompressSync(body);
  else if (enc === 'gzip') body = zlib.gunzipSync(body);
  else if (enc === 'br') body = zlib.brotliDecompressSync(body);
  else if (enc && enc !== 'identity') throw new Error(`unsupported content-encoding: ${enc}`);
  return JSON.parse(body.toString('utf8'));
}
function sendJson(res, status, body) { res.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }); res.end(JSON.stringify(body)); }
async function serveStatic(urlPath, res) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, ''); const file = path.resolve(root, 'public', relative); const publicRoot = path.resolve(root, 'public');
  if (!file.startsWith(publicRoot + path.sep) && file !== path.join(publicRoot, 'index.html')) return sendJson(res, 403, { error:'forbidden' });
  try { const data = await fs.readFile(file); res.writeHead(200, { 'content-type': contentTypes[path.extname(file)] || 'application/octet-stream', 'cache-control':'no-cache' }); res.end(data); }
  catch (e) { if (e.code === 'ENOENT') return sendJson(res, 404, { error:'not found' }); throw e; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createApp(); app.server.listen(app.port, app.host, () => console.log(`Codex Worker Delegation: http://${app.host}:${app.port}`));
}
