import test from 'node:test';
import assert from 'node:assert/strict';
import { responsesToChat, ChatSseToResponses, chatJsonToResponses } from '../src/translate.mjs';

test('Responses input and tools translate to Chat Completions', () => {
  const out = responsesToChat({
    model:'third-model', instructions:'be precise', stream:true,
    input:[
      {type:'message', role:'user', content:[{type:'input_text', text:'hello'}]},
      {type:'function_call', call_id:'call_1', name:'read', arguments:'{"p":"x"}'},
      {type:'function_call_output', call_id:'call_1', output:'ok'}
    ],
    tools:[{type:'function',name:'read',description:'read',parameters:{type:'object'}}]
  });
  assert.equal(out.messages[0].role,'system');
  assert.equal(out.messages[1].content,'hello');
  assert.equal(out.messages[2].tool_calls[0].id,'call_1');
  assert.equal(out.messages[3].role,'tool');
  assert.equal(out.tools[0].function.name,'read');
  assert.deepEqual(out.stream_options,{include_usage:true});
});

test('chat stream becomes Codex-consumable Responses SSE including function_call item', () => {
  const c = new ChatSseToResponses({model:'m'});
  let s = c.start();
  s += c.feedData(JSON.stringify({choices:[{delta:{content:'Hi '}}]}));
  s += c.feedData(JSON.stringify({choices:[{delta:{content:'there',tool_calls:[{index:0,id:'call_x',function:{name:'shell',arguments:'{"cmd":'}}]}}]}));
  s += c.feedData(JSON.stringify({choices:[{delta:{tool_calls:[{index:0,function:{arguments:'"pwd"}'}}]}}],usage:{prompt_tokens:3,completion_tokens:4,total_tokens:7}}));
  s += c.feedData('[DONE]');
  assert.match(s,/response\.created/);
  assert.match(s,/response\.output_text\.delta/);
  assert.match(s,/"type":"function_call"/);
  assert.match(s,/"call_id":"call_x"/);
  assert.match(s,/\\"cmd\\":\\"pwd\\"/);
  assert.match(s,/response\.completed/);
  assert.match(s,/"total_tokens":7/);
});

test('non-stream chat response maps text and tool calls', async () => {
  const r = await chatJsonToResponses({choices:[{message:{content:'ok',tool_calls:[{id:'c',function:{name:'f',arguments:'{}'}}]}}],usage:{prompt_tokens:1,completion_tokens:2,total_tokens:3}},'m');
  assert.equal(r.object,'response');
  assert.equal(r.output[0].type,'message');
  assert.equal(r.output[1].type,'function_call');
  assert.equal(r.usage.total_tokens,3);
});
