import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SecretVault } from '../src/vault.mjs';

test('vault encrypts with AES-GCM material stored as a 0600 32-byte key', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-vault-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const env = { CWD_DATA_DIR: dir };
  const vault = new SecretVault({ env });
  const encrypted = await vault.encrypt('super-secret');
  assert.doesNotMatch(encrypted, /super-secret/);
  assert.equal(await vault.decrypt(encrypted), 'super-secret');
  const key = path.join(dir, 'master.key');
  assert.equal((await fs.readFile(key)).length, 32);
  assert.equal((await fs.stat(key)).mode & 0o777, 0o600);
});

test('concurrent first-use vault instances converge on one complete master key', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-vault-race-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const env = { CWD_DATA_DIR: dir };
  const vaults = Array.from({ length: 24 }, () => new SecretVault({ env }));
  const ciphertexts = await Promise.all(vaults.map((vault, index) => vault.encrypt(`secret-${index}`)));
  const verifier = new SecretVault({ env });
  for (let index = 0; index < ciphertexts.length; index += 1) {
    assert.equal(await verifier.decrypt(ciphertexts[index]), `secret-${index}`);
  }
  const key = path.join(dir, 'master.key');
  assert.equal((await fs.readFile(key)).length, 32);
  const files = await fs.readdir(dir);
  assert.equal(files.some((name) => name.includes('.keytmp')), false);
});

test('vault rejects malformed GCM IV/tag material before attempting decryption', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-vault-malformed-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const vault = new SecretVault({ env: { CWD_DATA_DIR: dir } });
  await vault.encrypt('seed-key');
  await assert.rejects(() => vault.decrypt('v1.AA.AA.AA'), /invalid encrypted secret/);
  await assert.rejects(() => vault.decrypt('v2.anything.anything.anything'), /invalid encrypted secret/);
});
