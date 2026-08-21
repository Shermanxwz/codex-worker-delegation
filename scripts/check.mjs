import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const roots=['src','test','scripts','public','plugins/codex-worker-delegation/hooks','plugins/codex-worker-delegation/mcp'];
let failed=false;
for(const root of roots){
  for(const file of await walk(root)){
    if(file.endsWith('.mjs')||file.endsWith('.js')){
      const r=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});
      if(r.status!==0)failed=true;
    }
    if(file.endsWith('.sh')){
      const r=spawnSync('bash',['-n',file],{stdio:'inherit'});
      if(r.status!==0)failed=true;
    }
  }
}

const manifestFiles=['plugins/codex-worker-delegation/.codex-plugin/plugin.json','plugins/codex-worker-delegation/hooks/hooks.json','plugins/codex-worker-delegation/.mcp.json','.agents/plugins/marketplace.json'];
const manifests={};
for(const file of manifestFiles) manifests[file]=JSON.parse(await fs.readFile(file,'utf8'));

const pluginPath='plugins/codex-worker-delegation/.codex-plugin/plugin.json';
const plugin=manifests[pluginPath];
if(plugin?.hooks!=='./hooks/hooks.json') throw new Error(`${pluginPath}: hooks must be explicitly declared`);
const prompts=plugin?.interface?.defaultPrompt;
if(prompts!==undefined){
  if(!Array.isArray(prompts)) throw new Error(`${pluginPath}: interface.defaultPrompt must be an array`);
  if(prompts.length>3) throw new Error(`${pluginPath}: interface.defaultPrompt supports at most 3 prompts`);
  for(const [i,prompt] of prompts.entries()){
    if(typeof prompt!=='string') throw new Error(`${pluginPath}: interface.defaultPrompt[${i}] must be a string`);
    if([...prompt].length>128) throw new Error(`${pluginPath}: interface.defaultPrompt[${i}] exceeds Codex 128-character limit`);
  }
}

const mcpPath='plugins/codex-worker-delegation/.mcp.json';
const mcp=manifests[mcpPath];
for(const name of Object.keys(mcp?.mcpServers||{})){
  if(!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`${mcpPath}: MCP server key ${JSON.stringify(name)} must use letters, digits, or underscores so Codex exposes its tools reliably`);
}
const mcpRunner='plugins/codex-worker-delegation/mcp/run.sh';
if(mcp?.mcpServers?.codex_worker_delegation?.command!=='./mcp/run.sh' || JSON.stringify(mcp?.mcpServers?.codex_worker_delegation?.args||[])!==JSON.stringify([]) || mcp?.mcpServers?.codex_worker_delegation?.cwd!=='.') throw new Error(`${mcpPath}: codex_worker_delegation must use the plugin-local PATH-independent MCP runner`);
if(!(await fs.stat(mcpRunner)).isFile()) throw new Error(`${mcpRunner}: MCP runner is missing`);
const hooksRunner='plugins/codex-worker-delegation/hooks/run-policy.sh';
const hookCommand=manifests['plugins/codex-worker-delegation/hooks/hooks.json']?.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command;
if(hookCommand!=='bash \"${PLUGIN_ROOT}/hooks/run-policy.sh\"') throw new Error(`plugins/codex-worker-delegation/hooks/hooks.json: policy hook must use the PATH-independent runner`);
if(!(await fs.stat(hooksRunner)).isFile()) throw new Error(`${hooksRunner}: policy hook runner is missing`);

const baselinePath='deploy/chatgpt-linux-baseline.json';
const baseline=JSON.parse(await fs.readFile(baselinePath,'utf8'));
if(baseline?.schemaVersion!==1) throw new Error(`${baselinePath}: schemaVersion must be 1`);
if(baseline?.package?.name!=='chatgpt') throw new Error(`${baselinePath}: package.name must be chatgpt`);
if(!/^\d+\.\d+\.\d+$/.test(String(baseline?.package?.version||''))) throw new Error(`${baselinePath}: invalid package version`);
if(!/^[a-f0-9]{64}$/.test(String(baseline?.package?.sha256||''))) throw new Error(`${baselinePath}: package SHA-256 must be lowercase hex`);
if(!/^https:\/\/persistent\.oaistatic\.com\/codex-app-prod\/linux\/deb\/pool\//.test(String(baseline?.package?.versionedUrl||''))) throw new Error(`${baselinePath}: baseline must use an immutable versioned oaistatic pool URL`);
if(baseline?.bundledCodex?.path!=='/usr/lib/chatgpt/resources/codex') throw new Error(`${baselinePath}: bundled Codex path does not match the Linux package contract`);
if(!/^codex-cli\s+\S+/.test(String(baseline?.bundledCodex?.version||''))) throw new Error(`${baselinePath}: bundled Codex version is missing`);
for(const key of ['appServerSchemaGenerated','officialPluginManagerInstall','explicitModelProviderCrossProviderE2E','officialSelectorPreserved']){
  if(baseline?.acceptance?.[key]!==true) throw new Error(`${baselinePath}: acceptance.${key} must be true before recording a seal baseline`);
}

const unitPath='deploy/codex-worker-delegation.service';
const unit=await fs.readFile(unitPath,'utf8');
for(const required of ['NoNewPrivileges=true','ProtectSystem=full','CapabilityBoundingSet=','AmbientCapabilities=','Environment=CWD_NODE_BIN=%h/.local/share/codex-worker-delegation/runtime/node']){
  if(!unit.includes(required)) throw new Error(`${unitPath}: missing hardening/runtime contract ${required}`);
}
for(const forbidden of ['User=root','/root/Documents','codex-primary-runtime','ProtectSystem=strict']){
  if(unit.includes(forbidden)) throw new Error(`${unitPath}: forbidden machine-specific or workspace-breaking setting ${forbidden}`);
}

for(const lifecycleScript of ['scripts/install-linux.sh','scripts/install-service-unit.sh','scripts/rollback-linux.sh','scripts/uninstall-linux.sh','scripts/validate-deployment.sh']){
  const stat=await fs.stat(lifecycleScript);
  if(!stat.isFile()) throw new Error(`${lifecycleScript}: lifecycle script is missing`);
}

if(failed)process.exit(1);
console.log('syntax, shell, Web JS, manifest, Codex prompt-length, MCP, Linux deployment, and immutable baseline checks passed');

async function walk(dir){const out=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())out.push(...await walk(p));else out.push(p)}return out}
