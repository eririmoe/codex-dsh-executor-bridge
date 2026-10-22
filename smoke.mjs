#!/usr/bin/env node
// OPT-IN real-API smoke test.
//
// This is the only test that talks to a real model provider, and it is scoped to
// a synthetic fixture directory under the OS temp dir. It is not part of
// `npm test`; run it explicitly:
//
//   DSH_BRIDGE_SMOKE=1 node smoke.mjs
//
//   PowerShell:  $env:DSH_BRIDGE_SMOKE=1; node smoke.mjs
//
// Requirements:
//   * bridge.config.json exists (or DSH_BRIDGE_CONFIG_PATH points at one);
//   * the worker profile has a usable credential;
//   * the worker can write inside the fixture directory (permission mode
//     `workspace-write` is what the bridge passes).
//
// It asserts a real end-to-end round trip: the nonce is delivered over stdin,
// the model writes it to a file inside the fixture workspace, and the file
// content is exactly the nonce.

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultConfigPath } from './src/dsh-config.mjs';
import { runDsh } from './src/dsh-runtime.mjs';

if (process.env.DSH_BRIDGE_SMOKE !== '1') {
  process.stderr.write(
    'smoke test is opt-in and never runs by default.\n' +
      'Set DSH_BRIDGE_SMOKE=1 to acknowledge that it will call your configured model provider.\n',
  );
  process.exit(2);
}

const nonce = `SMOKE-${randomUUID()}`;
const workspace = await mkdtemp(join(tmpdir(), 'codex-dsh-smoke-'));
const resultFile = join(workspace, 'smoke-result.txt');

const task = `Create a file named smoke-result.txt in the working directory.
Its entire content must be exactly this single line, with no extra text, quotes or blank lines:
${nonce}
Then reply with the word DONE. Do not do anything else.`;

const timeoutMs = Number.parseInt(process.env.DSH_BRIDGE_SMOKE_TIMEOUT_MS ?? '600000', 10);
let exitCode = 1;

try {
  process.stdout.write(`bridge config : ${defaultConfigPath()}\n`);
  process.stdout.write(`fixture       : ${workspace}\n`);
  const { stdout, metadata } = await runDsh(task, { cwd: workspace, timeoutMs });
  process.stdout.write(`--- worker stdout ---\n${stdout.trim()}\n`);
  process.stdout.write(`--- completion metadata ---\n${JSON.stringify(metadata)}\n`);

  const content = await readFile(resultFile, 'utf8');
  if (!new Set([nonce,nonce+'\n',nonce+'\r\n']).has(content)) {
    throw new Error(`expected the fixture file to contain the nonce, got: ${JSON.stringify(content)}`);
  }
  process.stdout.write(`PASS: the worker wrote the exact nonce to ${resultFile}\n`);
  exitCode = 0;
} catch (error) {
  process.stdout.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
} finally {
  if (workspace.startsWith(join(tmpdir(), 'codex-dsh-smoke-'))) {
    await rm(workspace, { recursive: true, force: true });
  }
}

process.exitCode = exitCode;
