// Runtime tests for the DSH child-process launcher.
//
// These tests spawn a *mock* worker (this same Node binary running a fixture
// script) that speaks the strict DSH `--json` JSONL protocol; no real DSH
// install and no network are involved.
//
// The tests are deliberately strict: a spawn failure, a protocol violation or a
// missing completion event is a hard failure, never a silent skip. Skipping a
// spawn that was blocked or a worker that never emitted `turn_end` would hide
// exactly the regressions this suite exists to catch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runDsh } from '../src/dsh-runtime.mjs';

async function withFixture(root, name, source, run) {
  const file = join(root, name);
  await writeFile(file, source);
  return run(file);
}

function mockConfig(mockPath, root, extra = {}) {
  return { executable: process.execPath, prefixArgs: [mockPath], profile: 'mock-profile', home: root, ...extra };
}

// Emits the strict completion pair: `final` then `turn_end: completed`, then a
// clean exit. The payload is echoed as the final answer so the test can prove
// the task arrived over stdin (and nowhere else).
const ECHO_MOCK = String.raw`
let text = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { text += chunk; });
process.stdin.on('end', () => {
  const payload = {
    text,
    cwd: process.cwd(),
    argv: process.argv.slice(1),
    markerInArgv: process.argv.join(' ').includes('MARKER_7f3a9b'),
    markerInEnv: Object.values(process.env).some((value) => String(value).includes('MARKER_7f3a9b')),
  };
  process.stdout.write(JSON.stringify({ type: 'final', text: JSON.stringify(payload) }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } }) + '\n');
});
`;

// Exit 0 but no `turn_end`: must never be read as success.
const NO_TURNEND_MOCK = String.raw`
process.stdout.write(JSON.stringify({ type: 'final', text: 'answered but unfinished' }) + '\n');
`;

// Exit 0 with a non-completed turn reason: explicit failure, more informative
// than the exit code.
const BAD_REASON_MOCK = String.raw`
process.stdout.write(JSON.stringify({ type: 'final', text: 'turn broke' }) + '\n');
process.stdout.write(JSON.stringify({ type: 'status', phase: 'turn_end', reason: { kind: 'error' } }) + '\n');
`;

const HANG_MOCK = 'setInterval(() => {}, 1000);\n';

const FLOOD_MOCK = "for (let i = 0; i < 10; i += 1) process.stdout.write('x'.repeat(512 * 1024));\n";

// Emits one real event, then stays quiet for a while before completing: the
// runtime heartbeats during the quiet gap must report that same event
// timestamp instead of fabricating activity.
const HEARTBEAT_MOCK = String.raw`
process.stdout.write(JSON.stringify({ type: 'session', sessionId: 'hb-session' }) + '\n');
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: 'final', text: 'heartbeat done' }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } }) + '\n');
}, 2300);
`;

test('task text travels over UTF-8 stdin only (never argv/env) and cwd is explicit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-dsh-runtime-'));
  try {
    await withFixture(root, 'echo.mjs', ECHO_MOCK, async (mock) => {
      const task = `MARKER_7f3a9b 中文任务\nconst a = "hello";\n$() & | < > ^ % \` 'quote'\n${'长'.repeat(30_000)}`;
      const result = await runDsh(task, { cwd: root, runtimeConfig: mockConfig(mock, root) });
      const payload = JSON.parse(result.stdout);

      assert.equal(payload.text, task, 'stdin round-trip must be byte-exact');
      assert.equal(payload.cwd, root);
      assert.equal(payload.markerInArgv, false, 'task text must not appear on the command line');
      assert.equal(payload.markerInEnv, false, 'task text must not appear in the environment');
      assert.deepEqual(
        payload.argv.slice(-3),
        ['--profile', 'mock-profile', '--json'],
        'worker argv is only the strict --profile <p> --json selection',
      );
      assert.equal(result.metadata.turnEndKind, 'completed');
      assert.equal(result.metadata.finalReceived, true);
      assert.equal(result.stderr, '');
    });
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'codex-dsh-runtime-')));
    await rm(root, { recursive: true, force: true });
  }
});

test('a non-zero worker exit fails with safe metadata and never leaks stderr', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-dsh-runtime-'));
  try {
    await withFixture(root, 'fail.mjs', "process.stderr.write('boom');\nprocess.exit(7);\n", async (mock) => {
      await assert.rejects(
        runDsh('test', { cwd: root, runtimeConfig: mockConfig(mock, root) }),
        (error) => {
          assert.equal(error.kind, 'process_exit');
          assert.match(error.message, /code 7/);
          assert.equal(error.stderr, undefined, 'raw stderr is never attached to the failure');
          assert.equal(error.message.includes('boom'), false, 'raw worker stderr must not leak into the message');
          assert.equal(JSON.stringify(error.metadata).includes('boom'), false, 'metadata must stay safe');
          assert.equal(error.metadata.exitCode, 7);
          assert.equal(error.metadata.processAlive, false);
          return true;
        },
      );
    });
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'codex-dsh-runtime-')));
    await rm(root, { recursive: true, force: true });
  }
});

test('exit 0 without a completed turn_end (no final protocol completion) is a failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-dsh-runtime-'));
  try {
    await withFixture(root, 'no-turn-end.mjs', NO_TURNEND_MOCK, async (mock) => {
      await assert.rejects(
        runDsh('test', { cwd: root, runtimeConfig: mockConfig(mock, root) }),
        (error) => {
          assert.equal(error.kind, 'interrupted');
          assert.match(error.message, /no turn_end/);
          assert.equal(error.metadata.exitCode, 0);
          assert.equal(error.metadata.finalReceived, true);
          return true;
        },
      );
    });
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'codex-dsh-runtime-')));
    await rm(root, { recursive: true, force: true });
  }
});

test('an explicit non-completed turn reason fails even with a clean exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-dsh-runtime-'));
  try {
    await withFixture(root, 'bad-reason.mjs', BAD_REASON_MOCK, async (mock) => {
      await assert.rejects(
        runDsh('test', { cwd: root, runtimeConfig: mockConfig(mock, root) }),
        (error) => {
          assert.equal(error.kind, 'turn_error');
          assert.match(error.message, /turn ended without completion/);
          return true;
        },
      );
    });
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'codex-dsh-runtime-')));
    await rm(root, { recursive: true, force: true });
  }
});

test('a timeout terminates the worker and reports a failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-dsh-runtime-'));
  try {
    await withFixture(root, 'slow.mjs', HANG_MOCK, async (mock) => {
      const started = Date.now();
      await assert.rejects(
        runDsh('test', { cwd: root, timeoutMs: 1000, runtimeConfig: mockConfig(mock, root) }),
        (error) => {
          assert.equal(error.kind, 'timeout');
          assert.match(error.message, /timed out after 1000ms/);
          return true;
        },
      );
      assert.ok(Date.now() - started < 30_000, 'the timeout must actually terminate the worker');
    });
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'codex-dsh-runtime-')));
    await rm(root, { recursive: true, force: true });
  }
});

test('an AbortSignal cancellation terminates the worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-dsh-runtime-'));
  try {
    await withFixture(root, 'hang.mjs', HANG_MOCK, async (mock) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 300);
      try {
        await assert.rejects(
          runDsh('test', { cwd: root, signal: controller.signal, runtimeConfig: mockConfig(mock, root) }),
          (error) => {
            assert.equal(error.kind, 'cancelled');
            assert.match(error.message, /cancelled/);
            assert.equal(error.metadata.processAlive, false);
            return true;
          },
        );
      } finally {
        clearTimeout(timer);
      }
    });
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'codex-dsh-runtime-')));
    await rm(root, { recursive: true, force: true });
  }
});

test('an already-aborted signal never launches the worker', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runDsh('test', { cwd: process.cwd(), signal: controller.signal, runtimeConfig: { executable: process.execPath, prefixArgs: ['/nonexistent.mjs'], profile: 'p', home: process.cwd() } }),
    (error) => {
      assert.equal(error.kind, 'cancelled');
      assert.match(error.message, /cancelled before launch/);
      return true;
    },
  );
});

test('oversized worker output is rejected instead of buffered without limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-dsh-runtime-'));
  try {
    await withFixture(root, 'flood.mjs', FLOOD_MOCK, async (mock) => {
      await assert.rejects(
        runDsh('test', { cwd: root, runtimeConfig: mockConfig(mock, root) }),
        (error) => {
          assert.equal(error.kind, 'output_limit');
          assert.match(error.message, /exceeded/);
          assert.equal(error.metadata.processAlive, false);
          return true;
        },
      );
    });
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'codex-dsh-runtime-')));
    await rm(root, { recursive: true, force: true });
  }
});

test('heartbeats report real monitor activity and never fabricate progress', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-dsh-runtime-'));
  try {
    await withFixture(root, 'heartbeat.mjs', HEARTBEAT_MOCK, async (mock) => {
      const updates = [];
      const result = await runDsh('heartbeat', {
        cwd: root,
        runtimeConfig: mockConfig(mock, root, { heartbeatMs: 1000 }),
        onUpdate: (data) => { updates.push(data); },
      });

      assert.equal(result.stdout, 'heartbeat done');
      assert.equal(result.metadata.turnEndKind, 'completed');
      assert.equal(result.metadata.eventCount, 3);

      const idle = updates.filter((update) => update.eventCount === 1);
      assert.ok(idle.length >= 2, `expected heartbeats while the worker was quiet, saw ${idle.length}`);
      assert.equal(
        new Set(idle.map((update) => update.lastActivityAt)).size,
        1,
        'idle heartbeats reuse the real event timestamp instead of fabricating activity',
      );
      for (const update of idle) {
        assert.equal(update.lastPhase, null);
        assert.equal(update.finalReceived, false);
      }
      assert.ok(updates.every((update) => typeof update.lastHeartbeatAt === 'number'));
    });
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'codex-dsh-runtime-')));
    await rm(root, { recursive: true, force: true });
  }
});

test('a spawn failure fails the run instead of being skipped or swallowed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-dsh-runtime-'));
  try {
    // A *valid* prefix arg (the fixture really exists) plus a nonexistent
    // *executable* path: the failure must come from the launch itself (ENOENT),
    // not from the worker starting and exiting non-zero.
    const missing = join(root, 'definitely-not-an-executable');
    await withFixture(root, 'spawn-worker.mjs', ECHO_MOCK, async (mock) => {
      await assert.rejects(
        runDsh('test', { cwd: root, runtimeConfig: mockConfig(mock, root, { executable: missing }) }),
        (error) => {
          assert.ok(
            ['launch_error', 'permission_denied'].includes(error.kind),
            `a spawn failure must reject with a launch kind, got ${error.kind}`,
          );
          assert.match(error.message, /Worker launch failed/);
          assert.equal(error.metadata.processAlive, false);
          return true;
        },
      );
    });
  } finally {
    assert.ok(root.startsWith(join(tmpdir(), 'codex-dsh-runtime-')));
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing runtime config fails with an actionable message (no spawn needed)', async () => {
  await assert.rejects(
    runDsh('test', { cwd: process.cwd(), configPath: join(tmpdir(), 'definitely-missing-bridge.config.json') }),
    /Runtime config not found/,
  );
});