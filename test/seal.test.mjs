import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProductionSeal, REQUIRED_CORE_CHECKS } from '../src/seal.mjs';

const ok=(name)=>({name,ok:true});
const bad=(name)=>({name,ok:false,detail:'x'});
const desktopVisibility='official Codex model picker includes discovered New API-only models';
const desktopBinding='official Codex Desktop proves provider binding for discovered New API-only models';
const catalog='all discovered New API models are Codex-routeable';
const protocolCatalog='all discovered New API models pass their declared protocol connectivity check';
const core=()=>REQUIRED_CORE_CHECKS.map(ok);

test('core can seal while upstream Desktop picker/provider binding blockers remain explicit',()=>{const r=classifyProductionSeal({checks:[...core(),bad(desktopVisibility),bad(desktopBinding),ok(catalog)]});assert.equal(r.coreStatus,'CORE_SEALED');assert.equal(r.desktopNativeStatus,'DESKTOP_NATIVE_NOT_SEALED');assert.equal(r.upstreamDesktopBlockers.length,2);assert.equal(r.coreFailures.length,0)});
test('catalog-wide failures are advisory when every required core check passed',()=>{const r=classifyProductionSeal({checks:[...core(),bad(catalog),bad(protocolCatalog),bad(desktopVisibility),bad(desktopBinding)]});assert.equal(r.coreStatus,'CORE_SEALED');assert.equal(r.catalogStatus,'CATALOG_ADVISORY');assert.equal(r.catalogAdvisories.length,2)});
test('runtime, auth, worker, or integration failures block core seal',()=>{const checks=core().map((check)=>check.name==='ChatGPT auth.json is byte-for-byte unchanged'?bad(check.name):check);const r=classifyProductionSeal({checks:[...checks,bad(desktopVisibility),bad(desktopBinding)]});assert.equal(r.coreStatus,'CORE_NOT_SEALED');assert.ok(r.coreFailures.some((failure)=>failure.name==='ChatGPT auth.json is byte-for-byte unchanged'))});
test('missing production evidence can never produce a sealed result',()=>{const r=classifyProductionSeal({checks:[ok('official Codex runtime'),ok(desktopVisibility),ok(desktopBinding)]});assert.equal(r.coreStatus,'CORE_NOT_SEALED');assert.ok(r.coreFailures.some((failure)=>failure.detail.includes('evidence is missing')))});
test('model visibility alone never proves Desktop-native provider binding',()=>{const r=classifyProductionSeal({checks:[...core(),ok(desktopVisibility),ok(catalog)]});assert.equal(r.coreStatus,'CORE_SEALED');assert.equal(r.desktopNativeStatus,'DESKTOP_NATIVE_NOT_SEALED');assert.ok(r.upstreamDesktopBlockers.some((failure)=>failure.name===desktopBinding))});
test('full evidence including provider binding seals core and Desktop-native status',()=>{const r=classifyProductionSeal({checks:[...core(),ok(desktopVisibility),ok(desktopBinding),ok(catalog)]});assert.equal(r.coreStatus,'CORE_SEALED');assert.equal(r.desktopNativeStatus,'DESKTOP_NATIVE_SEALED');assert.equal(r.catalogStatus,'FULL_CATALOG_SEALED')});
