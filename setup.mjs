export * from './configure.mjs';
import {main} from './configure.mjs';
main().catch(error=>{console.error(error.message);process.exitCode=1;});
