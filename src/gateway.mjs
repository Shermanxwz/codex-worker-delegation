import { endpoints, providerHeaders, shouldTryChatFallback } from './provider.mjs';
import { responsesToChat, convertChatSse, chatJsonToResponses } from './translate.mjs';

async function readErrorBody(response) { try { return await response.clone().text(); } catch { return ''; } }

function hasExplicitRouteEffort(state, model, effort) {
  if (!state?.routing || !model || !effort || effort === 'auto') return false;
  return Object.values(state.routing).some((routes) => Object.values(routes || {}).some((route) =>
    route?.provider === 'third_party' && route.model === model && route.effort === effort
  ));
}

function withoutForwardedReasoning(body, provider, state) {
  if (provider.forwardReasoningEffort === true || !body?.reasoning?.effort || hasExplicitRouteEffort(state, body.model, body.reasoning.effort)) return body;
  const reasoning = { ...body.reasoning };
  delete reasoning.effort;
  const next = { ...body };
  if (Object.keys(reasoning).length) next.reasoning = reasoning;
  else delete next.reasoning;
  return next;
}

export class ResponsesGateway {
  constructor({ store, vault, fetchImpl = fetch }) { this.store = store; this.vault = vault; this.fetchImpl = fetchImpl; }

  async handle(req, res, body) {
    const state = await this.store.read();
    const provider = state.provider;
    if (!provider) return json(res, 503, { error: { message: 'No third-party provider configured', type: 'configuration_error' } });
    const token = await this.store.ensureGatewayToken();
    if ((req.headers.authorization || '') !== `Bearer ${token}`) return json(res, 401, { error: { message: 'Invalid local gateway token', type: 'authentication_error' } });
    const apiKey = provider.apiKeyCipher ? await this.vault.decrypt(provider.apiKeyCipher) : '';
    const model = body.model || state.models.main || state.models.worker;
    if (!model) return json(res, 400, { error: { message: 'Model is required', type: 'invalid_request_error' } });
    body = { ...body, model };
    const ep = endpoints(provider.baseUrl);
    const headers = providerHeaders(provider, apiKey);
    const cached = state.protocolCache?.[model];
    const protocol = provider.protocol === 'auto' ? cached?.protocol : provider.protocol;

    if (protocol === 'chat') return this.#chat(res, body, ep.chat, headers, provider, state);
    if (protocol === 'responses') return this.#responses(res, withoutForwardedReasoning(body, provider, state), ep.responses, headers);

    const upstream = await this.fetchImpl(ep.responses, { method: 'POST', headers, body: JSON.stringify(withoutForwardedReasoning(body, provider, state)) });
    if (!upstream.ok) {
      const errorText = await readErrorBody(upstream);
      if (shouldTryChatFallback(upstream.status, errorText)) {
        await this.#cache(model, 'chat');
        return this.#chat(res, body, ep.chat, headers, provider, state);
      }
    }
    if (upstream.ok) await this.#cache(model, 'responses');
    return pipeFetch(upstream, res);
  }

  async #responses(res, body, url, headers) {
    return pipeFetch(await this.fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) }), res);
  }

  async #chat(res, body, url, headers, provider, state) {
    const chatBody = responsesToChat(withoutForwardedReasoning(body, provider, state), { forwardReasoningEffort: true });
    const upstream = await this.fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(chatBody) });
    if (!upstream.ok) return pipeFetch(upstream, res);
    if (body.stream === false) return json(res, 200, await chatJsonToResponses(await upstream.json(), body.model));
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    await convertChatSse(upstream.body, (chunk) => { if (chunk) res.write(chunk); }, { model: body.model });
    res.end();
  }

  async #cache(model, protocol) {
    await this.store.update((s) => { s.protocolCache ||= {}; s.protocolCache[model] = { protocol, detectedAt: new Date().toISOString() }; return s; });
  }
}

export async function pipeFetch(upstream, res) {
  const headers = {};
  for (const key of ['content-type', 'cache-control', 'x-request-id', 'openai-model']) { const v = upstream.headers.get(key); if (v) headers[key] = v; }
  res.writeHead(upstream.status, headers);
  if (!upstream.body) return res.end();
  for await (const chunk of upstream.body) res.write(chunk);
  res.end();
}

function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
