import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyPluginCachebuster } from '../scripts/plugin-cachebuster.mjs';
import { treeDigest } from '../scripts/tree-digest.mjs';

async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cwd-plugin-digest-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const root=path.join(dir,'plugin');await fs.mkdir(path.join(root,'.codex-plugin'),{recursive:true});await fs.mkdir(path.join(root,'hooks'));await fs.writeFile(path.join(root,'.codex-plugin','plugin.json'),JSON.stringify({name:'codex-worker-delegation',version:'3.0.0'},null,2)+'\n');await fs.writeFile(path.join(root,'hooks','run.sh'),'#!/bin/sh\necho ok\n',{mode:0o755});return{dir,root}}

test('plugin cachebuster is deterministic for identical payload and changes when payload changes',async(t)=>{const {root}=await fixture(t);const first=await applyPluginCachebuster(root);assert.match(first.version,/^3\.0\.0\+codex\.[a-f0-9]{20}$/);const second=await applyPluginCachebuster(root);assert.equal(second.version,first.version);assert.equal(second.normalizedSha256,first.normalizedSha256);await fs.appendFile(path.join(root,'hooks','run.sh'),'echo changed\n');const third=await applyPluginCachebuster(root);assert.notEqual(third.version,first.version);assert.notEqual(third.treeSha256,first.treeSha256)});

test('tree digest proves an installed plugin cache is byte/path/executable equivalent',async(t)=>{const {dir,root}=await fixture(t);await applyPluginCachebuster(root);const cache=path.join(dir,'cache');await fs.cp(root,cache,{recursive:true,preserveTimestamps:false});assert.equal((await treeDigest(cache)).sha256,(await treeDigest(root)).sha256);await fs.appendFile(path.join(cache,'hooks','run.sh'),'tamper\n');assert.notEqual((await treeDigest(cache)).sha256,(await treeDigest(root)).sha256)});
