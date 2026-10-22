import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('restart reports abandoned task interrupted and refuses automatic retry of its id',async()=>{
  const root=await mkdtemp(join(tmpdir(),'bridge-recovery-'));
  const client=new Client({name:'recovery-test',version:'1'});
  try{
    const stateDir=join(root,'state');await mkdir(join(stateDir,'tasks'),{recursive:true});
    const configPath=join(root,'config.json');
    await writeFile(configPath,JSON.stringify({executable:process.execPath,prefixArgs:['unused.mjs'],profile:'test',home:root,stateDir}));
    await writeFile(join(stateDir,'tasks','abandoned.json'),JSON.stringify({taskId:'abandoned',status:'running',ownerInstance:'previous-instance',ownerPid:null,monitor:{pid:null}}));
    await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../server.mjs',import.meta.url))],cwd:root,env:{...process.env,DSH_BRIDGE_CONFIG_PATH:configPath},stderr:'pipe'}));
    const result=await client.callTool({name:'get_bridge_task_status',arguments:{taskId:'abandoned'}});
    const record=JSON.parse(result.content[0].text);assert.equal(record.status,'interrupted');assert.equal(record.workerPidPresent,false);
    const retry=await client.callTool({name:'delegate_to_deepseek',arguments:{taskId:'abandoned',task:'do not launch',workspace:root}});
    assert.equal(retry.isError,true);assert.match(retry.content[0].text,/EEXIST/);
  }finally{await client.close();assert.ok(root.startsWith(join(tmpdir(),'bridge-recovery-')));await rm(root,{recursive:true,force:true});}
});
