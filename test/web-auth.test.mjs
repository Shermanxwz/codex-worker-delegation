import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebAuth, passwordError } from '../src/web-auth.mjs';

test('web auth stores only a salted scrypt hash and authenticates expiring sessions', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-auth-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const auth = new WebAuth({ env: { CWD_DATA_DIR: dir } });
  assert.match(passwordError('short'), /at least 14/);
  assert.equal(passwordError('CorrectHorseBatteryStaple!'), null);
  await auth.setPassword('CorrectHorseBatteryStaple!');
  const stored = JSON.parse(await fs.readFile(path.join(dir, 'web-auth.json'), 'utf8'));
  assert.equal(stored.algorithm, 'scrypt');
  assert.doesNotMatch(JSON.stringify(stored), /CorrectHorseBatteryStaple/);
  assert.equal(await auth.verifyPassword('wrong'), false);
  const token = await auth.login('CorrectHorseBatteryStaple!', 'test-client');
  const request = { headers: { cookie: `cwd_session=${token}` } };
  assert.equal(auth.authenticated(request), true);
  auth.clear(request);
  assert.equal(auth.authenticated(request), false);
});
