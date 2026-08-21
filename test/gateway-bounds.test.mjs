import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ResponsesGateway } from '../src/gateway.mjs';

const token='A'.repeat(43);
const state={provider:{baseUrl:'http://provider.test/v1',protocol:'auto',apiKeyCipher:'cipher',headers:{}},protocolCache:{},models:{main:'m',worker:'m'},routing:{}};
function store(){return{env:{CWD_PROVIDER_REQUEST_TIMEOUT_MS:'5000'},async read(){return structuredClone(state)},async ensureGatewayToken(){return token},async update(fn){return fn(structuredClone(state))}}}
async function listen(server){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});return server.address().port}
function serve(t,gateway){const server=http.createServer((req,res)=>{void gateway.handle(req,res,{model:'m',stream:false,input:'x'}).catch((error)=>{if(!res.headersSent){res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({code:error.code,message:error.message}))}else res.destroy(error)})});t.after(()=>new Promise((resolve)=>server.close(()=>resolve())));return listen(server).then((port)=>`http://127.0.0.1:${port}/v1/responses`)}

test('auto-detection cancels an oversized failed Responses body instead of teeing or hanging it',async(t)=>{let cancelled=false;const body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(70*1024))},cancel(){cancelled=true}});const gateway=new ResponsesGateway({store:store(),vault:{async decrypt(){return'k'}},fetchImpl:async()=>new Response(body,{status:400,headers:{'content-type':'text/plain'}})});const url=await serve(t,gateway);const response=await fetch(url,{method:'POST',headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(2000)});assert.equal(response.status,502);const error=await response.json();assert.equal(error.code,'UPSTREAM_RESPONSE_TOO_LARGE');assert.equal(cancelled,true)});

test('auto-detection preserves a bounded non-fallback provider error response',async(t)=>{const gateway=new ResponsesGateway({store:store(),vault:{async decrypt(){return'k'}},fetchImpl:async()=>new Response('{"error":"bad key"}',{status:401,headers:{'content-type':'application/json','x-request-id':'req-1'}})});const url=await serve(t,gateway);const response=await fetch(url,{method:'POST',headers:{authorization:`Bearer ${token}`}});assert.equal(response.status,401);assert.equal(response.headers.get('x-request-id'),'req-1');assert.match(await response.text(),/bad key/)});
