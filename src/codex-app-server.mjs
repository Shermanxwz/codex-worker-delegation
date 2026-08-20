import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

const DEFAULT_TIMEOUT_MS = 20_000;
const PLUGIN_NAME = 'codex-worker-delegation';

async function isExecutable(file) {
  try { await fs.access(file, fs.constants.X_OK); return true; } catch { return false; }
}

export async function resolveCodexBinary({ env = process.env, cwd = process.cwd() } = {}) {
  const candidates = [
    env.CODEX_BIN,
    path.resolve(cwd, 'node_modules/.bin/codex'),
    '/usr/local/bin/codex',
    '/usr/bin/codex',
    path.join(env.HOME || '', '.local/bin/codex'),
  ].filter(Boolean);
  for (const candidate of candidates) if (await isExecutable(candidate)) return candidate;
  return 'codex';
}

export class CodexAppServerClient {
  constructor({ env = process.env, cwd = process.cwd(), timeoutMs = DEFAULT_TIMEOUT_MS, codexBin } = {}) {
    this.env = env;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.codexBin = codexBin;
    this.seq = 0;
    this.pending = new Map();
    this.stderr = '';
  }

  async start() {
    if (this.process) return this;
    const bin = this.codexBin || await resolveCodexBinary({ env: this.env, cwd: this.cwd });
    this.process = spawn(bin, ['app-server'], {
      env: this.env,
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-32_000); });
    this.process.on('error', (error) => this.#failAll(error));
    this.process.on('close', (code, signal) => {
      if (!this.closing) this.#failAll(new Error(`codex app-server exited (${code ?? signal ?? 'unknown'})${this.stderr ? `: ${this.stderr.trim()}` : ''}`));
    });
    const lines = readline.createInterface({ input: this.process.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.#onLine(line));
    await this.request('initialize', {
      clientInfo: { name: 'codex_worker_delegation', title: 'Codex Worker Delegation', version: '1.1.0' },
      capabilities: {},
    });
    this.notify('initialized', {});
    return this;
  }

  request(method, params = {}) {
    if (!this.process?.stdin?.writable) return Promise.reject(new Error('codex app-server is not running'));
    const id = ++this.seq;
    const payload = { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server ${method} timed out after ${this.timeoutMs}ms${this.stderr ? `; stderr: ${this.stderr.trim()}` : ''}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.process.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  notify(method, params = {}) {
    if (!this.process?.stdin?.writable) return;
    this.process.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async listModels({ includeHidden = false } = {}) {
    const models = [];
    let cursor = null;
    do {
      const result = await this.request('model/list', { cursor, limit: 100, includeHidden });
      models.push(...(result?.data || []));
      cursor = result?.nextCursor || null;
    } while (cursor);
    return models;
  }

  async installLocalPlugin(repoRoot, pluginName = PLUGIN_NAME) {
    const added = await this.request('marketplace/add', { source: path.resolve(repoRoot) });
    const root = added?.installedRoot ? path.resolve(added.installedRoot) : path.resolve(repoRoot);
    const marketplacePath = path.join(root, '.agents', 'plugins', 'marketplace.json');
    const install = await this.request('plugin/install', { marketplacePath, pluginName });
    const installed = await this.request('plugin/installed', {
      cwds: [path.resolve(repoRoot)],
      installSuggestionPluginNames: [pluginName],
    });
    const entries = (installed?.marketplaces || []).flatMap((marketplace) =>
      (marketplace.plugins || []).map((plugin) => ({ marketplace, plugin }))
    );
    const match = entries.find(({ plugin }) => plugin?.name === pluginName || plugin?.id?.startsWith(`${pluginName}@`));
    if (!match?.plugin?.installed || match.plugin.enabled === false) {
      throw new Error(`Codex app-server did not report ${pluginName} as installed and enabled`);
    }
    return {
      marketplaceName: added?.marketplaceName || match.marketplace?.name || null,
      marketplacePath,
      authPolicy: install?.authPolicy || null,
      pluginId: match.plugin.id || `${pluginName}@${added?.marketplaceName || 'local'}`,
      installed: true,
      enabled: true,
    };
  }

  async close() {
    const processRef = this.process;
    if (!processRef) return;
    this.closing = true;
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
    if (processRef.exitCode !== null || processRef.signalCode !== null) return;
    processRef.stdin.end();
    processRef.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (processRef.exitCode === null && processRef.signalCode === null) processRef.kill('SIGKILL');
        resolve();
      }, 1500);
      processRef.once('close', () => { clearTimeout(timer); resolve(); });
    });
  }

  #onLine(line) {
    const text = line.trim();
    if (!text) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.id === undefined || msg.id === null) return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) pending.reject(new Error(`codex app-server ${pending.method}: ${msg.error.message || JSON.stringify(msg.error)}`));
    else pending.resolve(msg.result);
  }

  #failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export class CodexAppServerService {
  constructor(options = {}) { this.options = options; }
  async #withClient(fn) {
    const client = new CodexAppServerClient(this.options);
    try { await client.start(); return await fn(client); }
    finally { await client.close().catch(() => {}); }
  }
  listModels(options) { return this.#withClient((client) => client.listModels(options)); }
  installLocalPlugin(repoRoot, pluginName) { return this.#withClient((client) => client.installLocalPlugin(repoRoot, pluginName)); }
}
