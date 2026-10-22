/**
 * headless-monitor.test.mjs
 *
 * Tests for the dependency-free DSH `--json` JSONL observer.
 * Uses only `node:test` / `node:assert`. No child processes, no timers.
 *
 * Run either way:
 *   node --test headless-monitor.test.mjs
 *   node headless-monitor.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { HeadlessMonitor } from '../src/headless-monitor.mjs';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Serialize events as a JSONL stream (records + trailing newline). */
function jsonl(events) {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

/** Split a string into fixed-size pieces (code-unit based on purpose). */
function chunkize(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** A complete, successful DSH turn. */
function successfulEvents({ answer = 'all done' } = {}) {
  return [
    { type: 'session', sessionId: 'sess-123', cwd: 'C:\\work' },
    { type: 'status', phase: 'turn_start', turn: 1 },
    { type: 'status', phase: 'step_start', turn: 1, step: 1 },
    { type: 'thinking', text: 'internal reasoning that must never leak' },
    { type: 'tool_call', callId: 'c1', tool: 'shell', input: { cmd: 'echo hi' } },
    { type: 'tool_result', callId: 'c1', status: 'completed', result: 'hi' },
    { type: 'text', text: 'partial ' },
    { type: 'text', text: 'answer ' },
    { type: 'final', text: answer },
    { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } },
  ];
}

function pushAll(monitor, chunks) {
  for (const c of chunks) monitor.push(c);
  monitor.flush();
  return monitor;
}

function collect(monitor, options = { exitCode: 0 }) {
  const result = monitor.finish(options);
  // Every result must carry the same safe metadata shape.
  assert.deepEqual(Object.keys(result.metadata).sort(), [
    'eventCount',
    'finalReceived',
    'lastActivityAt',
    'lastPhase',
    'lastTool',
    'sessionId',
    'toolErrorCount',
    'turnEndKind',
  ]);
  return result;
}

// ---------------------------------------------------------------------------
// streaming / fragmentation
// ---------------------------------------------------------------------------

test('fragmented valid stream yields ok with final text and safe metadata', () => {
  const stream = jsonl(successfulEvents({ answer: 'final answer text' }));
  const monitor = pushAll(new HeadlessMonitor(), chunkize(stream, 7));

  const result = collect(monitor);
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'ok');
  assert.equal(result.text, 'final answer text');
  assert.equal(result.metadata.sessionId, 'sess-123');
  assert.equal(result.metadata.lastPhase, 'turn_end');
  assert.equal(result.metadata.turnEndKind, 'completed');
  assert.equal(result.metadata.finalReceived, true);
  assert.equal(result.metadata.toolErrorCount, 0);
  assert.equal(result.metadata.lastTool, 'shell');
  assert.equal(result.metadata.eventCount, 10);
  assert.equal(typeof result.metadata.lastActivityAt, 'number');
});

test('chunks may split surrogate pairs and multi-byte characters', () => {
  const answer = 'héllo 😀 世界 🚀';
  const stream = jsonl(successfulEvents({ answer }));
  const monitor = new HeadlessMonitor();
  // Push one UTF-16 code unit at a time: splits every surrogate pair.
  for (let i = 0; i < stream.length; i += 1) monitor.push(stream[i]);
  monitor.flush();

  const result = collect(monitor);
  assert.equal(result.ok, true);
  assert.equal(result.text, answer);
});

test('Buffer chunks are decoded with a streaming UTF-8 decoder', () => {
  const answer = 'naïve 😀 ✓';
  const stream = jsonl(successfulEvents({ answer }));
  const bytes = Buffer.from(stream, 'utf8');
  const monitor = new HeadlessMonitor();
  // Split byte-by-byte, which cuts multi-byte code points in half.
  for (let i = 0; i < bytes.length; i += 1) monitor.push(bytes.subarray(i, i + 1));
  monitor.flush();

  const result = collect(monitor);
  assert.equal(result.ok, true);
  assert.equal(result.text, answer);
});

test('flush() consumes a final partial line that has no trailing newline', () => {
  const monitor = new HeadlessMonitor();
  monitor.push('{"type":"session","sessionId":"s"}\n');
  monitor.push('{"type":"final","text":"complete answer"}\n');

  // The last record arrives cut in half and never receives a newline.
  const last = '{"type":"status","phase":"turn_end","reason":{"kind":"completed"}}';
  monitor.push(last.slice(0, 20));

  const before = monitor.snapshot();
  assert.equal(before.turnEndKind, null, 'a partial line must not be parsed early');
  assert.equal(before.finalReceived, true, 'complete records before it are parsed');

  monitor.push(last.slice(20)); // no newline anywhere
  monitor.flush();

  const result = collect(monitor, { exitCode: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'complete answer');
  assert.equal(result.metadata.turnEndKind, 'completed');
});

test('empty and blank records are ignored, not errors', () => {
  const monitor = new HeadlessMonitor();
  monitor.push('');
  monitor.push('\n');
  monitor.push('\r\n');
  monitor.push('\n');
  monitor.push('   \n');
  monitor.push(jsonl(successfulEvents()));
  monitor.flush();

  const result = collect(monitor);
  assert.equal(result.ok, true);
  assert.equal(result.metadata.eventCount, 10);
});

test('unknown future event types are ignored but count as activity', () => {
  let clock = 1000;
  const monitor = new HeadlessMonitor({ now: () => clock });
  const events = successfulEvents();
  // splice an unknown event before the final event
  events.splice(8, 0, { type: 'telemetry', value: 42 });
  const stream = jsonl(events);

  const chunks = chunkize(stream, 11);
  for (const chunk of chunks) {
    clock += 1;
    monitor.push(chunk);
  }
  monitor.flush();

  const result = collect(monitor);
  assert.equal(result.ok, true);
  assert.equal(result.metadata.eventCount, 11, 'unknown event counted');
  assert.ok(result.metadata.lastActivityAt >= 1000);
});

// ---------------------------------------------------------------------------
// protocol failures
// ---------------------------------------------------------------------------

test('malformed JSON is a protocol_error and the first failure is retained', () => {
  const monitor = new HeadlessMonitor();
  monitor.push('{"type":"session","sessionId":"s"}\n');
  monitor.push('{not json at all}\n');
  monitor.push('{"also":"broken"\n');
  monitor.push('{"type":"final","text":"nope"}\n');
  monitor.push('{"type":"status","phase":"turn_end","reason":{"kind":"completed"}}\n');
  monitor.flush();

  const result = collect(monitor);
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'protocol_error');
  assert.match(result.message, /not valid JSON/);
  assert.match(result.message, /record 2/, 'first failure retained, not the second');
});

test('non-object JSON records are protocol errors', () => {
  const monitor = new HeadlessMonitor();
  monitor.push('123\n');
  monitor.push('[1,2,3]\n');
  monitor.push('"a string"\n');
  monitor.push('null\n');
  monitor.flush();

  const result = collect(monitor);
  assert.equal(result.kind, 'protocol_error');
  assert.match(result.message, /record 1/);
  assert.equal(result.metadata.eventCount, 0);
});

test('oversized record is a protocol_error and discarded with bounded memory', () => {
  const monitor = new HeadlessMonitor({ maxLineBytes: 256 });
  const huge = 'x'.repeat(5000);
  monitor.push(`{"type":"text","text":"${huge}"}\n`);
  assert.equal(monitor.snapshot().eventCount, 0, 'oversized record never parsed');

  // A valid record after the oversized one must still be observed.
  monitor.push('{"type":"session","sessionId":"after"}\n');
  monitor.push('{"type":"final","text":"recovered"}\n');
  monitor.push('{"type":"status","phase":"turn_end","reason":{"kind":"completed"}}\n');
  monitor.flush();

  const result = collect(monitor);
  assert.equal(result.kind, 'protocol_error');
  assert.match(result.message, /exceeds maxLineBytes/);
  assert.equal(result.metadata.sessionId, 'after');
  assert.equal(result.metadata.finalReceived, true);
  assert.equal(result.metadata.eventCount, 3);
  assert.equal(result.text, 'recovered');
});

test('an oversized unterminated line is dropped without unbounded buffering', () => {
  const monitor = new HeadlessMonitor({ maxLineBytes: 64 });
  // Stream 200 KB of a single line, in small chunks, with no newline at all.
  for (let i = 0; i < 200; i += 1) monitor.push('y'.repeat(1000));
  // The skip state must end at the next newline.
  monitor.push('\n{"type":"session","sessionId":"recovered"}\n');
  monitor.flush();

  const result = collect(monitor);
  assert.equal(result.kind, 'protocol_error');
  assert.equal(result.metadata.sessionId, 'recovered');
});

test('a valid record is still accepted when a later record is malformed', () => {
  const monitor = new HeadlessMonitor();
  monitor.push('{"type":"session","sessionId":"s1"}\n');
  monitor.push('garbage\n');
  monitor.flush();

  const result = collect(monitor, { exitCode: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'protocol_error');
  assert.equal(result.metadata.sessionId, 's1');
});

// ---------------------------------------------------------------------------
// completion semantics
// ---------------------------------------------------------------------------

test('final without turn_end is not success (exit 0 -> interrupted)', () => {
  const monitor = new HeadlessMonitor();
  monitor.push(jsonl(successfulEvents().filter((e) => e.type !== 'status')));
  monitor.flush();

  const result = collect(monitor, { exitCode: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'interrupted');
  assert.equal(result.text, 'all done');
  assert.equal(result.metadata.finalReceived, true);
  assert.equal(result.metadata.turnEndKind, null);
});

test('turn_end completed without a final event is not success', () => {
  const monitor = new HeadlessMonitor();
  const events = successfulEvents().filter((e) => e.type !== 'final');
  monitor.push(jsonl(events));
  monitor.flush();

  const result = collect(monitor, { exitCode: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'no_final');
  assert.equal(result.metadata.finalReceived, false);
});

test('interrupted turn reason is rejected even with exit code 0', () => {
  const monitor = new HeadlessMonitor();
  const events = successfulEvents();
  events[events.length - 1] = {
    type: 'status',
    phase: 'turn_end',
    turn: 1,
    reason: { kind: 'interrupted' },
  };
  monitor.push(jsonl(events));
  monitor.flush();

  const result = collect(monitor, { exitCode: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'interrupted');
  assert.match(result.message, /interrupted/);
});

test('max-tokens turn reason maps to a stable kind', () => {
  const monitor = new HeadlessMonitor();
  const events = successfulEvents();
  events[events.length - 1] = {
    type: 'status',
    phase: 'turn_end',
    turn: 1,
    reason: { kind: 'max-tokens' },
  };
  monitor.push(jsonl(events));
  monitor.flush();

  const result = collect(monitor, { exitCode: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'max_tokens');
});

test('exit 0 with no events at all is interrupted, not success', () => {
  const monitor = new HeadlessMonitor();
  monitor.push('\n');
  monitor.flush();

  const result = collect(monitor, { exitCode: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'interrupted');
  assert.equal(result.text, '');
});

test('non-zero exit code is process_exit', () => {
  const monitor = new HeadlessMonitor();
  // A completed-looking stream cannot rescue a non-zero exit.
  monitor.push(jsonl(successfulEvents()));
  monitor.flush();

  const result = collect(monitor, { exitCode: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'process_exit');
  assert.match(result.message, /code 1/);
});

test('a signal is process_exit and beats a generic exit code', () => {
  const monitor = new HeadlessMonitor();
  monitor.push(jsonl(successfulEvents()));
  monitor.flush();

  const result = collect(monitor, { exitCode: null, signal: 'SIGKILL' });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'process_exit');
  assert.match(result.message, /SIGKILL/);
});

test('abortReason timeout wins over a torn final record', () => {
  const monitor = new HeadlessMonitor();
  // Simulates a kill mid-write: a truncated JSON object, no newline.
  monitor.push('{"type":"text","text":"half a sen');
  monitor.flush();

  const result = collect(monitor, { exitCode: null, abortReason: 'timeout' });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'timeout', 'abort reason is ground truth, not the torn record');
});

test('abortReason cancelled maps to the cancelled kind', () => {
  const monitor = new HeadlessMonitor();
  monitor.push(jsonl(successfulEvents()));
  monitor.flush();

  const result = collect(monitor, { exitCode: null, abortReason: 'cancelled' });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'cancelled');
});

test('an explicit error event is more informative than the exit code', () => {
  const monitor = new HeadlessMonitor();
  monitor.push('{"type":"error","code":"rate_limit","message":"slow down"}\n');
  monitor.flush();

  const result = collect(monitor, { exitCode: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'error');
  assert.match(result.message, /rate_limit/);
  // The upstream error *message* is not surfaced in metadata.
  assert.equal(JSON.stringify(result.metadata).includes('slow down'), false);
});

// ---------------------------------------------------------------------------
// tool errors are distinct from process failures
// ---------------------------------------------------------------------------

test('tool errors alone do not fail a completed turn', () => {
  const monitor = new HeadlessMonitor();
  const events = successfulEvents();
  events.splice(6, 0, {
    type: 'tool_result',
    callId: 'c2',
    status: 'error',
    result: 'permission denied',
  });
  monitor.push(jsonl(events));
  monitor.flush();

  const result = collect(monitor, { exitCode: 0 });
  assert.equal(result.ok, true, 'tool error must not be treated as a process failure');
  assert.equal(result.kind, 'ok');
  assert.equal(result.metadata.toolErrorCount, 1);
});

test('tool errors do not mask a real process failure', () => {
  const monitor = new HeadlessMonitor();
  const events = successfulEvents();
  events.splice(6, 0, { type: 'tool_result', callId: 'c2', status: 'error', result: 'boom' });
  monitor.push(jsonl(events));
  monitor.flush();

  const result = collect(monitor, { exitCode: 3 });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'process_exit');
  assert.equal(result.metadata.toolErrorCount, 1);
});

test('tool errors are never auto-retried or turned into success without a completed turn', () => {
  const monitor = new HeadlessMonitor();
  monitor.push(
    jsonl([
      { type: 'session', sessionId: 's' },
      { type: 'tool_call', callId: 'c1', tool: 'shell', input: { cmd: 'rm -rf /' } },
      { type: 'tool_result', callId: 'c1', status: 'error', result: 'denied' },
    ]),
  );
  monitor.flush();

  const result = collect(monitor, { exitCode: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'interrupted');
  assert.equal(result.metadata.toolErrorCount, 1);
  assert.equal(result.metadata.lastTool, 'shell');
});

// ---------------------------------------------------------------------------
// metadata safety & activity tracking
// ---------------------------------------------------------------------------

test('metadata never exposes tool input, tool result, reasoning or prompts', () => {
  const secrets = {
    input: 'SECRET_TOOL_INPUT_9137',
    result: 'SECRET_TOOL_RESULT_9137',
    thinking: 'SECRET_REASONING_9137',
    prompt: 'SECRET_PROMPT_9137',
  };
  const monitor = new HeadlessMonitor();
  monitor.push(jsonl([
    { type: 'session', sessionId: 'sess-safe', cwd: 'C:\\work' },
    { type: 'status', phase: 'turn_start', turn: 1, prompt: secrets.prompt },
    { type: 'thinking', text: secrets.thinking },
    { type: 'tool_call', callId: 'c1', tool: 'shell', input: { cmd: secrets.input } },
    { type: 'tool_result', callId: 'c1', status: 'error', result: secrets.result },
    { type: 'text', text: 'visible answer' },
    { type: 'final', text: 'visible answer' },
    { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } },
  ]));
  monitor.flush();

  const result = collect(monitor, { exitCode: 0 });
  const serializedSnapshot = JSON.stringify(monitor.snapshot());
  const serializedMetadata = JSON.stringify(result.metadata);

  for (const secret of Object.values(secrets)) {
    assert.equal(serializedSnapshot.includes(secret), false, `snapshot leaked ${secret}`);
    assert.equal(serializedMetadata.includes(secret), false, `metadata leaked ${secret}`);
    assert.equal(result.text.includes(secret), false, `text leaked ${secret}`);
  }
  // The answer itself is available, and only as `text`.
  assert.equal(result.text, 'visible answer');
  assert.deepEqual(Object.keys(monitor.snapshot()).includes('text'), false);
  assert.deepEqual(Object.keys(result.metadata).includes('text'), false);
});

test('lastActivityAt is event driven: no timer, no fake progress', () => {
  let clock = 500;
  const monitor = new HeadlessMonitor({ now: () => clock });

  assert.equal(monitor.snapshot().lastActivityAt, null, 'no activity before any event');

  clock = 800;
  monitor.push('{"type":"session","sessionId":"s"}\n');
  assert.equal(monitor.snapshot().lastActivityAt, 800);

  // Idle time passing without events must not move the timestamp.
  clock = 99999;
  assert.equal(monitor.snapshot().lastActivityAt, 800, 'idle time is not activity');

  // Blank/pending input is not activity either.
  monitor.push('{"type":"final","te');
  assert.equal(monitor.snapshot().lastActivityAt, 800);

  clock = 100000;
  monitor.push('xt":"x"}\n');
  assert.equal(monitor.snapshot().lastActivityAt, 100000);
});

test('snapshot() returns an independent copy', () => {
  const monitor = new HeadlessMonitor();
  monitor.push('{"type":"session","sessionId":"orig"}\n');
  const snap = monitor.snapshot();
  snap.sessionId = 'mutated';
  assert.equal(monitor.snapshot().sessionId, 'orig');
});

test('thinking text never becomes part of the answer text', () => {
  const monitor = new HeadlessMonitor();
  monitor.push(
    jsonl([
      { type: 'thinking', text: 'THINK_ONLY_5511' },
      { type: 'final', text: 'answer' },
      { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } },
    ]),
  );
  monitor.flush();

  const result = collect(monitor, { exitCode: 0 });
  assert.equal(result.text, 'answer');
  assert.equal(result.ok, true);
});

test('streamed text is returned when no final event carries text', () => {
  const monitor = new HeadlessMonitor();
  monitor.push(
    jsonl([
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
      { type: 'final' },
      { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } },
    ]),
  );
  monitor.flush();

  const result = collect(monitor, { exitCode: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'hello world');
});

// ---------------------------------------------------------------------------
// constructor contract
// ---------------------------------------------------------------------------

test('constructor validates options', () => {
  assert.throws(() => new HeadlessMonitor({ maxLineBytes: 0 }), TypeError);
  assert.throws(() => new HeadlessMonitor({ maxLineBytes: -1 }), TypeError);
  assert.throws(() => new HeadlessMonitor({ maxLineBytes: 1.5 }), TypeError);
  assert.throws(() => new HeadlessMonitor({ now: 'not a function' }), TypeError);

  const ok = new HeadlessMonitor({ maxLineBytes: 1 });
  assert.equal(typeof ok.snapshot().eventCount, 'number');
});

test('explicit error is never accepted even with final and completed', () => {
  const monitor = new HeadlessMonitor();
  monitor.push(jsonl([{type:'error',code:'provider_error'},...successfulEvents()]));
  monitor.flush();
  assert.equal(monitor.finish({exitCode:0}).ok,false);
  assert.equal(monitor.finish({exitCode:0}).kind,'error');
});

test('finish() is repeatable and does not mutate state', () => {
  const monitor = new HeadlessMonitor();
  monitor.push(jsonl(successfulEvents()));
  monitor.flush();

  const first = monitor.finish({ exitCode: 0 });
  const second = monitor.finish({ exitCode: 0 });
  assert.deepEqual(first, second);
  assert.notEqual(first.metadata, second.metadata, 'metadata copies are independent');
});
