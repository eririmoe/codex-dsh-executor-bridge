/**
 * context-export.test.mjs — synthetic-fixture tests for the rollout conversation exporter.
 * Run with: node --test context-export.test.mjs
 *
 * All fixtures are synthetic and written to a per-test temp directory; no real Codex
 * session data, credentials or user files are used or read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep, basename } from 'node:path';

import { exportConversation } from '../src/context-export.mjs';

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 98304;

/** Create an isolated fixture file and register cleanup. */
async function fixture(t, records, { raw = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ctx-export-'));
  t.after(async () => {
    const canonical=await realpath(dir),base=await realpath(tmpdir());
    assert.ok(canonical.startsWith(base+sep)&&basename(canonical).startsWith('ctx-export-'));
    await rm(canonical,{recursive:true,force:true});
  });
  const sourcePath = join(dir, 'rollout.jsonl');
  const body = raw ?? records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  await writeFile(sourcePath, body, 'utf8');
  return { dir, sourcePath, dirPath: dir };
}

const sessionMeta = (id) => ({
  timestamp: '2026-10-22T00:00:00.000Z',
  type: 'session_meta',
  payload: {
    id,
    // Raw metadata that must never reach the export.
    cwd: 'C:\\secret\\project',
    cli_version: '9.9.9',
    originator: 'codex_cli',
  },
});

const messageRecord = (role, text, extra = {}) => ({
  timestamp: '2026-10-22T00:00:00.000Z',
  type: 'response_item',
  payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }], ...extra },
});

test('exports only user/assistant visible text and leaks no other record kind', async (t) => {
  const { sourcePath } = await fixture(t, [
    sessionMeta('thread-abc-123'),
    messageRecord('user', 'hello from the user'),
    messageRecord('assistant', 'answer from the assistant'),
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'DEV-LEAK' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'system', content: [{ type: 'text', text: 'SYS-LEAK' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'tool', content: [{ type: 'text', text: 'TOOLROLE-LEAK' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'ANALYSIS-LEAK' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', channel: 'summary', content: [{ type: 'output_text', text: 'SUMMARY-LEAK' }] } },
    { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'REASONING-LEAK' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"TOOLCALL-LEAK"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'TOOLOUTPUT-LEAK' } },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'assistant with an image' },
          { type: 'input_image', image_url: 'data:image/png;base64,IMAGE-LEAK' },
        ],
      },
    },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'output_text', text: 'MISMATCHED-LEAK' }] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'EVENT-LEAK' } },
    { type: 'turn_context', payload: { model: 'gpt-x', summary: 'TURNCTX-LEAK' } },
  ]);

  const result = await exportConversation(sourcePath, { now: () => '2026-10-22T12:00:00.000Z' });

  assert.deepEqual(result.messages, [
    { role: 'user', text: 'hello from the user' },
    { role: 'assistant', text: 'answer from the assistant' },
    { role: 'assistant', text: 'assistant with an image' },
  ]);
  assert.equal(result.provenance.sourceThreadId, 'thread-abc-123');
  assert.equal(result.provenance.truncated, false);
  const serialized = JSON.stringify(result);
  for (const marker of ['LEAK', 'C:\\secret\\project', 'codex_cli', 'gpt-x', '9.9.9']) {
    assert.ok(!serialized.includes(marker), `export must not contain ${marker}`);
  }
});

test('returns the exact top-level schema with empty fact fields and injected capturedAt', async (t) => {
  const { sourcePath } = await fixture(t, [sessionMeta('thread-schema'), messageRecord('user', 'only turn')]);
  const result = await exportConversation(sourcePath, { now: () => 'fixed-timestamp' });

  assert.deepEqual(Object.keys(result), [
    'schemaVersion',
    'summary',
    'confirmedFacts',
    'invariants',
    'acceptanceChecks',
    'messages',
    'provenance',
  ]);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.summary, '');
  assert.deepEqual(result.confirmedFacts, []);
  assert.deepEqual(result.invariants, []);
  assert.deepEqual(result.acceptanceChecks, []);
  assert.deepEqual(Object.keys(result.provenance), ['sourceThreadId', 'capturedAt', 'truncated']);
  assert.equal(result.provenance.capturedAt, 'fixed-timestamp');
  assert.equal(result.provenance.truncated, false);
  assert.ok(result.messages.every((message) => message.role === 'user' || message.role === 'assistant'));
  assert.ok(result.messages.every((message) => typeof message.text === 'string'));
});

test('omits sourceThreadId when no session_meta provenance is present', async (t) => {
  const { sourcePath } = await fixture(t, [messageRecord('user', 'no metadata here')]);
  const result = await exportConversation(sourcePath);
  assert.ok(!('sourceThreadId' in result.provenance));
  assert.deepEqual(Object.keys(result.provenance), ['capturedAt', 'truncated']);
});

test('keeps only the most recent maxMessages and flags truncation', async (t) => {
  const records = [sessionMeta('thread-recent')];
  for (let index = 1; index <= 6; index += 1) records.push(messageRecord('user', `turn ${index}`));
  const { sourcePath } = await fixture(t, records);

  const result = await exportConversation(sourcePath, { maxMessages: 2, maxTextBytes: 48000 });
  assert.deepEqual(result.messages, [
    { role: 'user', text: 'turn 5' },
    { role: 'user', text: 'turn 6' },
  ]);
  assert.equal(result.provenance.truncated, true);
});

test('preserves unicode and keeps the total UTF-8 text budget', async (t) => {
  const emoji = '🚀'.repeat(4);
  const { sourcePath } = await fixture(t, [
    messageRecord('user', `héllo ünïcode 中文 ${emoji}`),
    messageRecord('assistant', `ответ 😀 ${emoji}`),
  ]);

  const result = await exportConversation(sourcePath, { now: () => 't' });
  assert.equal(result.messages[0].text, `héllo ünïcode 中文 ${emoji}`);
  assert.equal(result.messages[1].text, `ответ 😀 ${emoji}`);
  assert.equal(result.provenance.truncated, false);

  const capped = await exportConversation(sourcePath, { maxTextBytes: 30, now: () => 't' });
  assert.ok(capped.messages.length >= 1);
  const totalBytes = capped.messages.reduce((sum, message) => sum + Buffer.byteLength(message.text, 'utf8'), 0);
  assert.ok(totalBytes <= 30, `expected <= 30 UTF-8 bytes, got ${totalBytes}`);
  // Trimming must not corrupt the retained characters.
  assert.ok(!capped.messages.some((message) => message.text.includes('\uFFFD')));
  assert.equal(capped.provenance.truncated, true);
});

test('tolerates one torn final record but fails malformed complete records safely', async (t) => {
  const torn = await fixture(t, null, {
    raw:
      JSON.stringify(sessionMeta('thread-torn')) +
      '\n' +
      JSON.stringify(messageRecord('user', 'complete turn')) +
      '\n' +
      '{"type":"response_item","payload":{"type":"message","role":"assist',
  });
  const tornResult = await exportConversation(torn.sourcePath, { now: () => 't' });
  assert.deepEqual(tornResult.messages, [{ role: 'user', text: 'complete turn' }]);
  assert.equal(tornResult.provenance.truncated, true);
  assert.equal(tornResult.provenance.sourceThreadId, 'thread-torn');

  const malformed = await fixture(t, null, {
    raw: JSON.stringify(messageRecord('user', 'good line')) + '\nnot-json-at-all-secret-token\n',
  });
  await assert.rejects(
    () => exportConversation(malformed.sourcePath, { now: () => 't' }),
    (error) => {
      assert.match(error.message, /malformed JSONL record at line 2/);
      assert.ok(!error.message.includes('not-json-at-all-secret-token'), 'error must not echo content');
      return true;
    },
  );
});

test('redacts recognizable credential shapes without promising completeness', async (t) => {
  const secrets = {
    openai: 'sk-' + 'a'.repeat(32),
    githubClassic: 'ghp_' + 'b'.repeat(24),
    githubFineGrained: 'github_pat_' + 'c'.repeat(32),
    bearer: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
    apiKey: 'api_key = "abcdef123456"',
    password: 'password=hunter2secret',
    secret: 'client_secret: super-secret-value',
  };
  const { sourcePath } = await fixture(t, [
    messageRecord('user', `use ${secrets.openai} and ${secrets.githubClassic}`),
    messageRecord('assistant', `token ${secrets.githubFineGrained}\nAuthorization: ${secrets.bearer}`),
    messageRecord('user', `${secrets.apiKey}\n${secrets.password}\n${secrets.secret}`),
  ]);

  const result = await exportConversation(sourcePath, { now: () => 't' });
  const serialized = JSON.stringify(result);
  for (const [name, value] of Object.entries(secrets)) {
    const core = value.replace(/^(Bearer\s+|api_key = "|password=|client_secret: )/, '').replace(/"$/, '');
    assert.ok(!serialized.includes(core), `${name} value must be redacted`);
  }
  assert.ok(serialized.includes('[REDACTED]'));
  assert.ok(result.messages[0].text.includes('[REDACTED]'));
});

test('omits injected wrapper messages while keeping real turns', async (t) => {
  const { sourcePath } = await fixture(t, [
    messageRecord('user', '# AGENTS.md instructions for C:\\repo\n\n<INSTRUCTIONS-LEAK>'),
    messageRecord('user', '<environment_context>\n  <cwd>C:\\repo</cwd>\n</environment_context>'),
    messageRecord('user', '<external_codex_apps_open_page>{"page":"x"}</external_codex_apps_open_page>'),
    messageRecord('user', 'a genuine question'),
    messageRecord('assistant', 'a genuine answer'),
  ]);

  const result = await exportConversation(sourcePath, { now: () => 't' });
  assert.deepEqual(result.messages, [
    { role: 'user', text: 'a genuine question' },
    { role: 'assistant', text: 'a genuine answer' },
  ]);
  assert.ok(!JSON.stringify(result).includes('LEAK'));
});

test('skips records longer than the 1 MiB line bound and flags truncation', async (t) => {
  const oversized = JSON.stringify(messageRecord('assistant', 'A'.repeat(MAX_LINE_BYTES + 4096)));
  assert.ok(Buffer.byteLength(oversized, 'utf8') > MAX_LINE_BYTES);
  const { sourcePath } = await fixture(t, null, {
    raw:
      JSON.stringify(sessionMeta('thread-big')) +
      '\n' +
      JSON.stringify(messageRecord('user', 'before oversized')) +
      '\n' +
      oversized +
      '\n' +
      JSON.stringify(messageRecord('assistant', 'after oversized')) +
      '\n',
  });

  const result = await exportConversation(sourcePath, { now: () => 't', maxTextBytes: 100000 });
  assert.deepEqual(result.messages, [
    { role: 'user', text: 'before oversized' },
    { role: 'assistant', text: 'after oversized' },
  ]);
  assert.equal(result.provenance.truncated, true);
});

test('never reads referenced attachment files and never exports the source path', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ctx-export-attach-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const secretPath = join(dir, 'attached-secret.txt');
  await writeFile(secretPath, 'ATTACHMENT-FILE-SECRET-CONTENT\n', 'utf8');
  const sourcePath = join(dir, 'rollout.jsonl');
  await writeFile(
    sourcePath,
    [
      JSON.stringify(sessionMeta('thread-attachment')),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'see the attached file for details' }],
          attachments: [{ path: secretPath }],
        },
      }),
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'c1', output: `cat ${secretPath}` },
      }),
    ].join('\n') + '\n',
    'utf8',
  );

  const result = await exportConversation(sourcePath, { now: () => 't' });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('ATTACHMENT-FILE-SECRET-CONTENT'), false);
  assert.equal(serialized.includes(secretPath), false);
  assert.equal(serialized.includes(sourcePath), false);
  assert.deepEqual(result.messages, [{ role: 'user', text: 'see the attached file for details' }]);
});

test('bounds the serialized JSON to 98304 UTF-8 bytes by dropping oldest messages', async (t) => {
  const block = 'x'.repeat(60000);
  const records = [sessionMeta('thread-json-cap')];
  for (let index = 1; index <= 6; index += 1) records.push(messageRecord('user', `#${index} ${block}`));
  const { sourcePath } = await fixture(t, records);

  const result = await exportConversation(sourcePath, { maxMessages: 40, maxTextBytes: 400000, now: () => 't' });
  const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  assert.ok(bytes <= MAX_JSON_BYTES, `expected <= ${MAX_JSON_BYTES} bytes, got ${bytes}`);
  assert.ok(result.messages.length >= 1, 'must never silently return zero messages');
  assert.equal(result.provenance.truncated, true);
  assert.equal(result.messages.at(-1).text.startsWith('#6 '), true, 'keeps the most recent message');
});

test('trims a single oversized message to the text budget, keeping one message', async (t) => {
  const { sourcePath } = await fixture(t, [messageRecord('user', 'y'.repeat(5000))]);
  const result = await exportConversation(sourcePath, { maxTextBytes: 100, now: () => 't' });
  assert.equal(result.messages.length, 1);
  assert.ok(Buffer.byteLength(result.messages[0].text, 'utf8') <= 100);
  assert.equal(result.provenance.truncated, true);
});

test('throws a concise safe error when no user-visible messages exist', async (t) => {
  const empty = await fixture(t, [sessionMeta('thread-empty'), { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'DEV-LEAK' }] } }]);
  await assert.rejects(
    () => exportConversation(empty.sourcePath, { now: () => 't' }),
    (error) => {
      assert.match(error.message, /no exportable user or assistant messages/);
      assert.ok(!error.message.includes('DEV-LEAK'));
      assert.ok(!error.message.includes(empty.dirPath), 'error must not echo the source path');
      return true;
    },
  );

  const emptyFile = await fixture(t, null, { raw: '' });
  await assert.rejects(() => exportConversation(emptyFile.sourcePath, { now: () => 't' }), /no exportable user or assistant messages/);
});

test('fails safely for unreadable sources and invalid options without echoing paths', async (t) => {
  const { dir } = await fixture(t, [messageRecord('user', 'x')]);
  await assert.rejects(
    () => exportConversation(join(dir, 'missing.jsonl'), { now: () => 't' }),
    (error) => {
      assert.match(error.message, /failed to read source \(ENOENT\)/);
      assert.ok(!error.message.includes(dir), 'error must not echo the source path');
      return true;
    },
  );

  const { sourcePath } = await fixture(t, [messageRecord('user', 'x')]);
  await assert.rejects(() => exportConversation(sourcePath, { maxMessages: 0 }), /maxMessages must be a positive integer/);
  await assert.rejects(() => exportConversation(sourcePath, { maxTextBytes: -1 }), /maxTextBytes must be a positive integer/);
  await assert.rejects(() => exportConversation(''), /sourcePath must be a non-empty string/);
});

test('ignores blank padding lines and CRLF line endings', async (t) => {
  const { sourcePath } = await fixture(t, null, {
    raw:
      JSON.stringify(sessionMeta('thread-crlf')) +
      '\r\n\r\n' +
      JSON.stringify(messageRecord('user', 'crlf turn')) +
      '\r\n' +
      '\n',
  });
  const result = await exportConversation(sourcePath, { now: () => 't' });
  assert.deepEqual(result.messages, [{ role: 'user', text: 'crlf turn' }]);
  assert.equal(result.provenance.truncated, false);
});

test('handles a large number of streaming lines without exceeding budgets', async (t) => {
  const records = [sessionMeta('thread-stream')];
  for (let index = 1; index <= 200; index += 1) records.push(messageRecord(index % 2 ? 'user' : 'assistant', `line ${index}`));
  const { sourcePath } = await fixture(t, records);

  const result = await exportConversation(sourcePath, { now: () => 't' });
  assert.equal(result.messages.length, 40);
  assert.equal(result.messages[0].text, 'line 161');
  assert.equal(result.messages.at(-1).text, 'line 200');
  assert.equal(result.provenance.truncated, true);
});

test('keeps visible commentary/final/final_answer surfaces and fails closed on analysis/unknown', async (t) => {
  const { sourcePath } = await fixture(t, [
    // Known visible surfaces on either payload field must be retained.
    messageRecord('assistant', 'visible commentary', { phase: 'commentary' }),
    messageRecord('assistant', 'visible final answer', { phase: 'final_answer' }),
    messageRecord('assistant', 'visible final channel', { channel: 'final' }),
    // Absent/null/empty surfaces are not themselves disqualifying.
    messageRecord('assistant', 'visible null surface', { channel: null, phase: null }),
    messageRecord('assistant', 'visible empty surface', { phase: '' }),
    // Known internal surfaces are excluded even when only one field is present.
    messageRecord('assistant', 'PHASE-ANALYSIS-LEAK', { phase: 'analysis' }),
    messageRecord('assistant', 'PHASE-SUMMARY-LEAK', { phase: 'summary' }),
    messageRecord('assistant', 'CHANNEL-REASONING-LEAK', { channel: 'reasoning' }),
    messageRecord('assistant', 'PHASE-INTERNAL-LEAK', { phase: 'internal' }),
    messageRecord('assistant', 'CHANNEL-HIDDEN-LEAK', { channel: 'hidden' }),
    // Unknown non-empty surfaces fail closed regardless of the other field.
    messageRecord('assistant', 'PHASE-UNKNOWN-LEAK', { phase: 'side_channel' }),
    messageRecord('assistant', 'CHANNEL-UNKNOWN-LEAK', { channel: 'widget' }),
    // A visible field must not rescue an unknown sibling field.
    messageRecord('assistant', 'MIXED-UNKNOWN-LEAK', { channel: 'commentary', phase: 'analysis' }),
  ]);

  const result = await exportConversation(sourcePath, { now: () => 't' });
  assert.deepEqual(result.messages.map((message) => message.text), [
    'visible commentary',
    'visible final answer',
    'visible final channel',
    'visible null surface',
    'visible empty surface',
  ]);
  assert.ok(!JSON.stringify(result).includes('LEAK'));
});

test('trusts only explicit input_text/output_text containers, never generic text', async (t) => {
  const { sourcePath } = await fixture(t, [
    messageRecord('user', 'genuine user'),
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'GENERIC-ASSISTANT-LEAK' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'GENERIC-USER-LEAK' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'real answer' }] } },
  ]);

  const result = await exportConversation(sourcePath, { now: () => 't' });
  assert.deepEqual(result.messages, [
    { role: 'user', text: 'genuine user' },
    { role: 'assistant', text: 'real answer' },
  ]);
  assert.ok(!JSON.stringify(result).includes('LEAK'));
});

test('enforces rolling maxMessages/maxTextBytes while collecting a long stream', async (t) => {
  const records = [sessionMeta('thread-rolling')];
  for (let index = 1; index <= 500; index += 1) {
    const role = index % 2 ? 'user' : 'assistant';
    records.push(messageRecord(role, `msg ${index}`, role === 'assistant' ? { phase: 'commentary' } : {}));
  }
  const { sourcePath } = await fixture(t, records);

  // Small byte budget: the retained window must stay bounded and be the newest suffix.
  const byteCapped = await exportConversation(sourcePath, { maxMessages: 6, maxTextBytes: 40, now: () => 't' });
  assert.ok(byteCapped.messages.length >= 1 && byteCapped.messages.length <= 6, `bounded count, got ${byteCapped.messages.length}`);
  const totalBytes = byteCapped.messages.reduce((sum, message) => sum + Buffer.byteLength(message.text, 'utf8'), 0);
  assert.ok(totalBytes <= 40, `expected <= 40 UTF-8 bytes, got ${totalBytes}`);
  const indexes = byteCapped.messages.map((message) => Number(message.text.split(' ')[1]));
  assert.equal(indexes.at(-1), 500, 'newest message must be retained');
  for (let i = 1; i < indexes.length; i += 1) assert.equal(indexes[i], indexes[i - 1] + 1, 'retained window must be contiguous');
  assert.ok(indexes.length < 500, 'older messages must roll off during collection');
  assert.equal(byteCapped.provenance.truncated, true);

  // Message cap alone must keep exactly the newest messages.
  const messageCapped = await exportConversation(sourcePath, { maxMessages: 3, maxTextBytes: 100000, now: () => 't' });
  assert.deepEqual(messageCapped.messages.map((message) => message.text), ['msg 498', 'msg 499', 'msg 500']);
  assert.equal(messageCapped.provenance.truncated, true);

  // Observability caveat: these assertions bound the exported window and recency. They do
  // not measure peak heap, so this test does not by itself prove total-memory usage.
});
