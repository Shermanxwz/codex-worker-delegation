import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProductionSeal } from '../src/seal.mjs';

const ok=(name)=>({name,ok:true});
const bad=(name)=>({name,ok:false,detail:'x'});

test('core can seal while an upstream Desktop picker blocker remains explicit',()=>{const r=classifyProductionSeal({checks:[ok('official Codex runtime'),ok('real third-party Worker delegation'),bad('official Codex model picker includes discovered New API-only models')]});assert.equal(r.coreStatus,'CORE_SEALED');assert.equal(r.desktopNativeStatus,'DESKTOP_NATIVE_NOT_SEALED');assert.equal(r.upstreamDesktopBlockers.length,1);assert.equal(r.coreFailures.length,0)});
test('catalog-wide failures are advisory when a selected real route has passed',()=>{const r=classifyProductionSeal({checks:[ok('real third-party Worker delegation'),bad('all discovered New API models are Codex-routeable')]});assert.equal(r.coreStatus,'CORE_SEALED');assert.equal(r.catalogStatus,'CATALOG_ADVISORY');assert.equal(r.catalogAdvisories.length,1)});
test('runtime, auth, worker, or integration failures block core seal',()=>{const r=classifyProductionSeal({checks:[ok('official Codex runtime'),bad('ChatGPT auth.json is byte-for-byte unchanged')]});assert.equal(r.coreStatus,'CORE_NOT_SEALED');assert.equal(r.coreFailures.length,1)});
test('full pass seals both core and Desktop-native status',()=>{const r=classifyProductionSeal({checks:[ok('official Codex runtime'),ok('official Codex model picker includes discovered New API-only models'),ok('all discovered New API models are Codex-routeable')]});assert.equal(r.coreStatus,'CORE_SEALED');assert.equal(r.desktopNativeStatus,'DESKTOP_NATIVE_SEALED');assert.equal(r.catalogStatus,'FULL_CATALOG_SEALED')});
