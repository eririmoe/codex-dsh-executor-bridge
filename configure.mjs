#!/usr/bin/env node
import {readFile,writeFile,mkdir,copyFile,stat,unlink,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve,join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import YAML from 'yaml';
import TOML from '@iarna/toml';

export const ROOT=fileURLToPath(new URL('.',import.meta.url));
const namePattern=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const usage=`Usage: node setup.mjs [options]
  --desktop-root DIR       Official Windows DSH Desktop installation directory
  --cli-entry FILE         Alternative: actual DSH JavaScript CLI entry (not .cmd)
  --dsh-home DIR           Existing DSH home (default DSH_HOME or ~/.dsh)
  --source-profile NAME    Existing GUI profile (default desktop)
  --profile NAME           New dedicated worker profile (default codex-worker)
  --max-concurrency N      Default 4, allowed 1..5 (per MCP server process)
  --timeout-ms MS          Worker wall-clock deadline (default 1800000)
  --state-dir DIR          Private worker/session ledger directory
  --isolate-sessions       Hide worker sessions from the desktop's default storage
  --config FILE            Local runtime JSON output
  --register-codex         Explicitly append MCP entry; selected main model unchanged
  --codex-home DIR         Default CODEX_HOME or ~/.codex
  --server-name NAME       Default deepseek_harness
  --force                  Back up then replace local worker/runtime files
                           (does not overwrite an existing conflicting MCP entry)
  --dry-run                Validate and show destination paths; write nothing
  --help                   Show help

First configure and select your model in the DSH GUI. This command reads only
the chosen provider settings and credential reference; it never reads credential
values. Supports custom/catalog pi-ai providers and DeepSeek official API routes.
`;
export function parseArgs(args){
  const out={};const booleans=new Set(['help','dry-run','force','register-codex','isolate-sessions']);
  const values=new Set(['desktop-root','cli-entry','dsh-home','source-profile','profile','max-concurrency','timeout-ms','state-dir','config','codex-home','server-name']);
  for(let i=0;i<args.length;i++){
    const key=args[i].replace(/^--/,'');
    if(!args[i].startsWith('--')||(!booleans.has(key)&&!values.has(key)))throw new Error(`Unknown option: ${args[i]}`);
    if(booleans.has(key))out[key]=true;
    else {if(!args[i+1]||args[i+1].startsWith('--'))throw new Error(`Missing value for --${key}`);out[key]=args[++i];}
  }return out;
}
function checkedInt(value,min,max,label){const n=Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error(`${label} must be an integer ${min}..${max}`);return n;}
async function readIfExists(path){try{return await readFile(path,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export function rejectInlineSecrets(value){
  if(!value||typeof value!=='object')return;
  for(const [key,v]of Object.entries(value)){
    const normalized=key.toLowerCase().replace(/[_-]/g,'');
    if(['apikey','token','secret','password','authorization','cookie','accesskey','privatekey'].includes(normalized)&&v)throw new Error(`Inline secret field ${key} refused; use DSH managed credential references`);
    if(/baseurl|endpoint/i.test(key)&&typeof v==='string'){
      const url=new URL(v);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('Provider URL must not carry credentials, query strings, or fragments');
    }
    if(typeof v==='object')rejectInlineSecrets(v);
  }
}
export function buildWorkerPatch(rows,{profile,stateDir,isolateSessions=false}){
  if(!Array.isArray(rows))throw new Error('Source cordis.patch.yml must be a patch list');
  const selection=rows.find(x=>x?.id==='agent-default-model');
  const {provider,model}=selection?.config??{};
  if(typeof provider!=='string'||typeof model!=='string')throw new Error('Select a model in the source DSH GUI profile first');
  const patch=[structuredClone(selection)];
  const providers=rows.find(x=>x?.id==='llm-pi-ai')?.config?.providers;
  if(providers&&Object.hasOwn(providers,provider)){
    const route=structuredClone(providers[provider]);rejectInlineSecrets(route);
    patch.push({id:'llm-pi-ai',config:{providers:{[provider]:route}}});
  }else if(provider==='deepseek-official'){
    const route=rows.find(x=>x?.id==='llm-deepseek');
    if(route){rejectInlineSecrets(route.config);patch.push(structuredClone(route));}
  }else throw new Error('Unsupported source route; use a custom model API provider in DSH Settings → Models');
  patch.push(
    {id:'credentials',disabled:false},
    {id:'approval',config:{policy:'never'}},
    {id:'permission',config:{defaultPreset:'workspace-no-escalation',presets:{'workspace-no-escalation':{sandbox:'workspace-write',approval:'never',name:'Workspace worker',description:'Confined workspace writes; no unattended escalation.'}}}},
    ...['tool-web','tool-subagent','tool-subagent-fork','tool-workflow','session-log-deepseek'].map(id=>({id,disabled:true})),
  );
  for(const id of ['session-persistence-jsonl','storage-json']){
    if(isolateSessions)patch.push({id,config:{root:join(stateDir,'dsh',id==='storage-json'?'storages':'sessions')}});
    else {const source=rows.find(row=>row?.id===id);if(source)patch.push(structuredClone(source));}
  }
  return {patch,provider,model,profile};
}
export async function planSetup(options,{repoRoot=ROOT,env=process.env}={}){
  const home=resolve(options['dsh-home']??env.DSH_HOME??join(homedir(),'.dsh'));
  const profile=options.profile??'codex-worker',sourceProfile=options['source-profile']??'desktop',serverName=options['server-name']??'deepseek_harness';
  for(const name of [profile,sourceProfile,serverName])if(!namePattern.test(name))throw new Error('Profile/server names must contain only letters, digits, underscore and hyphen');
  if(profile===sourceProfile)throw new Error('Worker profile must differ from the source GUI profile');
  const maxConcurrency=checkedInt(options['max-concurrency']??4,1,5,'max-concurrency');
  const timeoutMs=checkedInt(options['timeout-ms']??1800000,1000,3600000,'timeout-ms');
  const stateDir=resolve(options['state-dir']??join(repoRoot,'.state'));
  let executable,prefixArgs;
  if(options['desktop-root']&&options['cli-entry'])throw new Error('Choose desktop-root or cli-entry, not both');
  if(options['desktop-root']){
    if(process.platform!=='win32')throw new Error('Desktop mode is currently validated only for Windows; use cli-entry on other platforms');
    const root=resolve(options['desktop-root']);executable=join(root,'DeepSeek Harness.exe');
    await stat(executable);await stat(join(root,'resources','app.asar'));
    prefixArgs=['--expose-internals',join(root,'resources','app.asar','dsh','node_modules','@deepseek-ai','dsh-desktop-host','lib','cli.js')];
  }else if(options['cli-entry']){
    const entry=resolve(options['cli-entry']);if(!/\.(?:mjs|cjs|js)$/i.test(entry))throw new Error('cli-entry must be a JavaScript file, not a shell shim');
    await stat(entry);executable=process.execPath;prefixArgs=['--expose-internals',entry];
  }else throw new Error('Pass --desktop-root or --cli-entry');
  const source=await readFile(join(home,'profiles',sourceProfile,'cordis.patch.yml'),'utf8');
  const document=YAML.parseDocument(source,{strict:true});if(document.errors.length)throw new Error('Source DSH patch is not valid YAML');
  const {patch,provider,model}=buildWorkerPatch(document.toJS(),{profile,stateDir,isolateSessions:!!options['isolate-sessions']});
  const profileDir=join(home,'profiles',profile);
  const configPath=resolve(options.config??join(repoRoot,'bridge.config.json'));
  const runtime={schemaVersion:1,executable,prefixArgs,profile,home,stateDir,timeoutMs,maxConcurrency,heartbeatMs:5000,stallWarningMs:180000};
  const files=[
    {path:join(profileDir,'package.json'),text:JSON.stringify({name:`dsh-profile-${profile}`,private:true,dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-headless']}}},null,2)+'\n'},
    {path:join(profileDir,'cordis.patch.yml'),text:YAML.stringify(patch)},
    {path:configPath,text:JSON.stringify(runtime,null,2)+'\n'},
  ];
  if(options['register-codex']){
    const path=join(resolve(options['codex-home']??env.CODEX_HOME??join(homedir(),'.codex')),'config.toml');
    const original=await readIfExists(path)??'';const before=TOML.parse(original);
    const entry={command:process.execPath,args:[join(repoRoot,'server.mjs')],startup_timeout_sec:20,tool_timeout_sec:Math.ceil(timeoutMs/1000)+300,enabled_tools:['delegate_to_deepseek','get_bridge_task_status','cancel_deepseek_task'],default_tools_approval_mode:'prompt',env:{DSH_BRIDGE_CONFIG_PATH:configPath}};
    const existing=before.mcp_servers?.[serverName];
    if(existing&&!isDeepStrictEqual(existing,entry))throw new Error(`MCP ${serverName} already exists and differs; preserve/review it or choose --server-name`);
    let text=original;
    if(!existing){const block=TOML.stringify({mcp_servers:{[serverName]:entry}});text=original+(original.endsWith('\n')?'\n':'\n\n')+block;const after=TOML.parse(text);delete after.mcp_servers[serverName];const prior=structuredClone(before);prior.mcp_servers??={};if(!isDeepStrictEqual(after,prior))throw new Error('Unexpected unrelated Codex configuration change');}
    files.push({path,text,codex:true});
  }
  for(const file of files){file.original=await readIfExists(file.path);if(file.original!==null&&file.original!==file.text&&!file.codex&&!options.force)throw new Error(`Existing file differs: ${file.path}; inspect it before --force`);}
  return {files,runtime,provider,model};
}
export async function applyPlan(plan){
  const applied=[];const backups=[];
  try{
    for(const file of plan.files){
      if(file.original===file.text)continue;
      const current=await readIfExists(file.path);if(current!==file.original)throw new Error(`File changed after planning: ${file.path}`);
      await mkdir(dirname(file.path),{recursive:true});
      if(file.original!==null){const backup=`${file.path}.bak.${Date.now()}`;await copyFile(file.path,backup);backups.push(backup);}
      const temporary=`${file.path}.${randomUUID()}.tmp`;
      try {await writeFile(temporary,file.text,{mode:0o600});await rename(temporary,file.path);applied.push(file);}
      finally {await unlink(temporary).catch(()=>{});}
    }return {written:applied.map(x=>x.path),backups};
  }catch(error){for(const file of applied.reverse()){if(file.original===null)await unlink(file.path).catch(()=>{});else await writeFile(file.path,file.original,{mode:0o600});}throw error;}
}
export async function main(args=process.argv.slice(2)){
  const options=parseArgs(args);if(options.help){console.log(usage);return;}
  const plan=await planSetup(options);
  console.log(JSON.stringify({dryRun:!!options['dry-run'],provider:plan.provider,model:plan.model,maxConcurrency:plan.runtime.maxConcurrency,timeoutMs:plan.runtime.timeoutMs,destinations:plan.files.map(x=>x.path)},null,2));
  if(!options['dry-run'])console.log(JSON.stringify(await applyPlan(plan),null,2));
  console.log('Review any MCP approval prompt, then restart Codex/open a new chat. Worker completion still requires main-model acceptance.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
