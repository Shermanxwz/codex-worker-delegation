import zlib from 'node:zlib';

export const DEFAULT_JSON_LIMIT = 8 * 1024 * 1024;

function httpError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function decompressionError(error, encoding, limit) {
  if (error?.code === 'ERR_BUFFER_TOO_LARGE' || /maxoutputlength|output.*too large|buffer.*too large/i.test(String(error?.message || ''))) {
    return httpError(`decompressed request exceeds ${limit} bytes`, 413, 'REQUEST_TOO_LARGE');
  }
  return httpError(`invalid ${encoding} request body`, 400, 'INVALID_COMPRESSION');
}

function isJsonContentType(value) {
  const mediaType = String(value || '').split(';', 1)[0].trim().toLowerCase();
  return mediaType === 'application/json' || (mediaType.startsWith('application/') && mediaType.endsWith('+json'));
}

export async function readJson(req, limit = DEFAULT_JSON_LIMIT) {
  const normalizedLimit = Number(limit);
  if (!Number.isSafeInteger(normalizedLimit) || normalizedLimit < 1) throw new TypeError('JSON body limit must be a positive safe integer');
  const declared = Number(req.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > normalizedLimit) throw httpError(`request exceeds ${normalizedLimit} bytes`, 413, 'REQUEST_TOO_LARGE');

  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > normalizedLimit) throw httpError(`request exceeds ${normalizedLimit} bytes`, 413, 'REQUEST_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  if (!chunks.length) return {};
  if (!isJsonContentType(req.headers?.['content-type'])) throw httpError('request body must use application/json', 415, 'UNSUPPORTED_MEDIA_TYPE');

  let body = Buffer.concat(chunks);
  const encoding = String(req.headers?.['content-encoding'] || '').toLowerCase().trim();
  const options = { maxOutputLength: normalizedLimit };
  try {
    if (encoding === 'gzip') body = zlib.gunzipSync(body, options);
    else if (encoding === 'br') body = zlib.brotliDecompressSync(body, options);
    else if (encoding === 'zstd') {
      if (typeof zlib.zstdDecompressSync !== 'function') throw httpError('zstd request bodies require a Node.js runtime with zstd support', 415, 'UNSUPPORTED_CONTENT_ENCODING');
      body = zlib.zstdDecompressSync(body, options);
    } else if (encoding && encoding !== 'identity') {
      throw httpError(`unsupported content-encoding: ${encoding}`, 415, 'UNSUPPORTED_CONTENT_ENCODING');
    }
  } catch (error) {
    if (error?.statusCode) throw error;
    throw decompressionError(error, encoding, normalizedLimit);
  }
  if (body.length > normalizedLimit) throw httpError(`decompressed request exceeds ${normalizedLimit} bytes`, 413, 'REQUEST_TOO_LARGE');

  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw httpError('invalid JSON request body', 400, 'INVALID_JSON');
  }
}
