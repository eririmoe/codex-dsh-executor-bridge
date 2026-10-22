#!/usr/bin/env node
// Local draft exporter. This command never calls a model or sends a request.
import {mkdir,writeFile,stat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {exportConversation} from '../src/context-export.mjs';

try {
  const args=process.argv.slice(2),options={};
  if(args.includes('--help')){
    console.log('Usage: node scripts/export-context.mjs --source ACTUAL_CHAT.jsonl --output WORKSPACE/.bridge-context/TASK.json [--max-messages 40] [--max-text-bytes 48000]\nWrites a new local draft only. Review and fill summary/confirmedFacts/invariants/acceptanceChecks before delegation. Does not overwrite existing output.');
  } else {
    for(let i=0;i<args.length;i+=2){
      if(!['--source','--output','--max-messages','--max-text-bytes'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw new Error('Unknown option or missing value; use --help');
      options[args[i].slice(2)]=args[i+1];
    }
    if(!options.source||!options.output)throw new Error('--source and --output are required');
    const source=resolve(options.source),output=resolve(options.output);
    if(!source.endsWith('.jsonl')||!output.endsWith('.json')||source===output)throw new Error('Source must be .jsonl and output a separate .json file');
    if(!(await stat(source)).isFile())throw new Error('Source must be a regular file');
    const maxMessages=Number(options['max-messages']??40),maxTextBytes=Number(options['max-text-bytes']??48000);
    if(!Number.isInteger(maxMessages)||maxMessages<1||maxMessages>60)throw new Error('max-messages must be 1..60');
    if(!Number.isInteger(maxTextBytes)||maxTextBytes<1000||maxTextBytes>48000)throw new Error('max-text-bytes must be 1000..48000');
    const context=await exportConversation(source,{maxMessages,maxTextBytes});
    const text=JSON.stringify(context,null,2)+'\n';
    if(Buffer.byteLength(text)>98304)throw new Error('Draft too large; lower max-messages or max-text-bytes');
    await mkdir(dirname(output),{recursive:true,mode:0o700});
    await writeFile(output,text,{flag:'wx',mode:0o600});
    console.log(JSON.stringify({output,messages:context.messages.length,bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex'),truncated:context.provenance.truncated,reviewRequired:true},null,2));
  }
} catch(error){console.error(error.message);process.exitCode=1;}
