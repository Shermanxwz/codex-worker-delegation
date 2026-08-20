import { createApp } from './server.mjs';
import { StateStore } from './store.mjs';
import { CodexConfigManager } from './codex-config.mjs';
import { statePath, codexHome, gatewayTokenPath } from './paths.mjs';
import fs from 'node:fs/promises';

const cmd = process.argv[2] || 'doctor';
const env = process.env; const store = new StateStore({ env });
if (cmd === 'doctor') {
  const state = await store.read();
  const report = { node: process.version, stateFile: statePath(env), codexHome: codexHome(env), configuredProvider: Boolean(state.provider), mode: state.mode, integrationInstalled: state.installed, gatewayTokenExists: await exists(gatewayTokenPath(env)), codexBinary: await commandExists('codex') };
  console.log(JSON.stringify(report, null, 2));
} else if (cmd === 'install') {
  const state = await store.read(); const model = state.models.worker || state.models.main; if (!model) throw new Error('Configure a worker model in the Web UI first.');
  await store.ensureGatewayToken(); const manager = new CodexConfigManager({ env, gatewayBaseUrl: `http://127.0.0.1:${env.CWD_PORT || 8788}/v1` }); const snap = await manager.install({ workerModel:model, verifierModel:state.models.verifier || model });
  await store.update((s)=>{ if(!s.originalTopLevel) s.originalTopLevel=snap.originalTopLevel; s.installed=true; return s; }); console.log('Codex integration installed without touching auth.json or the built-in openai provider.');
} else if (cmd === 'official') {
  const state = await store.read(); await new CodexConfigManager({ env }).restoreOfficial(state.originalTopLevel || {}); await store.update((s)=>{s.mainSource='official';return s;}); console.log('Restored the original official main-provider selection.');
} else if (cmd === 'serve') {
  const app=createApp({env}); app.server.listen(app.port,app.host);
} else throw new Error(`Unknown command: ${cmd}`);

async function exists(p){try{await fs.access(p);return true}catch{return false}}
async function commandExists(name){const {spawnSync}=await import('node:child_process');return spawnSync('sh',['-lc',`command -v ${name}`]).status===0}
