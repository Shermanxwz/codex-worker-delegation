const UNSUPPORTED_CODES = new Set([404, 405, 410, 501]);
const UNSUPPORTED_PATTERNS = [/not\s+found/i,/unsupported.*(endpoint|api|responses)/i,/unknown.*(endpoint|path)/i,/responses.*(not supported|unsupported|disabled)/i,/no route/i];
const FORBIDDEN_EXTRA_HEADERS = new Set(['authorization','proxy-authorization','content-type','content-length','host','connection','keep-alive','transfer-encoding','te','trailer','upgrade','cookie','set-cookie']);
const MAX_EXTRA_HEADERS = 32;
const MAX_EXTRA_HEADER_VALUE = 8192;
const MAX_PROVIDER_BODY_BYTES = 8 * 1024 * 1024;
const MAX_PROVIDER_ERROR_BYTES = 64 * 1024;
const MAX_MODELS = 2000;
const MAX_MODEL_ID_LENGTH = 512;
const MAX_MODEL_NAME_LENGTH = 1024;

export function endpoints(baseUrl) {
  const u = new URL(baseUrl); if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Provider URL must use http or https'); if (u.username || u.password) throw new Error('Provider URL must not contain credentials'); u.hash = ''; u.search = '';
  let p = u.pathname.replace(/\/+$/, '');
  if (p.endsWith('/v1/responses')) { const root = p.slice(0, -'/responses'.length); return { responses: withPath(u, p), chat: withPath(u, `${root}/chat/completions`), models: withPath(u, `${root}/models`), apiRoot: withPath(u, root) }; }
  if (p.endsWith('/v1/chat/completions')) { const root = p.slice(0, -'/chat/completions'.length); return { responses: withPath(u, `${root}/responses`), chat: withPath(u, p), models: withPath(u, `${root}/models`), apiRoot: withPath(u, root) }; }
  if (p.endsWith('/v1/models')) { const root = p.slice(0, -'/models'.length); return { responses: withPath(u, `${root}/responses`), chat: withPath(u, `${root}/chat/completions`), models: withPath(u, p), apiRoot: withPath(u, root) }; }
  if (!p.endsWith('/v1')) p = `${p}/v1`.replace(/^\/\//, '/');
  return { responses: withPath(u, `${p}/responses`), chat: withPath(u, `${p}/chat/completions`), models: withPath(u, `${p}/models`), apiRoot: withPath(u, p) };
}
function withPath(url, pathname) { const u = new URL(url); u.pathname = pathname || '/'; return u.toString(); }
export function unsupportedEndpoint(status, bodyText = '') { return UNSUPPORTED_CODES.has(status) || UNSUPPORTED_PATTERNS.some((r) => r.test(bodyText)); }
const PROTOCOL_MISMATCH_PATTERNS = [/expr_path\s*=\s*messages/i,/missing\s+(?:required\s+)?(?:parameter|field).*messages/i,/messages.*(?:missing|required|too short)/i,/['"]messages['"]/i,/stream\s+must\s+be\s+set\s+to\s+true/i,/invalid\s+input\s+type/i,/convert_request_failed/i,/not\s+implemented/i];
export function shouldTryChatFallback(status, bodyText = '') { return unsupportedEndpoint(status, bodyText) || (status >= 500 && status < 504) || (status !== 401 && status !== 403 && PROTOCOL_MISMATCH_PATTERNS.some((pattern) => pattern.test(bodyText))); }

export function sanitizeProviderHeaders(extraHeaders = {}) {
  if (!extraHeaders || typeof extraHeaders !== 'object' || Array.isArray(extraHeaders)) return {};
  const out = {}; let accepted = 0;
  for (const [rawName, rawValue] of Object.entries(extraHeaders)) { if (accepted >= MAX_EXTRA_HEADERS) break; const name = String(rawName); const lower = name.toLowerCase(); if (!/^[A-Za-z0-9-]{1,64}$/.test(name) || FORBIDDEN_EXTRA_HEADERS.has(lower)) continue; if (typeof rawValue !== 'string' || rawValue.length > MAX_EXTRA_HEADER_VALUE || /[\0\r\n]/.test(rawValue)) continue; out[name] = rawValue; accepted += 1; }
  return out;
}
function authHeaders(apiKey, extraHeaders = {}) { return { ...sanitizeProviderHeaders(extraHeaders), 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }; }

async function readTextLimited(response, limit, label) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error(`${label} exceeds ${limit} bytes`);
  if (!response.body) return '';
  const chunks=[]; let total=0;
  for await (const chunk of response.body) { const bytes=Buffer.from(chunk); total+=bytes.length; if(total>limit){try{await response.body.cancel?.()}catch{}throw new Error(`${label} exceeds ${limit} bytes`)} chunks.push(bytes); }
  return Buffer.concat(chunks).toString('utf8');
}
async function discardBody(response) { try { await response.body?.cancel?.(); } catch {} }

export async function listProviderModels({ baseUrl, apiKey, timeoutMs = 10000, fetchImpl = fetch, extraHeaders = {} }) {
  const ep = endpoints(baseUrl);
  const response = await fetchImpl(ep.models, { method: 'GET', headers: authHeaders(apiKey, extraHeaders), signal: AbortSignal.timeout(timeoutMs) });
  const text = await readTextLimited(response, response.ok ? MAX_PROVIDER_BODY_BYTES : MAX_PROVIDER_ERROR_BYTES, 'provider model catalog');
  if (!response.ok) throw new Error(`model listing failed (${response.status}): ${trimError(text)}`);
  let parsed; try { parsed = JSON.parse(text); } catch { throw new Error('model listing did not return JSON'); }
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.data) ? parsed.data : Array.isArray(parsed?.models) ? parsed.models : [];
  if (rows.length > MAX_MODELS) throw new Error(`model listing returned more than ${MAX_MODELS} models`);
  const seen = new Set(); const normalized=[];
  for (const item of rows) {
    const rawId = typeof item === 'string' ? item : item?.id || item?.name || item?.model; if (rawId === undefined || rawId === null) continue;
    const id=String(rawId).trim(); if(!id || id.length>MAX_MODEL_ID_LENGTH) continue; if(seen.has(id))continue; seen.add(id);
    const rawName=String(item?.display_name || item?.displayName || item?.name || id); const model={ id, name: rawName.slice(0,MAX_MODEL_NAME_LENGTH), ownedBy: item?.owned_by || item?.ownedBy || null };
    const supportedReasoningEfforts = item?.supportedReasoningEfforts || item?.supported_reasoning_levels; const defaultReasoningEffort = item?.defaultReasoningEffort || item?.default_reasoning_level;
    if (supportedReasoningEfforts) model.supportedReasoningEfforts = supportedReasoningEfforts; if (defaultReasoningEffort) model.defaultReasoningEffort = defaultReasoningEffort; normalized.push(model);
  }
  return normalized;
}

export async function probeProvider({ baseUrl, apiKey, model, timeoutMs = 10000, fetchImpl = fetch, extraHeaders = {} }) {
  const normalizedModel=String(model||'').trim(); if (!normalizedModel) throw new Error('model is required for protocol detection'); if(normalizedModel.length>MAX_MODEL_ID_LENGTH)throw new Error(`model exceeds ${MAX_MODEL_ID_LENGTH} characters`);
  const ep = endpoints(baseUrl); const common = { method: 'POST', headers: authHeaders(apiKey, extraHeaders), signal: AbortSignal.timeout(timeoutMs) };
  const responsesBody = { model: normalizedModel, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply only OK' }] }], max_output_tokens: 1, stream: true };
  const rr = await fetchImpl(ep.responses, { ...common, body: JSON.stringify(responsesBody) });
  if (rr.ok) { await discardBody(rr); return { protocol: 'responses', ok: true, endpoint: ep.responses, status: rr.status }; }
  const rrText = await readTextLimited(rr, MAX_PROVIDER_ERROR_BYTES, 'provider Responses error');
  if (!shouldTryChatFallback(rr.status, rrText)) return { protocol: 'responses', ok: false, endpoint: ep.responses, status: rr.status, error: trimError(rrText), endpointExists: true };
  const chatBody = { model: normalizedModel, messages: [{ role: 'user', content: 'Reply only OK' }], max_tokens: 1, stream: true };
  const cr = await fetchImpl(ep.chat, { ...common, body: JSON.stringify(chatBody) });
  if (cr.ok) { await discardBody(cr); return { protocol: 'chat', ok: true, endpoint: ep.chat, status: cr.status, responsesStatus: rr.status }; }
  const crText = await readTextLimited(cr, MAX_PROVIDER_ERROR_BYTES, 'provider Chat error');
  return { protocol: shouldTryChatFallback(cr.status, crText) ? 'unknown' : 'chat', ok: false, endpoint: ep.chat, status: cr.status, error: trimError(crText), responsesStatus: rr.status, endpointExists: !shouldTryChatFallback(cr.status, crText) };
}
function trimError(text) { return String(text || '').replace(/\s+/g, ' ').slice(0, 500); }
export function providerHeaders(provider, apiKey) { return authHeaders(apiKey, provider?.headers || {}); }
