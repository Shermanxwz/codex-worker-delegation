import fs from 'node:fs/promises';
import path from 'node:path';
import { codexHome, gatewayTokenPath } from './paths.mjs';

const PROVIDER = 'codex_worker_gateway';
const MANAGED_SECTIONS = new Set([
  `model_providers.${PROVIDER}`,
  `model_providers.${PROVIDER}.auth`,
  'agents.cwd-worker',
  'agents.cwd-verifier'
]);

function quote(value) { return JSON.stringify(String(value)); }
function sectionName(line) { const m = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/); return m?.[1]?.trim() || null; }
function setTopLevelScalar(text, key, value) {
  const lines = text.split(/\r?\n/); let section = null; let replaced = false;
  const next = lines.map((line) => {
    const currentSection = sectionName(line); if (currentSection) { section = currentSection; return line; }
    if (!section && new RegExp(`^\\s*${key}\\s*=`).test(line)) { replaced = true; return `${key} = ${quote(value)}`; }
    return line;
  });
  if (!replaced) next.unshift(`${key} = ${quote(value)}`);
  return next.join('\n');
}

export function inspectTopLevel(text) {
  const found = {}; let section = null;
  for (const line of text.split(/\r?\n/)) {
    const s = sectionName(line); if (s) { section = s; continue; }
    if (section) continue;
    const m = line.match(/^\s*(model_provider|model)\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (m) found[m[1]] = { raw: m[2].trim(), line };
  }
  return found;
}

export function sameTopLevelSelectors(a = {}, b = {}) {
  return ['model_provider', 'model'].every((key) => (a?.[key]?.raw || null) === (b?.[key]?.raw || null));
}

function removeManagedSections(text) {
  const out = []; let skipping = false; let skippingManagedBlock = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '# --- codex-worker-delegation managed provider ---') { skippingManagedBlock = true; continue; }
    if (skippingManagedBlock) { if (line.trim() === '# --- end codex-worker-delegation managed provider ---') skippingManagedBlock = false; continue; }
    const s = sectionName(line);
    if (s) skipping = MANAGED_SECTIONS.has(s);
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function managedBlock({ baseUrl, tokenFile }) {
  return `\n\n# --- codex-worker-delegation managed provider ---\n[model_providers.${PROVIDER}]\nname = "Codex Worker Delegation Gateway"\nbase_url = ${quote(baseUrl)}\nwire_api = "responses"\n\n[model_providers.${PROVIDER}.auth]\ncommand = "cat"\nargs = [${quote(tokenFile)}]\n# --- end codex-worker-delegation managed provider ---\n`;
}

function workerRoleFile() {
  return `name = "cwd-worker"\ndescription = "Implementation worker managed by Codex Worker Delegation. Native spawning is used only on the built-in OpenAI provider; third-party routes use isolated App Server threads to avoid custom-provider subagent transport bugs."\ndeveloper_instructions = "You are an implementation worker. Own the assigned files and task. Do not undo unrelated edits. Execute, test, and report concrete results. The parent thread remains the coordinator."\n`;
}

function verifierRoleFile() {
  return `name = "cwd-verifier"\ndescription = "Independent verifier managed by Codex Worker Delegation. Native spawning is used only on the built-in OpenAI provider; third-party routes use isolated App Server threads."\ndeveloper_instructions = "You are an independent verifier. Inspect and test the implementation, identify concrete regressions, and report evidence. Do not make implementation changes unless the parent explicitly reassigns you as a worker."\n`;
}

export class CodexConfigManager {
  constructor({ env = process.env, gatewayBaseUrl = 'http://127.0.0.1:8788/v1' } = {}) {
    this.env = env;
    this.home = codexHome(env);
    this.file = path.join(this.home, 'config.toml');
    this.agentsDir = path.join(this.home, 'agents');
    this.gatewayBaseUrl = gatewayBaseUrl;
  }

  async read() { try { return await fs.readFile(this.file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } }

  async selectors() { return inspectTopLevel(await this.read()); }

  async setReasoningEffort(effort) {
    if (!effort || effort === 'auto') return { changed: false, effort: effort || 'auto' };
    const before = await this.read();
    const next = setTopLevelScalar(before, 'model_reasoning_effort', effort);
    if (!sameTopLevelSelectors(inspectTopLevel(before), inspectTopLevel(next))) throw new Error('Refusing to set reasoning effort: official top-level model selector would change');
    await this.#backupAndWrite(before, next);
    return { changed: before !== next, effort };
  }

  async install() {
    await fs.mkdir(this.home, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.agentsDir, { recursive: true, mode: 0o700 });
    const before = await this.read();
    const selectorsBefore = inspectTopLevel(before);
    const next = removeManagedSections(before) + managedBlock({ baseUrl: this.gatewayBaseUrl, tokenFile: gatewayTokenPath(this.env) });
    const selectorsAfter = inspectTopLevel(next);
    if (!sameTopLevelSelectors(selectorsBefore, selectorsAfter)) throw new Error('Refusing to install: official top-level model selector would change');
    await this.#backupAndWrite(before, next);
    await this.#writeRole(path.join(this.agentsDir, 'cwd-worker.toml'), workerRoleFile());
    await this.#writeRole(path.join(this.agentsDir, 'cwd-verifier.toml'), verifierRoleFile());
    await Promise.all([
      fs.rm(path.join(this.home, 'cwd-worker.config.toml'), { force: true }),
      fs.rm(path.join(this.home, 'cwd-verifier.config.toml'), { force: true })
    ]);
    return { selectorsBefore, selectorsAfter, topLevelPreserved: true, providerId: PROVIDER, agents: ['cwd-worker', 'cwd-verifier'] };
  }

  async #writeRole(file, text) {
    const tmp = `${file}.cwd.tmp`;
    await fs.writeFile(tmp, text, { mode: 0o600 });
    await fs.rename(tmp, file);
    await fs.chmod(file, 0o600).catch(() => {});
  }

  async #backupAndWrite(before, next) {
    if (before === next) return;
    await fs.mkdir(this.home, { recursive: true, mode: 0o700 });
    if (before) await fs.writeFile(`${this.file}.cwd-backup`, before, { mode: 0o600 });
    const tmp = `${this.file}.cwd.tmp`;
    await fs.writeFile(tmp, next.endsWith('\n') ? next : `${next}\n`, { mode: 0o600 });
    await fs.rename(tmp, this.file);
    await fs.chmod(this.file, 0o600).catch(() => {});
  }
}

export const CODEX_GATEWAY_PROVIDER_ID = PROVIDER;
