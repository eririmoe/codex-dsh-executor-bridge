#!/usr/bin/env node
// Run the full test suite with every test REQUIRED: the spawn-dependent tests
// that `npm test` may skip in a restricted sandbox become hard failures here.
//
// Uses stdio: 'inherit' so it also works in environments that block piped stdio.

import { spawnSync } from 'node:child_process';
import {readdirSync} from 'node:fs';

const files = readdirSync(new URL('../test/',import.meta.url)).filter(x=>x.endsWith('.test.mjs')).map(x=>`test/${x}`);
const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  env: { ...process.env, DSH_BRIDGE_REQUIRE_SPAWN_TESTS: '1' },
});

if (result.error) {
  process.stderr.write(`could not start the test runner: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
