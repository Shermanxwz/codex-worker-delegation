import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { vaultKeyPath } from './paths.mjs';

async function loadOrCreateKey(file) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const key = await fs.readFile(file);
    if (key.length !== 32) throw new Error('vault key must be 32 bytes');
    return key;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const key = crypto.randomBytes(32);
    await fs.writeFile(file, key, { mode: 0o600, flag: 'wx' });
    return key;
  }
}

export class SecretVault {
  constructor({ env = process.env } = {}) { this.file = vaultKeyPath(env); }
  async encrypt(text) {
    const key = await loadOrCreateKey(this.file);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
  }
  async decrypt(payload) {
    const [version, ivText, tagText, cipherText] = String(payload || '').split('.');
    if (version !== 'v1' || !cipherText) throw new Error('invalid encrypted secret');
    const key = await loadOrCreateKey(this.file);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(cipherText, 'base64url')), decipher.final()]).toString('utf8');
  }
}
