import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import YAML from 'yaml';
import TOML from '@iarna/toml';
import {parseArgs,buildWorkerPatch,planSetup,applyPlan} from '../configure.mjs';
import {normalizeRuntimeConfig,DEFAULT_TIMEOUT_MS} from '../src/dsh-config.mjs';

const rows=[{id:'agent-default-model',config:{provider:'custom',model:'worker-model'}},
  {id:'llm-pi-ai',config:{providers:{custom:{baseUrl:'https://example.com/v1',api:'openai-responses',apiKeyEnv:'MANAGED_PROVIDER_KEY',models:[{id:'worker-model',name:'worker-model'}]},unused:{apiKey:'never-copy'}}}},
  {id:'unrelated-private-plugin',config:{private:'never-copy'}}];
async function fixture(run){
  const root=await mkdtemp(join(tmpdir(),'bridge-setup-'));
  try{
    const home=join(root,'dsh'),codex=join(root,'codex'),entry=join(root,'cli.js');
    await mkdir(join(home,'profiles','desktop'),{recursive:true});await mkdir(codex);
    await writeFile(join(home,'profiles','desktop','cordis.patch.yml'),YAML.stringify(rows));
    await writeFile(entry,'// test fixture');
    const original='model = "strong-main"\n\n[features]\nexample = true\n';
    await writeFile(join(codex,'config.toml'),original);
    const options={'cli-entry':entry,'dsh-home':home,'codex-home':codex,'register-codex':true};
    await run({root,home,codex,entry,options,original});
  }finally{assert.ok(root.startsWith(join(tmpdir(),'bridge-setup-')));await rm(root,{recursive:true,force:true});}
}
test('setup selects only chosen route and generates real Cordis confinement/storage rows',()=>{
  const result=buildWorkerPatch(rows,{profile:'worker',stateDir:'state',isolateSessions:true});
  assert.equal(result.provider,'custom');assert.equal(result.model,'worker-model');
  assert.equal(JSON.stringify(result.patch).includes('never-copy'),false);
  const byId=Object.fromEntries(result.patch.map(x=>[x.id,x]));
  assert.equal(byId.permission.config.presets['workspace-no-escalation'].sandbox,'workspace-write');
  assert.equal(byId.permission.config.presets['workspace-no-escalation'].approval,'never');
  assert.ok(byId['session-persistence-jsonl'].config.root.endsWith(join('dsh','sessions')));
  assert.equal(byId['tool-subagent'].disabled,true);
});
test('desktop visibility is default; isolation is explicit',()=>{
  const visible=buildWorkerPatch(rows,{profile:'worker',stateDir:'state'}).patch;
  assert.equal(visible.some(x=>x.id==='storage-json'||x.id==='session-persistence-jsonl'),false);
});
test('inline secrets and URL credentials rejected rather than copied',()=>{
  const malicious=structuredClone(rows);malicious[1].config.providers.custom.apiKey='example-inline-secret';
  assert.throws(()=>buildWorkerPatch(malicious,{stateDir:'state'}),/Inline secret/);
  delete malicious[1].config.providers.custom.apiKey;
  malicious[1].config.providers.custom.baseUrl='https://user:pass@example.com/v1';
  assert.throws(()=>buildWorkerPatch(malicious,{stateDir:'state'}),/URL/);
});
test('dry planning writes nothing; application preserves main model and is idempotent',async()=>fixture(async({root,home,codex,options,original})=>{
  const plan=await planSetup(options,{repoRoot:root});
  await assert.rejects(readFile(join(home,'profiles','codex-worker','package.json')),/ENOENT/);
  assert.equal(await readFile(join(codex,'config.toml'),'utf8'),original);
  const applied=await applyPlan(plan);assert.equal(applied.written.length,4);assert.equal(applied.backups.length,1);
  const config=TOML.parse(await readFile(join(codex,'config.toml'),'utf8'));
  assert.equal(config.model,'strong-main');assert.equal(config.features.example,true);
  assert.equal(config.mcp_servers.deepseek_harness.tool_timeout_sec,2100);
  assert.equal(plan.runtime.timeoutMs,1800000);assert.equal(plan.runtime.maxConcurrency,4);
  const manifest=JSON.parse(await readFile(join(home,'profiles','codex-worker','package.json'),'utf8'));
  assert.deepEqual(manifest.dsh.profile.bundles,['@deepseek-ai/dsh-base','@deepseek-ai/dsh-headless']);
  const again=await applyPlan(await planSetup(options,{repoRoot:root}));assert.deepEqual(again.written,[]);
}));
test('conflicting MCP config refused even with force',async()=>fixture(async({root,codex,options})=>{
  await writeFile(join(codex,'config.toml'),'model="strong"\n[mcp_servers.deepseek_harness]\ncommand="existing"\n');
  await assert.rejects(planSetup({...options,force:true},{repoRoot:root}),/already exists and differs/);
}));
test('conflicting runtime files refused and concurrent changes detected',async()=>fixture(async({root,options})=>{
  const first=await planSetup(options,{repoRoot:root});await applyPlan(first);
  await assert.rejects(planSetup({...options,'max-concurrency':'5'},{repoRoot:root}),/Existing file differs|already exists/);
  const plan=await planSetup({...options,'register-codex':false,force:true,'max-concurrency':'5'},{repoRoot:root});
  await writeFile(join(root,'bridge.config.json'),'changed concurrently');
  await assert.rejects(applyPlan(plan),/changed after planning/);
}));
test('CLI and runtime reject invalid boundaries',()=>{
  assert.throws(()=>parseArgs(['--unknown']),/Unknown/);
  assert.throws(()=>parseArgs(['--cli-entry']),/Missing/);
  const config={executable:'node',prefixArgs:['entry.mjs'],profile:'worker',home:'home'};
  assert.equal(normalizeRuntimeConfig(config).timeoutMs,DEFAULT_TIMEOUT_MS);
  assert.equal(DEFAULT_TIMEOUT_MS,1800000);
  assert.deepEqual(normalizeRuntimeConfig(normalizeRuntimeConfig(config)),normalizeRuntimeConfig(config));
  for(const value of [0,6,1.5,'4x'])assert.throws(()=>normalizeRuntimeConfig({...config,maxConcurrency:value}),/maxConcurrency/);
  assert.throws(()=>normalizeRuntimeConfig({...config,timeoutMs:'840000junk'}),/timeoutMs/);
  assert.throws(()=>normalizeRuntimeConfig({...config,permissionMode:'danger-full-access'}),/confinement/);
});
