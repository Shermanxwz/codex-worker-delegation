import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModelCapabilityRegistry, reasoningScale, reconcileRoleRoute, validateRoleRoute } from '../src/model-capabilities.mjs';

function registry({ oauth=true }={}) {
  return buildModelCapabilityRegistry({
    accountRead: oauth ? { account:{ type:'chatgpt', email:'owner@example.com', planType:'plus' }, requiresOpenaiAuth:true } : { account:null, requiresOpenaiAuth:false },
    officialModels:[
      { id:'gpt-a', model:'gpt-a', displayName:'GPT A', isDefault:true, supportedReasoningEfforts:[{reasoningEffort:'low',description:'fast'},{reasoningEffort:'deep-vendor',description:'deep'}], defaultReasoningEffort:'low' },
      { id:'gpt-no-effort', model:'gpt-no-effort', displayName:'No Effort' }
    ],
    thirdPartyModels:[
      { id:'third-a', name:'Third A', supportedReasoningEfforts:['eco',{effort:'extreme-plus',description:'vendor exact'}], defaultReasoningEffort:'eco' },
      { id:'third-unknown', name:'Third Unknown' }
    ],
    thirdPartyConfigured:true
  });
}

test('ChatGPT OAuth locks Main to official without hiding third-party Worker capability',()=>{const r=registry();assert.equal(r.authentication.officialOAuth,true);assert.equal(r.mainPolicy.providerLocked,true);assert.equal(r.mainPolicy.lockedProvider,'official');assert.equal(r.providers.third_party.models.length,2);assert.throws(()=>validateRoleRoute({provider:'third_party',model:'third-a',effort:'auto'},{role:'main',registry:r}),/locked to Official ChatGPT/);assert.equal(validateRoleRoute({provider:'third_party',model:'third-a',effort:'eco'},{role:'worker',registry:r}).effort,'eco')});

test('without ChatGPT OAuth a third-party standalone Main route is valid',()=>{const r=registry({oauth:false});assert.equal(r.mainPolicy.providerLocked,false);const route=validateRoleRoute({provider:'third_party',model:'third-a',effort:'extreme-plus'},{role:'main',registry:r});assert.equal(route.provider,'third_party');assert.equal(route.effort,'extreme-plus')});

test('reasoning scale preserves exact upstream order and never adds guessed levels',()=>{const r=registry();assert.deepEqual(reasoningScale(r,'third_party','third-a').values.map((x)=>x.value),['auto','eco','extreme-plus']);assert.deepEqual(reasoningScale(r,'third_party','third-unknown').values.map((x)=>x.value),['auto']);assert.deepEqual(reasoningScale(r,'official','gpt-a').values.map((x)=>x.value),['auto','low','deep-vendor'])});

test('unadvertised explicit reasoning is rejected and model change reconciles to Auto',()=>{const r=registry();assert.throws(()=>validateRoleRoute({provider:'third_party',model:'third-unknown',effort:'high'},{role:'worker',registry:r}),/not advertised/);const reconciled=reconcileRoleRoute({provider:'third_party',model:'third-unknown',effort:'extreme-plus'},{role:'worker',registry:r});assert.equal(reconciled.effort,'auto')});

test('OAuth reconciliation moves stale third-party Main to the official default model and Auto',()=>{const r=registry();const next=reconcileRoleRoute({provider:'third_party',model:'third-a',effort:'eco'},{role:'main',registry:r});assert.equal(next.provider,'official');assert.equal(next.model,'gpt-a');assert.equal(next.effort,'auto');assert.equal(next.changed,true)});
