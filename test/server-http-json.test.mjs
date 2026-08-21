import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createApp } from '../src/server.mjs';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

test('HTTP server returns 413 for a compressed JSON body whose decompressed form exceeds 8 MiB', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-http-limit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const app = createApp({ env: { ...process.env, CWD_DATA_DIR: path.join(dir, 'data'), CODEX_HOME: path.join(dir, '.codex') } });
  const port = await listen(app.server);
  t.after(() => app.server.close());

  const expanded = Buffer.from(JSON.stringify({ junk: 'x'.repeat(9 * 1024 * 1024) }));
  const compressed = zlib.gzipSync(expanded);
  assert.ok(compressed.length < 8 * 1024 * 1024);
  const response = await fetch(`http://127.0.0.1:${port}/api/provider`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    body: compressed
  });
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.code, 'REQUEST_TOO_LARGE');
});

test('HTTP server maps malformed JSON and unsupported content encoding to client errors', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-http-errors-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const app = createApp({ env: { ...process.env, CWD_DATA_DIR: path.join(dir, 'data'), CODEX_HOME: path.join(dir, '.codex') } });
  const port = await listen(app.server);
  t.after(() => app.server.close());

  let response = await fetch(`http://127.0.0.1:${port}/api/provider`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{broken'
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'INVALID_JSON');

  response = await fetch(`http://127.0.0.1:${port}/api/provider`, {
    method: 'PUT', headers: { 'content-type': 'application/json', 'content-encoding': 'deflate' }, body: '{}'
  });
  assert.equal(response.status, 415);
  assert.equal((await response.json()).code, 'UNSUPPORTED_CONTENT_ENCODING');
});
