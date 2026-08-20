import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
const serverPath=path.resolve('plugins/codex-worker-delegation/mcp/server.mjs');

test('bundled MCP server initializes, lists and returns only redacted status',async(t)=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cwd-mcp-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));await fs.writeFile(path.join(dir,'state.json'),JSON.stringify({mode:'DELEGATE',mainSource:'official',models:{worker:'m'},provider:{name:'New API',baseUrl:'https://x/v1',protocol:'auto',apiKeyCipher:'SECRET'},protocolCache:{m:{protocol:'chat'}}}));const p=spawn(process.execPath,[serverPath],{env:{...process.env,CWD_DATA_DIR:dir}});t.after(()=>p.kill());let lines=[];p.stdout.setEncoding('utf8');p.stdout.on('data',c=>{lines.push(...c.trim().split('\n').filter(Boolean))});const send=(x)=>p.stdin.write(JSON.stringify(x)+'\n');send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}});send({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});send({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'delegation_status',arguments:{}}});await new Promise(r=>setTimeout(r,120));const parsed=lines.map(JSON.parse);assert.equal(parsed.find(x=>x.id===1).result.serverInfo.name,'codex-worker-delegation');assert.equal(parsed.find(x=>x.id===2).result.tools[0].name,'delegation_status');const text=parsed.find(x=>x.id===3).result.content[0].text;assert.match(text,/DELEGATE/);assert.doesNotMatch(text,/SECRET/)});
