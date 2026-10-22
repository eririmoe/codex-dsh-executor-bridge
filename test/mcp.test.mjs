// MCP integration test: real stdio handshake, tool listing, dispatch, ledger
// state and cancellation — driven against *mock* DSH workers that speak the
// strict `--json` JSONL protocol. No real DSH install, no network.
//
// Requires the dependencies from package.json (`npm install`), because the MCP
// SDK is the client here.
//
// The tests are deliberately strict: a blocked spawn or a worker that never
// emits the completion pair is a hard failure, never a silent skip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_PATH = fileURLToPath(new URL('../server.mjs', import.meta.url));

async function withTempDir(run) {
  const root = await mkdtemp(join(tmpdir(), 'codex-dsh-mcp-'));
  try {
    return await run(root);
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'codex-dsh-mcp-')));
    await rm(root, { recursive: true, force: true });
  }
}

// Reads the assigned task from stdin, then emits the strict completion pair.
const ECHO_WORKER = String.raw`
let text = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { text += chunk; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'final', text: JSON.stringify({ text, cwd: process.cwd() }) }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } }) + '\n');
});
`;

const HANG_WORKER = 'setInterval(() => {}, 1000);\n';

// Records its own wall-clock window in the final answer so tests can prove
// whether two tasks overlapped or were serialized.
function timedWorker(delayMs) {
  return String.raw`
const start = Date.now();
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: 'final', text: JSON.stringify({ start, end: Date.now() }) }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } }) + '\n');
}, ${delayMs});
`;
}

async function startBridge(root, { worker, name, timeoutMs } = {}) {
  const workerPath = join(root, `${name}.mjs`);
  await writeFile(workerPath, worker);
  const configPath = join(root, `${name}.config.json`);
  const stateDir = join(root, `state-${name}`);
  // The ledger must live in an explicit temporary state dir, never in the repo.
  const config = { executable: process.execPath, prefixArgs: [workerPath], profile: 'mock', home: root, stateDir };
  if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const env = { ...process.env, DSH_BRIDGE_CONFIG_PATH: configPath, DSH_BRIDGE_STATE_DIR: stateDir };
  const client = new Client({ name: 'codex-dsh-executor-bridge-test', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_PATH],
    cwd: root,
    env,
    stderr: 'pipe',
  });
  let diagnostics = '';
  transport.stderr?.on('data', (chunk) => { diagnostics += chunk.toString(); });
  await client.connect(transport);
  return { client, diagnostics: () => diagnostics, workerPath, stateDir };
}

async function rawStatus(client, taskId) {
  const result = await client.callTool({ name: 'get_bridge_task_status', arguments: { taskId } });
  if (result.isError) return { status: 'unknown' };
  return JSON.parse(result.content[0].text);
}

async function status(client, taskId) {
  const record = await rawStatus(client, taskId);
  assert.notEqual(record.status, 'unknown', `no ledger record for ${taskId}`);
  return record;
}

async function waitFor(check, { timeoutMs = 20_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for the expected state');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
}

function delegate(client, args, timeout = 60_000) {
  return client.callTool({ name: 'delegate_to_deepseek', arguments: args }, undefined, { timeout });
}

// The successful response is a status header, a blank line, then the final
// answer text. Workers encode their payload as JSON in that final text.
function completedPayload(result) {
  const [header, ...body] = result.content[0].text.split('\n\n');
  assert.match(header, /status=execution_completed/);
  assert.match(header, /not accepted; review required/);
  return JSON.parse(body.join('\n\n'));
}

test('MCP handshake lists exactly the three executor tools', async () => {
  await withTempDir(async (root) => {
    const { client } = await startBridge(root, { worker: ECHO_WORKER, name: 'echo' });
    try {
      const listed = await client.listTools();
      assert.deepEqual(
        listed.tools.map((tool) => tool.name),
        ['delegate_to_deepseek', 'get_bridge_task_status', 'cancel_deepseek_task'],
      );
      const delegateTool = listed.tools.find((tool) => tool.name === 'delegate_to_deepseek');
      assert.ok(delegateTool.inputSchema.properties.task, 'task must be a required input');
      assert.ok(delegateTool.inputSchema.required.includes('task'));
      const cancelTool = listed.tools.find((tool) => tool.name === 'cancel_deepseek_task');
      assert.ok(cancelTool.inputSchema.required.includes('taskId'));
    } finally {
      await client.close();
    }
  });
});

test('delegate_to_deepseek dispatches over stdin and records execution_completed (not acceptance)', async () => {
  await withTempDir(async (root) => {
    const { client, stateDir } = await startBridge(root, { worker: ECHO_WORKER, name: 'echo' });
    try {
      const task = '中文任务：检查 "@file" 并报告 $() & | < > %';
      const taskId = 'mcp-mock-1';
      // The server canonicalizes the workspace with fs.realpath; on Windows the
      // temp root may be a short 8.3 path, so compare against the real path.
      const expectedCwd = await realpath(root);
      const delegated = await delegate(client, { task, workspace: root, rootTaskId: taskId, taskId });
      assert.ok(!delegated.isError, delegated.content?.[0]?.text);

      const text = delegated.content[0].text;
      assert.match(text, new RegExp(`rootTaskId=${taskId}`));
      assert.match(text, /status=execution_completed/);

      const payload = completedPayload(delegated);
      assert.ok(payload.text.endsWith(task), 'the worker must receive the assigned task over stdin');
      assert.equal(payload.cwd, expectedCwd);

      const record = await status(client, taskId);
      assert.equal(record.status, 'execution_completed');
      assert.equal(record.acceptance, null, 'acceptance is never set by the executor');
      assert.equal(record.workspace, expectedCwd);
      assert.equal(record.owner, 'dsh');
      assert.ok(stateDir.startsWith(root), 'the ledger must live in the explicit temp state dir');
    } finally {
      await client.close();
    }
  });
});

test('a failing worker is reported as an error, recorded as failed, and never leaks stderr', async () => {
  await withTempDir(async (root) => {
    const { client } = await startBridge(root, {
      worker: "process.stderr.write('worker exploded');\nprocess.exit(3);\n",
      name: 'fail',
    });
    try {
      const taskId = 'mcp-mock-fail';
      const delegated = await delegate(client, { task: 'do the thing', workspace: root, taskId });
      assert.ok(delegated.isError, 'a non-zero worker must surface as a tool error');
      assert.match(delegated.content[0].text, /status=failed/);
      assert.match(delegated.content[0].text, /kind=process_exit/);
      assert.match(delegated.content[0].text, /code 3/);
      assert.equal(
        delegated.content[0].text.includes('worker exploded'),
        false,
        'raw worker stderr must never leak into the MCP response',
      );

      const record = await status(client, taskId);
      assert.equal(record.status, 'failed');
      assert.equal(record.errorKind, 'process_exit');
      assert.match(record.error, /code 3/);
      assert.equal(JSON.stringify(record.monitor).includes('worker exploded'), false);
    } finally {
      await client.close();
    }
  });
});

test('a worker that exceeds the timeout is recorded as timed_out', async () => {
  await withTempDir(async (root) => {
    const { client } = await startBridge(root, {
      worker: HANG_WORKER,
      name: 'slow',
      timeoutMs: 1000,
    });
    try {
      const taskId = 'mcp-mock-slow';
      const delegated = await delegate(client, { task: 'hang forever', workspace: root, taskId });
      assert.ok(delegated.isError);
      assert.match(delegated.content[0].text, /status=timed_out/);

      const record = await status(client, taskId);
      assert.equal(record.status, 'timed_out');
      assert.equal(record.errorKind, 'timeout');
    } finally {
      await client.close();
    }
  });
});

test('cancel_deepseek_task cancels a running task and rejects inactive ids', async () => {
  await withTempDir(async (root) => {
    const { client } = await startBridge(root, { worker: HANG_WORKER, name: 'cancel', timeoutMs: 600_000 });
    try {
      const taskId = 'mcp-cancel-1';
      const pending = delegate(client, { task: 'hang until cancelled', workspace: root, taskId });
      await waitFor(async () => (await rawStatus(client, taskId)).status === 'running');

      const cancelled = await client.callTool({ name: 'cancel_deepseek_task', arguments: { taskId } });
      assert.ok(!cancelled.isError, cancelled.content?.[0]?.text);
      assert.match(cancelled.content[0].text, /Cancellation requested/);

      const delegated = await pending;
      assert.ok(delegated.isError, 'a cancelled task must surface as a tool error');
      assert.match(delegated.content[0].text, /status=cancelled/);

      const record = await status(client, taskId);
      assert.equal(record.status, 'cancelled');
      assert.equal(record.errorKind, 'cancelled');

      const inactive = await client.callTool({ name: 'cancel_deepseek_task', arguments: { taskId: 'never-started' } });
      assert.ok(inactive.isError);
      assert.match(inactive.content[0].text, /not active/);
    } finally {
      await client.close();
    }
  });
});

test('get_bridge_task_status reports unknown ids as an error', async () => {
  await withTempDir(async (root) => {
    const { client } = await startBridge(root, { worker: ECHO_WORKER, name: 'echo' });
    try {
      const result = await client.callTool({ name: 'get_bridge_task_status', arguments: { taskId: 'does-not-exist' } });
      assert.ok(result.isError);
      assert.match(result.content[0].text, /Unknown taskId/);
    } finally {
      await client.close();
    }
  });
});

test('independent workspaces run in parallel', async () => {
  await withTempDir(async (root) => {
    const { client } = await startBridge(root, { worker: timedWorker(700), name: 'parallel' });
    try {
      const wsA = join(root, 'ws-a');
      const wsB = join(root, 'ws-b');
      await mkdir(wsA, { recursive: true });
      await mkdir(wsB, { recursive: true });

      const [a, b] = await Promise.all([
        delegate(client, { task: 'timed task', workspace: wsA, taskId: 'parallel-a' }),
        delegate(client, { task: 'timed task', workspace: wsB, taskId: 'parallel-b' }),
      ]);
      assert.ok(!a.isError, a.content?.[0]?.text);
      assert.ok(!b.isError, b.content?.[0]?.text);

      const ia = completedPayload(a);
      const ib = completedPayload(b);
      assert.ok(
        ia.start < ib.end && ib.start < ia.end,
        `independent workspaces must overlap (a=${ia.start}-${ia.end}, b=${ib.start}-${ib.end})`,
      );
    } finally {
      await client.close();
    }
  });
});

test('two tasks in the same workspace are serialized, never interleaved', async () => {
  await withTempDir(async (root) => {
    const { client } = await startBridge(root, { worker: timedWorker(500), name: 'serialized' });
    try {
      const [a, b] = await Promise.all([
        delegate(client, { task: 'timed task', workspace: root, taskId: 'same-a' }),
        delegate(client, { task: 'timed task', workspace: root, taskId: 'same-b' }),
      ]);
      assert.ok(!a.isError, a.content?.[0]?.text);
      assert.ok(!b.isError, b.content?.[0]?.text);

      const ia = completedPayload(a);
      const ib = completedPayload(b);
      assert.equal(
        ia.start < ib.end && ib.start < ia.end,
        false,
        `same-workspace tasks must not overlap (a=${ia.start}-${ia.end}, b=${ib.start}-${ib.end})`,
      );
    } finally {
      await client.close();
    }
  });
});