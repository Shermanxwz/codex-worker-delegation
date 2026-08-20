import fs from 'node:fs/promises';
import path from 'node:path';
import { codexHome, gatewayTokenPath } from './paths.mjs';

const PROVIDER = 'codex_worker_gateway';
const OFFICIAL_PROVIDER = 'openai';
const MANAGED_SECTIONS = new Set([
  `model_providers.${PROVIDER}`, `model_providers.${PROVIDER}.auth`, 'agents.cwd-worker', 'agents.cwd-verifier'
]);

function quote(value) { return JSON.stringify(String(value)); }
function sectionName(line) { const m = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/); return m?.[1]?.trim() || null; }

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

function removeManagedSections(text) {
  const out = []; let skipping = false;
  for (const line of text.split(/\r?\n/)) {
    const s = sectionName(line);
    if (s) skipping = MANAGED_SECTIONS.has(s);
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function setTopLevel(text, key, rawValue) {
  const lines = text.split(/\r?\n/); let sectionSeen = false; let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    if (sectionName(lines[i])) sectionSeen = true;
    if (!sectionSeen && new RegExp(`^\\s*${key}\\s*=`).test(lines[i])) { lines[i] = `${key} = ${rawValue}`; replaced = true; break; }
  }
  if (!replaced) {
    const firstSection = lines.findIndex((l) => sectionName(l));
    const at = firstSection < 0 ? lines.length : firstSection;
    lines.splice(at, 0, `${key} = ${rawValue}`, '');
  }
  return lines.join('\n');
}

function removeTopLevel(text, key) {
  const lines = text.split(/\r?\n/); let sectionSeen = false;
  return lines.filter((line) => {
    if (sectionName(line)) sectionSeen = true;
    return sectionSeen || !new RegExp(`^\\s*${key}\\s*=`).test(line);
  }).join('\n').replace(/\n{3,}/g, '\n\n');
}

function managedBlock({ baseUrl, tokenFile, workerFile, verifierFile }) {
  return `\n\n# --- codex-worker-delegation managed integration ---\n[model_providers.${PROVIDER}]\nname = "Codex Worker Delegation Gateway"\nbase_url = ${quote(baseUrl)}\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\nstream_idle_timeout_ms = 30000\n\n[model_providers.${PROVIDER}.auth]\ncommand = "cat"\nargs = [${quote(tokenFile)}]\n\n[agents.cwd-worker]\ndescription = "Native Codex body-work subagent with an explicit Web-selected model/provider."\nconfig_file = ${quote(workerFile)}\n\n[agents.cwd-verifier]\ndescription = "Independent verification subagent with an explicit Web-selected model/provider."\nconfig_file = ${quote(verifierFile)}\n# --- end codex-worker-delegation managed integration ---\n`;
}

function providerFor(selection) { return selection?.source === 'third_party' ? PROVIDER : OFFICIAL_PROVIDER; }
function validateSelection(selection, role) {
  if (!selection?.model?.trim()) throw new Error(`${role} model is required`);
  if (!['official', 'third_party'].includes(selection.source)) throw new Error(`${role} source must be official or third_party`);
}
function roleFile(selection) { return `model = ${quote(selection.model)}\nmodel_provider = ${quote(providerFor(selection))}\n`; }

export class CodexConfigManager {
  constructor({ env = process.env, gatewayBaseUrl = 'http://127.0.0.1:8788/v1' } = {}) {
    this.env = env; this.home = codexHome(env); this.file = path.join(this.home, 'config.toml'); this.gatewayBaseUrl = gatewayBaseUrl;
  }
  async read() { try { return await fs.readFile(this.file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } }

  async install({ profile }) {
    validateSelection(profile?.main, 'main'); validateSelection(profile?.worker, 'worker'); validateSelection(profile?.verifier, 'verifier');
    await fs.mkdir(this.home, { recursive: true, mode: 0o700 });
    const before = await this.read();
    const originalTopLevel = inspectTopLevel(before);
    await this.#writeRoleFiles(profile);
    const next = this.#compose(before, profile);
    await this.#backupAndWrite(before, next);
    return { originalTopLevel };
  }

  async applyProfile(profile) {
    validateSelection(profile?.main, 'main'); validateSelection(profile?.worker, 'worker'); validateSelection(profile?.verifier, 'verifier');
    const before = await this.read();
    await this.#writeRoleFiles(profile);
    await this.#backupAndWrite(before, this.#compose(before, profile));
  }

  async restoreOfficial(originalTopLevel = {}) {
    let text = await this.read();
    for (const key of ['model_provider', 'model']) {
      if (originalTopLevel?.[key]?.raw) text = setTopLevel(text, key, originalTopLevel[key].raw);
      else text = removeTopLevel(text, key);
    }
    await this.#backupAndWrite(await this.read(), text);
  }

  #compose(before, profile) {
    const workerFile = path.join(this.home, 'cwd-worker.config.toml');
    const verifierFile = path.join(this.home, 'cwd-verifier.config.toml');
    let next = removeManagedSections(before) + managedBlock({ baseUrl: this.gatewayBaseUrl, tokenFile: gatewayTokenPath(this.env), workerFile, verifierFile });
    next = setTopLevel(next, 'model_provider', quote(providerFor(profile.main)));
    next = setTopLevel(next, 'model', quote(profile.main.model));
    return next;
  }

  async #writeRoleFiles(profile) {
    const workerFile = path.join(this.home, 'cwd-worker.config.toml');
    const verifierFile = path.join(this.home, 'cwd-verifier.config.toml');
    await fs.writeFile(workerFile, roleFile(profile.worker), { mode: 0o600 });
    await fs.writeFile(verifierFile, roleFile(profile.verifier), { mode: 0o600 });
  }

  async #backupAndWrite(before, next) {
    if (before === next) return;
    await fs.mkdir(this.home, { recursive: true, mode: 0o700 });
    if (before) await fs.writeFile(`${this.file}.cwd-backup`, before, { mode: 0o600 });
    const tmp = `${this.file}.cwd.tmp`;
    await fs.writeFile(tmp, next.endsWith('\n') ? next : `${next}\n`, { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }
}

export const CODEX_GATEWAY_PROVIDER_ID = PROVIDER;
export const CODEX_OFFICIAL_PROVIDER_ID = OFFICIAL_PROVIDER;
