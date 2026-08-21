import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { vaultKeyPath } from './paths.mjs';

async function syncDirectory(directory) {
  let handle;
  try { handle = await fs.open(directory, 'r'); await handle.sync(); }
  finally { if (handle) await handle.close().catch(() => {}); }
}

async function readKey(file) {
  const key = await fs.readFile(file);
  if (key.length !== 32) throw new Error('vault key must be 32 bytes');
  await fs.chmod(file, 0o600).catch(() => {});
  return key;
}

async function loadOrCreateKey(file) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try { return await readKey(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  const key = crypto.randomBytes(32);
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.keytmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(key);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.chmod(temporary, 0o600).catch(() => {});
    try {
      // link(2) publishes a fully written inode atomically without replacing a
      // key another process may have won first. fsync the containing directory
      // before returning so an encrypted state write can never outrun the key's
      // durable directory entry after a sudden power loss.
      await fs.link(temporary, file);
      await fs.chmod(file, 0o600).catch(() => {});
      await syncDirectory(directory);
      return key;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return await readKey(file);
    }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
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
    const iv = Buffer.from(ivText || '', 'base64url');
    const tag = Buffer.from(tagText || '', 'base64url');
    if (iv.length !== 12 || tag.length !== 16) throw new Error('invalid encrypted secret');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(cipherText, 'base64url')), decipher.final()]).toString('utf8');
  }
}
