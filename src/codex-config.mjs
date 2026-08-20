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

function managedBlock({ baseUrl, tokenFile }) {
  return `\n\n# --- codex-worker-delegation managed provider ---\n[model_providers.${PROVIDER}]\nname = "Codex Worker Delegation Gateway"\nbase_url = ${quote(baseUrl)}\nwire_api = "responses"\nrequires_openai_auth = false\n\n[model_providers.${PROVIDER}.auth]\ncommand = "cat"\nargs = [${quote(tokenFile)}]\n# --- end codex-worker-delegation managed provider ---\n`;
}

function workerRoleFile() {
  return `name = "cwd-worker"\ndescription = "Execution worker managed by Codex Worker Delegation. Use for implementation and body work when the selected route uses the same provider as the root thread."\ndeveloper_instructions = "You are an implementation worker. Own the assigned files and task. Do not undo unrelated edits. Execute, test, and report concrete results. The parent thread remains the coordinator."\n`;
}

function verifierRoleFile() {
  return `name = "cwd-verifier"\ndescription = "Independent verifier managed by Codex Worker Delegation. Use for review and validation after meaningful implementation work."\ndeveloper_instructions = "You are an independent verifier. Inspect and test the implementation, identify concrete regressions, and report evidence. Do not make implementation changes unless the parent explicitly reassigns you as a worker."\n`;
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

  async install() {
    await fs.mkdir(this.home, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.agentsDir, { recursive: true, mode: 0o700 });
    const before = await this.read();
    const originalTopLevel = inspectTopLevel(before);
    const next = removeManagedSections(before) + managedBlock({ baseUrl: this.gatewayBaseUrl, tokenFile: gatewayTokenPath(this.env) });
    await this.#backupAndWrite(before, next);
    await this.#writeRole(path.join(this.agentsDir, 'cwd-worker.toml'), workerRoleFile());
    await this.#writeRole(path.join(this.agentsDir, 'cwd-verifier.toml'), verifierRoleFile());
    await Promise.all([
      fs.rm(path.join(this.home, 'cwd-worker.config.toml'), { force: true }),
      fs.rm(path.join(this.home, 'cwd-verifier.config.toml'), { force: true })
    ]);
    return { originalTopLevel, providerId: PROVIDER, agents: ['cwd-worker', 'cwd-verifier'] };
  }

  async activateThirdPartyMain(model) {
    let text = await this.read();
    text = setTopLevel(text, 'model_provider', quote(PROVIDER));
    text = setTopLevel(text, 'model', quote(model));
    await this.#backupAndWrite(await this.read(), text);
  }

  async restoreOfficial(originalTopLevel = {}) {
    let text = await this.read();
    for (const key of ['model_provider', 'model']) {
      if (originalTopLevel?.[key]?.raw) text = setTopLevel(text, key, originalTopLevel[key].raw);
      else text = removeTopLevel(text, key);
    }
    await this.#backupAndWrite(await this.read(), text);
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
  }
}

export const CODEX_GATEWAY_PROVIDER_ID = PROVIDER;
