import { endpoints, providerHeaders, shouldTryChatFallback } from './provider.mjs';
import { responsesToChat, convertChatSse, chatJsonToResponses } from './translate.mjs';

const MAX_ERROR_BODY_BYTES = 64 * 1024;
const MAX_NONSTREAM_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 65 * 60 * 1000;

function providerRequestTimeoutMs(env = process.env) {
  const parsed = Number(env.CWD_PROVIDER_REQUEST_TIMEOUT_MS || DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS);
  if (!Number.isFinite(parsed)) return DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;
  return Math.max(1000, Math.min(2 * 60 * 60 * 1000, Math.trunc(parsed)));
}

async function readBodyLimited(response, maxBytes) {
  if (!response.body) return '';
  const decoder = new TextDecoder(); let text = ''; let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('upstream response size limit exceeded').catch(() => {});
        const error = new Error(`upstream response exceeded ${maxBytes} bytes`); error.code = 'UPSTREAM_RESPONSE_TOO_LARGE'; throw error;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

function requestAbortScope(req, res, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => { if (!controller.signal.aborted) controller.abort(Object.assign(new Error(`provider request exceeded ${timeoutMs}ms`), { code: 'PROVIDER_REQUEST_TIMEOUT' })); }, timeoutMs);
  timeout.unref?.();
  const downstreamClosed = () => { if (!res.writableEnded && !controller.signal.aborted) controller.abort(Object.assign(new Error('downstream Codex connection closed'), { code: 'DOWNSTREAM_CLOSED' })); };
  req.once('aborted', downstreamClosed); res.once('close', downstreamClosed);
  return { signal: controller.signal, cleanup() { clearTimeout(timeout); req.off('aborted', downstreamClosed); res.off('close', downstreamClosed); } };
}

function hasExplicitRouteEffort(state, model, effort) {if (!state?.routing || !model || !effort || effort === 'auto') return false;return Object.values(state.routing).some((routes) => Object.values(routes || {}).some((route) => route?.provider === 'third_party' && route.model === model && route.effort === effort));}
function withoutForwardedReasoning(body, provider, state) {if (provider.forwardReasoningEffort === true || !body?.reasoning?.effort || hasExplicitRouteEffort(state, body.model, body.reasoning.effort)) return body;const reasoning = { ...body.reasoning };delete reasoning.effort;const next = { ...body };if (Object.keys(reasoning).length) next.reasoning = reasoning;else delete next.reasoning;return next;}

export class ResponsesGateway {
  constructor({ store, vault, fetchImpl = fetch }) { this.store = store; this.vault = vault; this.fetchImpl = fetchImpl; this.env = store?.env || process.env; }

  async handle(req, res, body) {
    const scope = requestAbortScope(req, res, providerRequestTimeoutMs(this.env));
    try {
      const state = await this.store.read();const provider = state.provider;
      if (!provider) return json(res, 503, { error: { message: 'No third-party provider configured', type: 'configuration_error' } });
      const token = await this.store.ensureGatewayToken();
      if ((req.headers.authorization || '') !== `Bearer ${token}`) return json(res, 401, { error: { message: 'Invalid local gateway token', type: 'authentication_error' } });
      const apiKey = provider.apiKeyCipher ? await this.vault.decrypt(provider.apiKeyCipher) : '';
      const model = body.model || state.models.main || state.models.worker;if (!model) return json(res, 400, { error: { message: 'Model is required', type: 'invalid_request_error' } });
      body = { ...body, model };const ep = endpoints(provider.baseUrl);const headers = providerHeaders(provider, apiKey);const cached = state.protocolCache?.[model];const protocol = provider.protocol === 'auto' ? cached?.protocol : provider.protocol;
      if (protocol === 'chat') return await this.#chat(res, body, ep.chat, headers, provider, state, scope.signal);
      if (protocol === 'responses') return await this.#responses(res, withoutForwardedReasoning(body, provider, state), ep.responses, headers, scope.signal);
      const upstream = await this.fetchImpl(ep.responses, { method: 'POST', headers, body: JSON.stringify(withoutForwardedReasoning(body, provider, state)), signal: scope.signal });
      if (!upstream.ok) {
        // Consume the actual failed body under a hard cap. Do not clone/tee it:
        // cancelling only one tee branch can wait forever for its unread sibling.
        const errorText = await readBodyLimited(upstream, MAX_ERROR_BODY_BYTES);
        if (shouldTryChatFallback(upstream.status, errorText)) {
          await this.#cache(model, 'chat');
          return await this.#chat(res, body, ep.chat, headers, provider, state, scope.signal);
        }
        return pipeBuffered(upstream, res, errorText);
      }
      await this.#cache(model, 'responses');return await pipeFetch(upstream, res);
    } catch (error) {
      if (res.destroyed || error?.code === 'DOWNSTREAM_CLOSED' || scope.signal.reason?.code === 'DOWNSTREAM_CLOSED') return;
      if (scope.signal.aborted && scope.signal.reason?.code === 'PROVIDER_REQUEST_TIMEOUT') return json(res, 504, { error: { message: scope.signal.reason.message, type: 'upstream_timeout' } });
      throw error;
    } finally { scope.cleanup(); }
  }

  async #responses(res, body, url, headers, signal) { return pipeFetch(await this.fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal }), res); }
  async #chat(res, body, url, headers, provider, state, signal) {
    const chatBody = responsesToChat(withoutForwardedReasoning(body, provider, state), { forwardReasoningEffort: true });
    const upstream = await this.fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(chatBody), signal });
    if (!upstream.ok) return pipeFetch(upstream, res);
    if (body.stream === false) {
      const text = await readBodyLimited(upstream, MAX_NONSTREAM_BODY_BYTES);let parsed;try { parsed = JSON.parse(text); } catch { const error = new Error('upstream Chat Completions response was not valid JSON'); error.code='UPSTREAM_INVALID_JSON'; throw error; }
      return json(res, 200, await chatJsonToResponses(parsed, body.model));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    await convertChatSse(upstream.body, (chunk) => writeWithBackpressure(res, chunk), { model: body.model });
    if (!res.destroyed && !res.writableEnded) res.end();
  }
  async #cache(model, protocol) { await this.store.update((s) => { s.protocolCache ||= {}; s.protocolCache[model] = { protocol, detectedAt: new Date().toISOString() }; return s; }); }
}

async function writeWithBackpressure(res, chunk) {
  if (!chunk || res.destroyed || res.writableEnded) return;
  if (res.write(chunk)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => { res.off('drain', onDrain); res.off('close', onClose); res.off('error', onError); };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); const error = new Error('downstream response closed'); error.code='DOWNSTREAM_CLOSED'; reject(error); };
    const onError = (error) => { cleanup(); reject(error); };
    res.once('drain', onDrain); res.once('close', onClose); res.once('error', onError);
  });
}

function responseHeaders(upstream) { const headers = {};for (const key of ['content-type', 'cache-control', 'x-request-id', 'openai-model']) { const v = upstream.headers.get(key); if (v) headers[key] = v; }return headers; }
function pipeBuffered(upstream, res, text) { if (res.destroyed || res.writableEnded) return; res.writeHead(upstream.status, responseHeaders(upstream)); res.end(text); }
export async function pipeFetch(upstream, res) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(upstream.status, responseHeaders(upstream));if (!upstream.body) return res.end();
  for await (const chunk of upstream.body) await writeWithBackpressure(res, chunk);
  if (!res.destroyed && !res.writableEnded) res.end();
}
function json(res, status, value) { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
