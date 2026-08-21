import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { ChatSseToResponses, convertChatSse, MAX_CHAT_SSE_BLOCK_BYTES, MAX_CHAT_TOOL_ARGUMENT_BYTES } from '../src/translate.mjs';

test('chat SSE converter preserves a final unterminated data block and supports async backpressure callbacks',async()=>{const payload='data: '+JSON.stringify({choices:[{delta:{content:'tail'}}]});const chunks=[];await convertChatSse(Readable.from([Buffer.from(payload)]),async(chunk)=>{await new Promise(r=>setTimeout(r,1));chunks.push(chunk)},{model:'m'});const text=chunks.join('');assert.match(text,/response\.output_text\.delta/);assert.match(text,/tail/);assert.match(text,/response\.completed/)});

test('chat SSE converter does not duplicate completion when upstream sends DONE then closes without another block',async()=>{const stream=Readable.from([Buffer.from('data: '+JSON.stringify({choices:[{delta:{content:'ok'}}]})+'\n\ndata: [DONE]')]);const chunks=[];await convertChatSse(stream,(chunk)=>chunks.push(chunk),{model:'m'});const text=chunks.join('');assert.equal((text.match(/"type":"response.completed"/g)||[]).length,1)});

test('chat SSE converter fails closed on an unterminated oversized SSE block',async()=>{const payload=Buffer.from(`data: ${'x'.repeat(MAX_CHAT_SSE_BLOCK_BYTES+64)}`);await assert.rejects(()=>convertChatSse(Readable.from([payload]),()=>{}, {model:'m'}),(error)=>error?.code==='UPSTREAM_RESPONSE_TOO_LARGE')});

test('chat SSE converter bounds accumulated function-call arguments',()=>{const converter=new ChatSseToResponses({model:'m'});const almost='x'.repeat(Math.floor(MAX_CHAT_TOOL_ARGUMENT_BYTES/2));converter.feedData(JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'call',function:{name:'shell',arguments:almost}}]}}]}));assert.throws(()=>converter.feedData(JSON.stringify({choices:[{delta:{tool_calls:[{index:0,function:{arguments:almost+'overflow'}}]}}]})),(error)=>error?.code==='UPSTREAM_RESPONSE_TOO_LARGE')});
