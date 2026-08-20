import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeState, completeProfileForMode } from '../src/store.mjs';

test('schema v1 state migrates into independent per-mode profiles', () => {
  const s=normalizeState({schemaVersion:1,mode:'DELEGATE',models:{main:'old-main',worker:'old-worker',verifier:'old-ver'},mainSource:'official'});
  assert.equal(s.schemaVersion,2);
  for(const mode of ['AUTO','DELEGATE','MAIN']){
    assert.deepEqual(s.profiles[mode].main,{source:'official',model:'old-main'});
    assert.deepEqual(s.profiles[mode].worker,{source:'third_party',model:'old-worker'});
  }
  s.profiles.AUTO.main.model='changed';
  assert.equal(s.profiles.MAIN.main.model,'old-main');
});

test('MAIN completion fills only inactive empty role placeholders from Main', () => {
  const profile={main:{source:'official',model:'gpt-main'},worker:{source:'third_party',model:''},verifier:{source:'third_party',model:''}};
  const out=completeProfileForMode(profile,'MAIN');
  assert.deepEqual(out.worker,{source:'official',model:'gpt-main'});
  assert.deepEqual(out.verifier,{source:'official',model:'gpt-main'});
  assert.equal(profile.worker.model,'');
});
