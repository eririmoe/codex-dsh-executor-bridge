import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {loadTaskContext} from '../src/task-context.mjs';

test('CLI exports a local draft compatible with loader and refuses to overwrite it',async()=>{
  const root=await mkdtemp(join(tmpdir(),'context-export-cli-'));
  try{
    const source=join(root,'source.jsonl'),output=join(root,'context.json');
    const message=(role,text,phase)=>({type:'response_item',payload:{type:'message',role,phase,content:[{type:role==='user'?'input_text':'output_text',text}]}});
    const records=[{type:'session_meta',payload:{id:'synthetic-thread',cwd:'PRIVATE_METADATA'}},message('system','PRIVATE_SYSTEM'),message('assistant','PRIVATE_ANALYSIS','analysis'),message('user','Please preserve statistical units.'),message('assistant','Confirmed: donor is the unit.','final_answer'),{type:'response_item',payload:{type:'function_call_output',output:'PRIVATE_TOOL_RESULT'}}];
    const raw=records.map(x=>JSON.stringify(x)).join('\n')+'\n';await writeFile(source,raw);
    const args=[fileURLToPath(new URL('../scripts/export-context.mjs',import.meta.url)),'--source',source,'--output',output];
    const {stdout}=await promisify(execFile)(process.execPath,args,{timeout:10000});
    assert.equal(JSON.parse(stdout).reviewRequired,true);
    const loaded=await loadTaskContext(output,root),value=JSON.parse(loaded.text);
    assert.deepEqual(value.messages.map(x=>x.role),['user','assistant']);assert.deepEqual(value.confirmedFacts,[]);
    assert.equal(loaded.text.includes('PRIVATE_'),false);assert.equal(loaded.text.includes(source),false);
    assert.equal(await readFile(source,'utf8'),raw);
    await assert.rejects(promisify(execFile)(process.execPath,args,{timeout:10000}));
    assert.equal(await readFile(output,'utf8'),loaded.text);
  }finally{assert.ok(root.startsWith(join(tmpdir(),'context-export-cli-')));await rm(root,{recursive:true,force:true});}
});
