import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { treeDigest } from './tree-digest.mjs';

const MANIFEST_RELATIVE = '.codex-plugin/plugin.json';

function baseVersion(version) { const value=String(version||'').trim(); if(!value)throw new Error('plugin manifest version is required'); return value.split('+')[0]; }
async function normalizedPayloadDigest(pluginRoot) {
  const manifestPath=path.join(pluginRoot,MANIFEST_RELATIVE);
  const original=JSON.parse(await fs.readFile(manifestPath,'utf8'));
  const base=baseVersion(original.version);
  return treeDigest(pluginRoot,{transform:(relative,bytes)=>{
    if(relative!==MANIFEST_RELATIVE)return bytes;
    const manifest=JSON.parse(bytes.toString('utf8'));manifest.version=base;return Buffer.from(`${JSON.stringify(manifest,null,2)}\n`);
  }});
}

export async function applyPluginCachebuster(pluginRoot) {
  const root=path.resolve(pluginRoot); const manifestPath=path.join(root,MANIFEST_RELATIVE); const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
  const base=baseVersion(manifest.version); const normalized=await normalizedPayloadDigest(root); const cachebuster=normalized.sha256.slice(0,20); const version=`${base}+codex.${cachebuster}`;
  if(manifest.version!==version){manifest.version=version;const tmp=`${manifestPath}.${process.pid}.tmp`;await fs.writeFile(tmp,`${JSON.stringify(manifest,null,2)}\n`,{mode:0o644});await fs.rename(tmp,manifestPath);await fs.chmod(manifestPath,0o644).catch(()=>{});}
  const exact=await treeDigest(root);
  return {version,cachebuster,normalizedSha256:normalized.sha256,treeSha256:exact.sha256,files:exact.files,manifestPath};
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
  const root=process.argv[2];if(!root){console.error('usage: node scripts/plugin-cachebuster.mjs <plugin-root> [--json]');process.exit(2)}
  const result=await applyPluginCachebuster(root);if(process.argv.includes('--json'))console.log(JSON.stringify(result));else console.log(result.version);
}
