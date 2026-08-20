import fs from 'node:fs/promises'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
const roots=['src','test','scripts','plugins/codex-worker-delegation/hooks','plugins/codex-worker-delegation/mcp'];let failed=false;
for(const root of roots){for(const file of await walk(root)){if(file.endsWith('.mjs')||file.endsWith('.js')){const r=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});if(r.status!==0)failed=true}}}
for(const f of ['plugins/codex-worker-delegation/.codex-plugin/plugin.json','plugins/codex-worker-delegation/hooks/hooks.json','plugins/codex-worker-delegation/.mcp.json','.agents/plugins/marketplace.json'])JSON.parse(await fs.readFile(f,'utf8'));
if(failed)process.exit(1); console.log('syntax and manifest checks passed');
async function walk(dir){const out=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())out.push(...await walk(p));else out.push(p)}return out}
