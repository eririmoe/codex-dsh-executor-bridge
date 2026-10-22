import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

async function fixture(run){
  const root=await mkdtemp(join(tmpdir(),'bridge-context-mcp-'));
  const client=new Client({name:'context-test',version:'1'});
  try{
    const worker=join(root,'worker.mjs'),config=join(root,'runtime.json');
    await writeFile(worker,`let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{setTimeout(()=>{console.log(JSON.stringify({type:'final',text}));console.log(JSON.stringify({type:'status',phase:'turn_end',reason:{kind:'completed'}}));},text.includes('BLOCK_FIRST')?1200:0);});`);
    await writeFile(config,JSON.stringify({executable:process.execPath,prefixArgs:[worker],profile:'fixture',home:root,stateDir:join(root,'state')}));
    await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../server.mjs',import.meta.url))],cwd:root,env:{...process.env,DSH_BRIDGE_CONFIG_PATH:config},stderr:'pipe'}));
    await run({root,client});
  }finally{await client.close();assert.ok(root.startsWith(join(tmpdir(),'bridge-context-mcp-')));await rm(root,{recursive:true,force:true});}
}
const delegate=(client,args)=>client.callTool({name:'delegate_to_deepseek',arguments:args},undefined,{timeout:20000});
async function status(client,taskId){const r=await client.callTool({name:'get_bridge_task_status',arguments:{taskId}});return r.isError?null:JSON.parse(r.content[0].text);}
async function waitFor(fn){const end=Date.now()+10000;while(Date.now()<end){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,25));}throw new Error('Expected task registration state was not reached');}
const context={schemaVersion:1,summary:'上下文',confirmedFacts:['统计单位是供体'],invariants:['不得改写为读段比例'],acceptanceChecks:['保留统计单位'],messages:[{role:'user',text:'背景信息'}]};

test('context path, exact captured JSON and hash reach the worker and ledger',async()=>fixture(async({root,client})=>{
  const contextPath=join(root,'context.json'),text=JSON.stringify(context,null,2);await writeFile(contextPath,text);
  const tools=await client.listTools();assert.ok(tools.tools.find(x=>x.name==='delegate_to_deepseek').inputSchema.properties.contextPath);
  const result=await delegate(client,{workspace:root,taskId:'with-context',task:'Use supplied facts; edit nothing.',contextPath});
  assert.ok(!result.isError,result.content[0].text);
  const answer=result.content[0].text;
  assert.ok(answer.includes(text));assert.match(answer,/contextPath=/);assert.match(answer,/historical reference data/);
  const record=await status(client,'with-context');
  assert.equal(record.context.sha256,createHash('sha256').update(text).digest('hex'));
  assert.equal(record.context.bytes,Buffer.byteLength(text));
  assert.equal(JSON.stringify(record).includes('统计单位是供体'),false,'ledger stores metadata only');
  assert.equal(await readFile(contextPath,'utf8'),text,'caller context is never rewritten');
}));
test('queued task keeps the context captured at submission even if source later changes',async()=>fixture(async({root,client})=>{
  const contextPath=join(root,'context.json'),text=JSON.stringify(context);await writeFile(contextPath,text);
  const first=delegate(client,{workspace:root,taskId:'first',task:'BLOCK_FIRST'});
  await waitFor(async()=>(await status(client,'first'))?.status==='running');
  const second=delegate(client,{workspace:root,taskId:'second',task:'Use captured facts.',contextPath});
  await waitFor(async()=>(await status(client,'second'))?.status==='queued');
  await writeFile(contextPath,JSON.stringify({...context,confirmedFacts:['CHANGED_AFTER_SUBMISSION']}));
  const [a,b]=await Promise.all([first,second]);assert.ok(!a.isError,a.content[0].text);assert.ok(!b.isError,b.content[0].text);
  assert.ok(b.content[0].text.includes(text));assert.equal(b.content[0].text.includes('CHANGED_AFTER_SUBMISSION'),false);
  assert.equal((await status(client,'second')).context.sha256,createHash('sha256').update(text).digest('hex'));
}));
test('raw log and invalid context schemas fail before worker launch',async()=>fixture(async({root,client})=>{
  for(const [name,text]of [['raw.jsonl','{"type":"response_item"}\n'],['bad.json',JSON.stringify({schemaVersion:1,messages:[{role:'system',text:'not caller context'}]})]]){
    const contextPath=join(root,name);await writeFile(contextPath,text);
    const result=await delegate(client,{workspace:root,taskId:name,task:'Never launch',contextPath});
    assert.equal(result.isError,true);assert.equal(await status(client,name),null);
  }
}));
