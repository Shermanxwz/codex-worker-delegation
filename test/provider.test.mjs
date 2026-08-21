import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { endpoints, listProviderModels, probeProvider } from '../src/provider.mjs';

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

test('normalizes root, /v1, and concrete endpoints', () => {
  assert.equal(new URL(endpoints('https://x.test').responses).pathname, '/v1/responses');
  assert.equal(new URL(endpoints('https://x.test/v1').chat).pathname, '/v1/chat/completions');
  assert.equal(new URL(endpoints('https://x.test/v1/responses').chat).pathname, '/v1/chat/completions');
  assert.equal(new URL(endpoints('https://x.test/v1/chat/completions').models).pathname, '/v1/models');
  assert.throws(() => endpoints('ftp://x.test/v1'), /http or https/);
  assert.throws(() => endpoints('https://u:p@x.test/v1'), /credentials/);
});

test('reads and normalizes third-party /v1/models catalog', async (t) => {
  const { server, base } = await listen((req, res) => {
    assert.equal(req.url, '/v1/models');
    assert.equal(req.headers.authorization, 'Bearer k');
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({data:[{id:'model-a',owned_by:'vendor'},{id:'model-b',display_name:'Model B'},{id:'model-a'}]}));
  });
  t.after(() => server.close());
  const models = await listProviderModels({ baseUrl: base, apiKey:'k' });
  assert.deepEqual(models, [
    {id:'model-a',name:'model-a',ownedBy:'vendor'},
    {id:'model-b',name:'Model B',ownedBy:null}
  ]);
});

test('probe chooses native Responses when endpoint succeeds', async (t) => {
  const { server, base } = await listen((req, res) => {
    assert.equal(req.url, '/v1/responses');
    res.writeHead(200, {'content-type':'application/json'}); res.end('{"id":"resp"}');
  });
  t.after(() => server.close());
  const result = await probeProvider({ baseUrl: base, apiKey:'k', model:'m' });
  assert.equal(result.protocol, 'responses'); assert.equal(result.ok, true);
});

test('probe falls back only on unsupported Responses endpoint', async (t) => {
  let chatSeen = false;
  const { server, base } = await listen((req, res) => {
    if (req.url === '/v1/responses') { res.writeHead(404); res.end('route not found'); return; }
    if (req.url === '/v1/chat/completions') { chatSeen = true; res.writeHead(200, {'content-type':'application/json'}); res.end('{"choices":[]}'); return; }
    res.writeHead(500).end();
  });
  t.after(() => server.close());
  const result = await probeProvider({ baseUrl: base, apiKey:'k', model:'m' });
  assert.equal(result.protocol, 'chat'); assert.equal(result.ok, true); assert.equal(chatSeen, true);
});

test('probe falls back when a Responses shim exposes a Chat-shaped validation error', async (t) => {
  let chatSeen = false;
  const { server, base } = await listen((req, res) => {
    if (req.url === '/v1/responses') { res.writeHead(400); res.end('{"error":{"message":"missing required parameter: expr_path=messages"}}'); return; }
    if (req.url === '/v1/chat/completions') { chatSeen = true; res.writeHead(200, {'content-type':'text/event-stream'}); res.end('data: [DONE]\n\n'); return; }
    res.writeHead(500).end();
  });
  t.after(() => server.close());
  const result = await probeProvider({ baseUrl: base, apiKey:'k', model:'m' });
  assert.equal(result.protocol, 'chat'); assert.equal(result.ok, true); assert.equal(chatSeen, true);
});

test('probe does not mask authentication/model errors as chat-only', async (t) => {
  let chatSeen = false;
  const { server, base } = await listen((req, res) => {
    if (req.url === '/v1/responses') { res.writeHead(401); res.end('{"error":"bad key"}'); return; }
    chatSeen = true; res.writeHead(200).end('{}');
  });
  t.after(() => server.close());
  const result = await probeProvider({ baseUrl: base, apiKey:'bad', model:'m' });
  assert.equal(result.protocol, 'responses'); assert.equal(result.ok, false); assert.equal(result.endpointExists, true); assert.equal(chatSeen, false);
});
