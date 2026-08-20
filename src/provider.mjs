const UNSUPPORTED_CODES = new Set([404, 405, 410, 501]);
const UNSUPPORTED_PATTERNS = [
  /not\s+found/i, /unsupported.*(endpoint|api|responses)/i, /unknown.*(endpoint|path)/i,
  /responses.*(not supported|unsupported|disabled)/i, /no route/i
];

export function endpoints(baseUrl) {
  const u = new URL(baseUrl);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Provider URL must use http or https');
  if (u.username || u.password) throw new Error('Provider URL must not contain credentials');
  u.hash = ''; u.search = '';
  let p = u.pathname.replace(/\/+$/, '');
  if (p.endsWith('/v1/responses')) {
    const root = p.slice(0, -'/responses'.length);
    return { responses: withPath(u, p), chat: withPath(u, `${root}/chat/completions`), apiRoot: withPath(u, root) };
  }
  if (p.endsWith('/v1/chat/completions')) {
    const root = p.slice(0, -'/chat/completions'.length);
    return { responses: withPath(u, `${root}/responses`), chat: withPath(u, p), apiRoot: withPath(u, root) };
  }
  if (!p.endsWith('/v1')) p = `${p}/v1`.replace(/^\/\//, '/');
  return { responses: withPath(u, `${p}/responses`), chat: withPath(u, `${p}/chat/completions`), apiRoot: withPath(u, p) };
}

function withPath(url, pathname) { const u = new URL(url); u.pathname = pathname || '/'; return u.toString(); }
export function unsupportedEndpoint(status, bodyText = '') { return UNSUPPORTED_CODES.has(status) || UNSUPPORTED_PATTERNS.some((r) => r.test(bodyText)); }

function authHeaders(apiKey, extraHeaders = {}) {
  return { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...extraHeaders };
}

export async function probeProvider({ baseUrl, apiKey, model, timeoutMs = 10000, fetchImpl = fetch, extraHeaders = {} }) {
  if (!model?.trim()) throw new Error('model is required for protocol detection');
  const ep = endpoints(baseUrl);
  const common = { method: 'POST', headers: authHeaders(apiKey, extraHeaders), signal: AbortSignal.timeout(timeoutMs) };
  const responsesBody = { model, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply only OK' }] }], max_output_tokens: 1, stream: false };
  const rr = await fetchImpl(ep.responses, { ...common, body: JSON.stringify(responsesBody) });
  const rrText = await rr.text();
  if (rr.ok) return { protocol: 'responses', ok: true, endpoint: ep.responses, status: rr.status };
  if (!unsupportedEndpoint(rr.status, rrText)) {
    return { protocol: 'responses', ok: false, endpoint: ep.responses, status: rr.status, error: trimError(rrText), endpointExists: true };
  }

  const chatBody = { model, messages: [{ role: 'user', content: 'Reply only OK' }], max_tokens: 1, stream: false };
  const cr = await fetchImpl(ep.chat, { ...common, body: JSON.stringify(chatBody) });
  const crText = await cr.text();
  if (cr.ok) return { protocol: 'chat', ok: true, endpoint: ep.chat, status: cr.status, responsesStatus: rr.status };
  return { protocol: unsupportedEndpoint(cr.status, crText) ? 'unknown' : 'chat', ok: false, endpoint: ep.chat, status: cr.status, error: trimError(crText), responsesStatus: rr.status, endpointExists: !unsupportedEndpoint(cr.status, crText) };
}

function trimError(text) { return String(text || '').replace(/\s+/g, ' ').slice(0, 500); }
export function providerHeaders(provider, apiKey) { return authHeaders(apiKey, provider?.headers || {}); }
