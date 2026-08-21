import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { codexHome, gatewayTokenPath, dataDir } from './paths.mjs';

const PROVIDER = 'codex_worker_gateway';
const MANAGED_SECTIONS = new Set([`model_providers.${PROVIDER}`, `model_providers.${PROVIDER}.auth`, 'agents.cwd-worker', 'agents.cwd-verifier']);
const OWNERSHIP_VERSION = 1;

function quote(value) { return JSON.stringify(String(value)); }
function sectionName(line) { const m = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/); return m?.[1]?.trim() || null; }
function inspectScalar(text,key){let section=null;for(const line of text.split(/\r?\n/)){const s=sectionName(line);if(s){section=s;continue}if(section)continue;const m=line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*(?:#.*)?$`));if(m)return{raw:m[1].trim(),line}}return null}
function setTopLevelRaw(text,key,raw){const lines=text.split(/\r?\n/);let section=null,replaced=false;const next=lines.map(line=>{const s=sectionName(line);if(s){section=s;return line}if(!section&&new RegExp(`^\\s*${key}\\s*=`).test(line)){replaced=true;return`${key} = ${raw}`}return line});if(!replaced)next.unshift(`${key} = ${raw}`);return next.join('\n')}
function setTopLevelScalar(text, key, value) { return setTopLevelRaw(text,key,quote(value)); }
function removeTopLevelScalar(text,key){let section=null;return text.split(/\r?\n/).filter(line=>{const s=sectionName(line);if(s){section=s;return true}return !(!section&&new RegExp(`^\\s*${key}\\s*=`).test(line))}).join('\n').replace(/\n{3,}/g,'\n\n').trimEnd()}

export function inspectTopLevel(text) {const found = {}; let section = null;for (const line of text.split(/\r?\n/)) {const s = sectionName(line); if (s) { section = s; continue; }if (section) continue;const m = line.match(/^\s*(model_provider|model)\s*=\s*(.+?)\s*(?:#.*)?$/);if (m) found[m[1]] = { raw: m[2].trim(), line };}return found;}
export function sameTopLevelSelectors(a = {}, b = {}) {return ['model_provider', 'model'].every((key) => (a?.[key]?.raw || null) === (b?.[key]?.raw || null));}

function removeManagedSections(text) {const out = []; let skipping = false; let skippingManagedBlock = false;for (const line of text.split(/\r?\n/)) {if (line.trim() === '# --- codex-worker-delegation managed provider ---') { skippingManagedBlock = true; continue; }if (skippingManagedBlock) { if (line.trim() === '# --- end codex-worker-delegation managed provider ---') skippingManagedBlock = false; continue; }const s = sectionName(line);if (s) skipping = MANAGED_SECTIONS.has(s);if (!skipping) out.push(line);}return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();}
function managedBlock({ baseUrl, tokenFile }) {return `\n\n# --- codex-worker-delegation managed provider ---\n[model_providers.${PROVIDER}]\nname = "Codex Worker Delegation Gateway"\nbase_url = ${quote(baseUrl)}\nwire_api = "responses"\n\n[model_providers.${PROVIDER}.auth]\ncommand = "cat"\nargs = [${quote(tokenFile)}]\n# --- end codex-worker-delegation managed provider ---\n`;}
function workerRoleFile() {return `name = "cwd-worker"\ndescription = "Implementation worker managed by Codex Worker Delegation. Native spawning is used only on the built-in OpenAI provider; third-party routes use isolated App Server threads to avoid custom-provider subagent transport bugs."\ndeveloper_instructions = "You are an implementation worker. Own the assigned files and task. Do not undo unrelated edits. Execute, test, and report concrete results. The parent thread remains the coordinator."\n`;}
function verifierRoleFile() {return `name = "cwd-verifier"\ndescription = "Independent verifier managed by Codex Worker Delegation. Native spawning is used only on the built-in OpenAI provider; third-party routes use isolated App Server threads."\ndeveloper_instructions = "You are an independent verifier. Inspect and test the implementation, identify concrete regressions, and report evidence. Do not make implementation changes unless the parent explicitly reassigns you as a worker."\n`;}

async function atomicFile(file,bytes,mode=0o600){await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});const tmp=`${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;let h;try{h=await fs.open(tmp,'wx',mode);await h.writeFile(bytes);await h.sync();await h.close();h=null;await fs.rename(tmp,file);await fs.chmod(file,mode).catch(()=>{})}finally{if(h)await h.close().catch(()=>{});await fs.unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e})}}
async function snapshotFile(file){try{const [bytes,stat]=await Promise.all([fs.readFile(file),fs.stat(file)]);return{existed:true,mode:stat.mode&0o777,base64:bytes.toString('base64')}}catch(e){if(e.code==='ENOENT')return{existed:false,mode:null,base64:null};throw e}}

export class CodexConfigManager {
  constructor({ env = process.env, gatewayBaseUrl = 'http://127.0.0.1:8788/v1' } = {}) {this.env = env;this.home = codexHome(env);this.file = path.join(this.home, 'config.toml');this.agentsDir = path.join(this.home, 'agents');this.gatewayBaseUrl = gatewayBaseUrl;this.ownershipFile=path.join(dataDir(env),'codex-config-ownership.json');}
  async read() { try { return await fs.readFile(this.file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } }
  async selectors() { return inspectTopLevel(await this.read()); }

  async setReasoningEffort(effort) {
    if (!effort || effort === 'auto') return { changed: false, effort: effort || 'auto' };
    const before = await this.read();const ownership=await this.#ensureOwnership(before);const next = setTopLevelScalar(before, 'model_reasoning_effort', effort);
    if (!sameTopLevelSelectors(inspectTopLevel(before), inspectTopLevel(next))) throw new Error('Refusing to set reasoning effort: official top-level model selector would change');
    await this.#backupAndWrite(before, next);ownership.reasoning.lastWritten=effort;await this.#writeOwnership(ownership);return { changed: before !== next, effort };
  }

  async install() {
    await fs.mkdir(this.home, { recursive: true, mode: 0o700 });await fs.mkdir(this.agentsDir, { recursive: true, mode: 0o700 });
    const before = await this.read();await this.#ensureOwnership(before);const selectorsBefore = inspectTopLevel(before);
    const next = removeManagedSections(before) + managedBlock({ baseUrl: this.gatewayBaseUrl, tokenFile: gatewayTokenPath(this.env) });const selectorsAfter = inspectTopLevel(next);
    if (!sameTopLevelSelectors(selectorsBefore, selectorsAfter)) throw new Error('Refusing to install: official top-level model selector would change');
    await this.#backupAndWrite(before, next);await this.#writeRole(path.join(this.agentsDir, 'cwd-worker.toml'), workerRoleFile());await this.#writeRole(path.join(this.agentsDir, 'cwd-verifier.toml'), verifierRoleFile());
    await Promise.all([fs.rm(path.join(this.home, 'cwd-worker.config.toml'), { force: true }),fs.rm(path.join(this.home, 'cwd-verifier.config.toml'), { force: true })]);
    return { selectorsBefore, selectorsAfter, topLevelPreserved: true, providerId: PROVIDER, agents: ['cwd-worker', 'cwd-verifier'] };
  }

  async uninstall() {
    const before = await this.read();const selectorsBefore = inspectTopLevel(before);let next = removeManagedSections(before);const ownership=await this.#readOwnership();
    if(ownership?.reasoning?.lastWritten){const current=inspectScalar(next,'model_reasoning_effort');if(current?.raw===quote(ownership.reasoning.lastWritten)){next=ownership.reasoning.original?.existed?setTopLevelRaw(next,'model_reasoning_effort',ownership.reasoning.original.raw):removeTopLevelScalar(next,'model_reasoning_effort')}}
    const selectorsAfter = inspectTopLevel(next);if (!sameTopLevelSelectors(selectorsBefore, selectorsAfter)) throw new Error('Refusing to uninstall: official top-level model selector would change');
    await this.#backupAndWrite(before, next);const roleResults=await this.#restoreRoles(ownership);
    await Promise.all([fs.rm(path.join(this.home, 'cwd-worker.config.toml'), { force: true }),fs.rm(path.join(this.home, 'cwd-verifier.config.toml'), { force: true })]);
    if(ownership)await fs.rm(this.ownershipFile,{force:true});await fs.rm(`${this.file}.cwd-backup`,{force:true}).catch(()=>{});
    return { selectorsBefore, selectorsAfter, topLevelPreserved: true, providerId: PROVIDER, removed: true, roleResults };
  }

  async #ensureOwnership(configText) {const existing=await this.#readOwnership();if(existing)return existing;const workerPath=path.join(this.agentsDir,'cwd-worker.toml'),verifierPath=path.join(this.agentsDir,'cwd-verifier.toml');const reasoning=inspectScalar(configText,'model_reasoning_effort');const ownership={schemaVersion:OWNERSHIP_VERSION,createdAt:new Date().toISOString(),roles:{'cwd-worker':await snapshotFile(workerPath),'cwd-verifier':await snapshotFile(verifierPath)},reasoning:{original:reasoning?{existed:true,raw:reasoning.raw}:{existed:false,raw:null},lastWritten:null}};await this.#writeOwnership(ownership);return ownership}
  async #readOwnership(){try{const parsed=JSON.parse(await fs.readFile(this.ownershipFile,'utf8'));if(parsed?.schemaVersion!==OWNERSHIP_VERSION||!parsed?.roles)throw new Error('unsupported ownership manifest');return parsed}catch(e){if(e.code==='ENOENT')return null;throw new Error(`Cannot read Codex ownership manifest: ${e.message}`,{cause:e})}}
  async #writeOwnership(value){await atomicFile(this.ownershipFile,`${JSON.stringify(value,null,2)}\n`,0o600)}
  async #restoreRoles(ownership){const results={};for(const [name,managedText] of [['cwd-worker',workerRoleFile()],['cwd-verifier',verifierRoleFile()]]){const file=path.join(this.agentsDir,`${name}.toml`);const original=ownership?.roles?.[name];if(original?.existed){await atomicFile(file,Buffer.from(original.base64,'base64'),Number(original.mode)||0o600);results[name]='restored-original';continue}let current=null;try{current=await fs.readFile(file,'utf8')}catch(e){if(e.code!=='ENOENT')throw e}if(current===null){results[name]='already-absent'}else if(current===managedText){await fs.rm(file,{force:true});results[name]='removed-managed'}else{results[name]='preserved-user-modification'}}return results}
  async #writeRole(file, text) { await atomicFile(file,text,0o600); }
  async #backupAndWrite(before, next) {if (before === next) return;await fs.mkdir(this.home, { recursive: true, mode: 0o700 });if (before) await atomicFile(`${this.file}.cwd-backup`,before,0o600);const normalized=next ? (next.endsWith('\n') ? next : `${next}\n`) : '';await atomicFile(this.file,normalized,0o600);}
}

export const CODEX_GATEWAY_PROVIDER_ID = PROVIDER;
