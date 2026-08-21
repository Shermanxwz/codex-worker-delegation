import { createApp } from './server.mjs';
import { StateStore } from './store.mjs';
import { CodexConfigManager } from './codex-config.mjs';
import { statePath, codexHome, gatewayTokenPath } from './paths.mjs';
import { resolveCodexBinary } from './app-server.mjs';
import fs from 'node:fs/promises';

const cmd = process.argv[2] || 'doctor';
const env = process.env; const store = new StateStore({ env });
if (cmd === 'doctor') {
  const state = await store.read();
  const manager = new CodexConfigManager({ env });
  const report = { node: process.version, stateFile: statePath(env), codexHome: codexHome(env), configuredProvider: Boolean(state.provider), mode: state.mode, integrationInstalled: state.installed, gatewayTokenExists: await exists(gatewayTokenPath(env)), codexBinary: resolveCodexBinary(env), topLevelSelectors: await manager.selectors() };
  console.log(JSON.stringify(report, null, 2));
} else if (cmd === 'install') {
  await store.ensureGatewayToken();
  const manager = new CodexConfigManager({ env, gatewayBaseUrl: `http://127.0.0.1:${env.CWD_PORT || 8788}/v1` });
  const snap = await manager.install();
  await store.update((s)=>{s.installed=true;return s;});
  console.log(JSON.stringify({ok:true,providerId:snap.providerId,topLevelPreserved:snap.topLevelPreserved,message:'Codex integration installed without touching auth.json or the built-in openai selector.'},null,2));
} else if (cmd === 'official') {
  const manager = new CodexConfigManager({ env });
  console.log(JSON.stringify({ok:true,message:'No restore is necessary: v3 never switches the top-level provider. Official ChatGPT auth remains owned by Codex.',topLevelSelectors:await manager.selectors()},null,2));
} else if (cmd === 'serve') {
  const app=createApp({env}); app.server.listen(app.port,app.host);
} else throw new Error(`Unknown command: ${cmd}`);
async function exists(p){try{await fs.access(p);return true}catch{return false}}
