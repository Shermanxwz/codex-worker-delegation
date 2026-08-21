import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { dataDir } from './paths.mjs';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'cwd_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 14;

function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function passwordError(password) {
  const value = String(password || '');
  if (value.length < MIN_PASSWORD_LENGTH) return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z\d]/].filter((pattern) => pattern.test(value)).length;
  if (classes < 3) return 'password must include at least three of lowercase, uppercase, number, and symbol';
  return null;
}

export class WebAuth {
  constructor({ env = process.env } = {}) {
    this.env = env;
    this.file = path.join(dataDir(env), 'web-auth.json');
    this.sessions = new Map();
    this.failures = new Map();
  }

  async read() {
    try { return JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async isConfigured() { return Boolean((await this.read())?.hash); }

  async setPassword(password) {
    return this.#writePassword(password, false);
  }

  async changePassword(password) {
    return this.#writePassword(password, true);
  }

  async #writePassword(password, overwrite) {
    const problem = passwordError(password);
    if (problem) throw new Error(problem);
    if (!overwrite && await this.isConfigured()) throw new Error('web password is already configured');
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(String(password), salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const payload = { version: 1, algorithm: 'scrypt', salt: salt.toString('base64url'), hash: hash.toString('base64url'), createdAt: new Date().toISOString() };
    if (overwrite) {
      const tmp = `${this.file}.${process.pid}.password.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(tmp, this.file);
    } else await fs.writeFile(this.file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await fs.chmod(this.file, 0o600).catch(() => {});
  }

  async verifyPassword(password) {
    const stored = await this.read();
    if (!stored?.hash || !stored?.salt) return false;
    const hash = await scrypt(String(password || ''), Buffer.from(stored.salt, 'base64url'), 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return timingSafeEqualText(hash.toString('base64url'), stored.hash);
  }

  async login(password, clientKey = 'unknown') {
    const now = Date.now();
    const failures = this.failures.get(clientKey) || [];
    const recent = failures.filter((at) => now - at < 5 * 60 * 1000);
    if (recent.length >= 8) throw new Error('too many login attempts; try again later');
    if (!await this.verifyPassword(password)) {
      recent.push(now); this.failures.set(clientKey, recent);
      throw new Error('invalid password');
    }
    this.failures.delete(clientKey);
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(token, now + SESSION_TTL_MS);
    return token;
  }

  authenticated(req) {
    const token = parseCookie(req.headers.cookie || '')[COOKIE];
    if (!token) return false;
    const expires = this.sessions.get(token);
    if (!expires || expires <= Date.now()) { this.sessions.delete(token); return false; }
    return true;
  }

  clear(req) {
    const token = parseCookie(req.headers.cookie || '')[COOKIE];
    if (token) this.sessions.delete(token);
  }

  cookie(token, secure = false) {
    return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`;
  }

  clearCookie() { return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`; }
}

function parseCookie(header) {
  return Object.fromEntries(String(header).split(';').map((part) => part.trim().split('=')) .filter(([key, value]) => key && value).map(([key, ...value]) => [key, value.join('=')]));
}

export { COOKIE as WEB_AUTH_COOKIE, MIN_PASSWORD_LENGTH };
