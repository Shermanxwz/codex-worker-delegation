import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { readJson } from '../src/http-json.mjs';

function request(body, headers = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)]);
  stream.headers = body === undefined ? headers : { 'content-type': 'application/json', ...headers };
  return stream;
}

async function expectHttpError(promise, statusCode, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.statusCode, statusCode);
    assert.equal(error.code, code);
    return true;
  });
}

test('readJson accepts plain, gzip, and brotli JSON within the decompressed limit', async () => {
  const payload = Buffer.from(JSON.stringify({ ok: true, text: 'hello' }));
  assert.deepEqual(await readJson(request(payload)), { ok: true, text: 'hello' });
  assert.deepEqual(await readJson(request(zlib.gzipSync(payload), { 'content-encoding': 'gzip' })), { ok: true, text: 'hello' });
  assert.deepEqual(await readJson(request(zlib.brotliCompressSync(payload), { 'content-encoding': 'br' })), { ok: true, text: 'hello' });
});

test('readJson rejects declared and streamed compressed input above the raw limit', async () => {
  await expectHttpError(readJson(request(undefined, { 'content-length': '129' }), 128), 413, 'REQUEST_TOO_LARGE');
  await expectHttpError(readJson(request(Buffer.alloc(129, 0x20)), 128), 413, 'REQUEST_TOO_LARGE');
});

test('readJson rejects a small gzip body that expands beyond the decompressed limit', async () => {
  const expanded = Buffer.from(JSON.stringify({ payload: 'x'.repeat(4096) }));
  const compressed = zlib.gzipSync(expanded);
  assert.ok(compressed.length < 256, `test fixture must stay compressed below the raw limit (found ${compressed.length})`);
  await expectHttpError(readJson(request(compressed, { 'content-encoding': 'gzip' }), 256), 413, 'REQUEST_TOO_LARGE');
});

test('readJson maps invalid compression, unsupported encoding, media type, and invalid JSON to explicit client errors', async () => {
  await expectHttpError(readJson(request('not-gzip', { 'content-encoding': 'gzip' })), 400, 'INVALID_COMPRESSION');
  await expectHttpError(readJson(request('{}', { 'content-encoding': 'deflate' })), 415, 'UNSUPPORTED_CONTENT_ENCODING');
  await expectHttpError(readJson(request('{}', { 'content-type': 'text/plain' })), 415, 'UNSUPPORTED_MEDIA_TYPE');
  await expectHttpError(readJson(request('{broken')), 400, 'INVALID_JSON');
  assert.deepEqual(await readJson(request('{"ok":true}', { 'content-type': 'application/problem+json; charset=utf-8' })), { ok: true });
});

test('readJson supports zstd when the active Node runtime provides it', async (t) => {
  if (typeof zlib.zstdCompressSync !== 'function' || typeof zlib.zstdDecompressSync !== 'function') {
    t.skip('zstd is not available in this Node runtime');
    return;
  }
  const payload = Buffer.from(JSON.stringify({ zstd: true }));
  assert.deepEqual(await readJson(request(zlib.zstdCompressSync(payload), { 'content-encoding': 'zstd' })), { zstd: true });
});
