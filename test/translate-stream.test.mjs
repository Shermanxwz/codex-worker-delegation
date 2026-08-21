import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { convertChatSse } from '../src/translate.mjs';

test('chat SSE converter preserves a final unterminated data block and supports async backpressure callbacks',async()=>{const payload='data: '+JSON.stringify({choices:[{delta:{content:'tail'}}]});const chunks=[];await convertChatSse(Readable.from([Buffer.from(payload)]),async(chunk)=>{await new Promise(r=>setTimeout(r,1));chunks.push(chunk)},{model:'m'});const text=chunks.join('');assert.match(text,/response\.output_text\.delta/);assert.match(text,/tail/);assert.match(text,/response\.completed/)});

test('chat SSE converter does not duplicate completion when upstream sends DONE then closes without another block',async()=>{const stream=Readable.from([Buffer.from('data: '+JSON.stringify({choices:[{delta:{content:'ok'}}]})+'\n\ndata: [DONE]')]);const chunks=[];await convertChatSse(stream,(chunk)=>chunks.push(chunk),{model:'m'});const text=chunks.join('');assert.equal((text.match(/"type":"response.completed"/g)||[]).length,1)});
