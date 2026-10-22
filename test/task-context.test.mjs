// task-context.test.mjs — meaningful tests for the reviewed task-context loader.
// Run: node --test task-context.test.mjs
//
// Fixtures live in one dedicated temp root. Cleanup re-verifies that the absolute path it is
// about to delete is still the intended temp root before removing it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, rmdir, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  loadTaskContext,
  TaskContextError,
  MAX_CONTEXT_BYTES,
  MAX_CONTEXT_MESSAGES,
} from '../src/task-context.mjs';

const TEMP_PREFIX = 'task-context-test-';
const TEMP_ROOT = await realpath(await mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX)));
const WORKSPACE = path.join(TEMP_ROOT, 'workspace');
const OUTSIDE = path.join(TEMP_ROOT, 'outside');
await mkdir(WORKSPACE, { recursive: true });
await mkdir(OUTSIDE, { recursive: true });

const makeFile = async (fullPath, content) => {
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
  return realpath(fullPath);
};
const inWorkspace = (relativeName, content) => makeFile(path.join(WORKSPACE, relativeName), content);
const outside = (relativeName, content) => makeFile(path.join(OUTSIDE, relativeName), content);

// Reparse points must be removed with rmdir (unlink fails with EPERM on Windows junctions and
// lstat does not flag them as symlinks), so the links we create are tracked and removed before
// the tree is deleted.
const createdLinks = [];
const makeLink = async (target, linkPath, kind) => {
  await symlink(target, linkPath, kind);
  createdLinks.push(linkPath);
  return linkPath;
};

const sha256Hex = (buffer) => createHash('sha256').update(buffer).digest('hex');

const expectCode = (code, action) =>
  assert.rejects(action, (error) => {
    assert.ok(error instanceof TaskContextError, `expected TaskContextError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
    return true;
  });

// A fixed, independently known digest: catches "hashes a re-serialisation" style mistakes.
const KNOWN_LITERAL = '{"schemaVersion":1,"summary":"ok"}';
const KNOWN_DIGEST = '9899335b7d428a587b410bedafe305848898ac176fd581bfc927232cf9beb337';

const exactSizeContext = (size) => {
  const prefix = '{"schemaVersion":1,"summary":"';
  const suffix = '"}';
  return prefix + 'a'.repeat(size - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)) + suffix;
};

const validContext = (extra = {}) => ({
  schemaVersion: 1,
  summary: 'Reviewed history',
  confirmedFacts: ['uses Node 24'],
  invariants: ['no recursion'],
  acceptanceChecks: ['tests pass'],
  messages: [
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'hi' },
  ],
  provenance: { sourceThreadId: 'thread-1', capturedAt: '2026-10-22T00:00:00Z', truncated: false },
  ...extra,
});

let symlinkSupported = true;
try {
  await makeLink(path.join(TEMP_ROOT, 'symlink-probe-target'), path.join(TEMP_ROOT, 'symlink-probe'), 'file');
} catch {
  symlinkSupported = false;
}

// Windows refuses 'file'/'dir' symlinks without SeCreateSymbolicLinkPrivilege or Developer
// Mode, but junctions are allowed unprivileged and fs.realpath resolves them just the same.
let junctionSupported = true;
try {
  await mkdir(path.join(TEMP_ROOT, 'junction-probe-target'), { recursive: true });
  await makeLink(path.join(TEMP_ROOT, 'junction-probe-target'), path.join(TEMP_ROOT, 'junction-probe'), 'junction');
} catch {
  junctionSupported = false;
}

test.after(async () => {
  // Verify the resolved absolute target is the intended temp root before deleting anything.
  const rootCanonical = await realpath(TEMP_ROOT);
  const tmpCanonical = await realpath(os.tmpdir());
  assert.equal(path.isAbsolute(rootCanonical), true, 'temp root must be absolute');
  assert.ok(
    rootCanonical.startsWith(tmpCanonical + path.sep),
    `temp root ${rootCanonical} must stay under ${tmpCanonical}`,
  );
  assert.ok(
    path.basename(rootCanonical).startsWith(TEMP_PREFIX),
    `temp root ${rootCanonical} must keep the ${TEMP_PREFIX} prefix`,
  );

  // unlink handles POSIX file/directory symlinks; Windows junctions may require rmdir.
  for (const linkPath of createdLinks.reverse()) {
    try { await unlink(linkPath); }
    catch(error) {
      if(error.code==='ENOENT')continue;
      if(!['EPERM','EISDIR','ENOTDIR'].includes(error.code))throw error;
      await rmdir(linkPath);
    }
  }

  await rm(rootCanonical, { recursive: true, force: true });
  await assert.rejects(stat(rootCanonical), (error) => error.code === 'ENOENT');
});

test('returns null when contextPath is undefined or null', async () => {
  assert.equal(await loadTaskContext(undefined, WORKSPACE), null);
  assert.equal(await loadTaskContext(null, WORKSPACE), null);
});

test('loads a valid context with unicode and reports exact hash, bytes and original text', async () => {
  const content = JSON.stringify(validContext({ summary: 'café ✅ 漢字 𝄞 \u00e9' }));
  const file = await inWorkspace('valid-unicode.json', content);

  const result = await loadTaskContext(file, WORKSPACE);
  assert.equal(result.path, file);
  assert.equal(result.text, content, 'text must be the original JSON string');
  assert.equal(result.bytes, Buffer.byteLength(content, 'utf8'));
  assert.equal(result.sha256, sha256Hex(Buffer.from(content, 'utf8')));
  assert.equal(sha256Hex(Buffer.from(result.text, 'utf8')), result.sha256, 'hash covers exactly the content bytes');
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
});

test('hash matches an independently known digest for a fixed literal', async () => {
  const file = await inWorkspace('known.json', KNOWN_LITERAL);
  const result = await loadTaskContext(file, WORKSPACE);
  assert.equal(result.sha256, KNOWN_DIGEST);
  assert.equal(result.bytes, KNOWN_LITERAL.length);
  assert.equal(result.text, KNOWN_LITERAL);
});

test('accepts 60 messages (the documented maximum)', async () => {
  const messages = Array.from({ length: MAX_CONTEXT_MESSAGES }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: `m${i}`,
  }));
  const file = await inWorkspace('max-messages.json', JSON.stringify({ schemaVersion: 1, messages }));
  const result = await loadTaskContext(file, WORKSPACE);
  assert.equal(JSON.parse(result.text).messages.length, MAX_CONTEXT_MESSAGES);
});

test('rejects 61 messages', async () => {
  const messages = Array.from({ length: MAX_CONTEXT_MESSAGES + 1 }, () => ({ role: 'user', text: 'x' }));
  const file = await inWorkspace('too-many-messages.json', JSON.stringify({ schemaVersion: 1, messages }));
  await expectCode('CONTEXT_SCHEMA', () => loadTaskContext(file, WORKSPACE));
});

test('accepts a file of exactly MAX_CONTEXT_BYTES and rejects MAX_CONTEXT_BYTES + 1', async () => {
  const exactContent = exactSizeContext(MAX_CONTEXT_BYTES);
  assert.equal(Buffer.byteLength(exactContent, 'utf8'), MAX_CONTEXT_BYTES, 'boundary fixture must be exact');
  const exactFile = await inWorkspace('exact-size.json', exactContent);
  const result = await loadTaskContext(exactFile, WORKSPACE);
  assert.equal(result.bytes, MAX_CONTEXT_BYTES);

  const overContent = exactSizeContext(MAX_CONTEXT_BYTES + 1);
  assert.equal(Buffer.byteLength(overContent, 'utf8'), MAX_CONTEXT_BYTES + 1);
  const overFile = await inWorkspace('over-size.json', overContent);
  await expectCode('CONTEXT_TOO_LARGE', () => loadTaskContext(overFile, WORKSPACE));
});

test('does not modify the source file', async () => {
  const content = JSON.stringify(validContext());
  const file = await inWorkspace('readonly-source.json', content);
  const before = await stat(file);
  const beforeBytes = await readFile(file);

  await loadTaskContext(file, WORKSPACE);

  const after = await stat(file);
  const afterBytes = await readFile(file);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.deepEqual(afterBytes, beforeBytes);
});

test('returns only the requested file, never a sibling', async () => {
  await inWorkspace('sibling.json', JSON.stringify({ schemaVersion: 1, summary: 'SIBLING-CONTENT' }));
  await inWorkspace('notes.txt', 'SIBLING-CONTENT');
  const target = await inWorkspace('requested.json', JSON.stringify({ schemaVersion: 1, summary: 'TARGET' }));

  const result = await loadTaskContext(target, WORKSPACE);
  assert.equal(result.path, target);
  assert.ok(!result.text.includes('SIBLING-CONTENT'));
});

test('rejects a relative path', async () => {
  await expectCode('CONTEXT_PATH_NOT_ABSOLUTE', () => loadTaskContext('valid-unicode.json', WORKSPACE));
});

test('rejects a non-string contextPath and a non-absolute workspace', async () => {
  await expectCode('CONTEXT_PATH', () => loadTaskContext(42, WORKSPACE));
  const absoluteFile = await inWorkspace('workspace-check.json', KNOWN_LITERAL);
  await expectCode('CONTEXT_WORKSPACE', () => loadTaskContext(absoluteFile, 'relative-root'));
});

test('rejects a path that is not a .json file name', async () => {
  const file = await inWorkspace('plain.txt', KNOWN_LITERAL);
  await expectCode('CONTEXT_PATH_NOT_JSON', () => loadTaskContext(file, WORKSPACE));
});

test('rejects parent traversal segments', async () => {
  await outside('escape.json', KNOWN_LITERAL);
  await inWorkspace('inside.json', KNOWN_LITERAL);

  // Built by string concatenation: path.join would normalise the ".." away.
  const escaping = `${WORKSPACE}${path.sep}..${path.sep}outside${path.sep}escape.json`;
  const stayingInside = `${WORKSPACE}${path.sep}..${path.sep}${path.basename(WORKSPACE)}${path.sep}inside.json`;

  await expectCode('CONTEXT_PATH_TRAVERSAL', () => loadTaskContext(escaping, WORKSPACE));
  await expectCode('CONTEXT_PATH_TRAVERSAL', () => loadTaskContext(stayingInside, WORKSPACE));
  // The same escape via a normalised path is still refused, one layer deeper.
  await expectCode('CONTEXT_OUTSIDE_ROOT', () => loadTaskContext(path.join(WORKSPACE, '..', 'outside', 'escape.json'), WORKSPACE));
});

test('rejects a file outside the workspace root', async () => {
  const file = await outside('outside.json', KNOWN_LITERAL);
  await expectCode('CONTEXT_OUTSIDE_ROOT', () => loadTaskContext(file, WORKSPACE));
});

test('accepts an in-root file whose name merely starts with dots', async () => {
  // '..notes.json' is a legal filename, not a parent reference; the containment check must
  // compare whole path segments rather than a raw '..' prefix.
  const file = await inWorkspace('..notes.json', KNOWN_LITERAL);
  const result = await loadTaskContext(file, WORKSPACE);
  assert.equal(result.path, file);
  assert.equal(result.sha256, KNOWN_DIGEST);
  assert.equal(result.text, KNOWN_LITERAL);
});

test('rejects the workspace root itself', async () => {
  await expectCode('CONTEXT_PATH_NOT_JSON', () => loadTaskContext(WORKSPACE, WORKSPACE));
});

test('rejects a directory named like a .json file', async () => {
  const dir = path.join(WORKSPACE, 'directory.json');
  await mkdir(dir, { recursive: true });
  const canonicalDir = await realpath(dir);
  await expectCode('CONTEXT_NOT_FILE', () => loadTaskContext(canonicalDir, WORKSPACE));
});

test('rejects a missing file', async () => {
  const missing = path.join(WORKSPACE, 'missing.json');
  await expectCode('CONTEXT_NOT_FOUND', () => loadTaskContext(missing, WORKSPACE));
});

test('rejects invalid UTF-8', async () => {
  const content = Buffer.concat([
    Buffer.from('{"schemaVersion":1,"summary":"'),
    Buffer.from([0xc3, 0x28]), // invalid two-byte sequence
    Buffer.from('"}'),
  ]);
  const file = await inWorkspace('invalid-utf8.json', content);
  await expectCode('CONTEXT_ENCODING', () => loadTaskContext(file, WORKSPACE));
});

test('rejects invalid JSON', async () => {
  const file = await inWorkspace('invalid-json.json', '{ "schemaVersion": 1, ');
  await expectCode('CONTEXT_JSON', () => loadTaskContext(file, WORKSPACE));
});

// Regression: intentional error messages must stay content-free. Node 24's JSON.parse message
// can embed a snippet of the offending text, and the role/schemaVersion checks previously
// JSON.stringify'd the rejected value.
test('intentional errors never echo file content or rejected values', async () => {
  const SECRET = 'SECRET-MARKER-7f3a91';

  const capture = async (file) => {
    try {
      await loadTaskContext(file, WORKSPACE);
    } catch (error) {
      assert.ok(error instanceof TaskContextError, `expected TaskContextError, got ${error?.name}`);
      assert.ok(
        !error.message.includes(SECRET),
        `error message leaked secret content (code ${error.code}): ${error.message}`,
      );
      return error.code;
    }
    assert.fail('expected loadTaskContext to reject');
  };

  const invalidJson = `{"schemaVersion":1,"summary":"ok" ${SECRET}}`;
  assert.ok(invalidJson.includes(SECRET), 'fixture must contain the marker');
  const jsonFile = await inWorkspace('secret-invalid-json.json', invalidJson);
  assert.equal(await capture(jsonFile), 'CONTEXT_JSON');

  const badRole = JSON.stringify({ schemaVersion: 1, messages: [{ role: SECRET, text: 'x' }] });
  assert.ok(badRole.includes(SECRET));
  assert.equal(await capture(await inWorkspace('secret-bad-role.json', badRole)), 'CONTEXT_ROLE');

  const badVersion = JSON.stringify({ schemaVersion: SECRET, summary: 'x' });
  assert.ok(badVersion.includes(SECRET));
  assert.equal(await capture(await inWorkspace('secret-bad-version.json', badVersion)), 'CONTEXT_SCHEMA');

  // Unknown field names are also refused without being echoed back.
  const badField = JSON.stringify({ schemaVersion: 1, summary: 'x', [SECRET]: true });
  assert.ok(badField.includes(SECRET));
  assert.equal(await capture(await inWorkspace('secret-bad-field.json', badField)), 'CONTEXT_SCHEMA');
});

test('rejects a UTF-8 BOM-prefixed document (fail-closed, so bytes and text stay identical)', async () => {
  // The decoder keeps the BOM, so JSON.parse sees U+FEFF and the file is refused as invalid
  // JSON. Pinned deliberately: this keeps `sha256` a digest of exactly the bytes on disk.
  const file = await inWorkspace('bom.json', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(KNOWN_LITERAL)]));
  await expectCode('CONTEXT_JSON', () => loadTaskContext(file, WORKSPACE));
});

test('rejects a raw multi-line Codex JSONL log', async () => {
  const log = [
    JSON.stringify({ type: 'session_meta', timestamp: '2026-10-22T00:00:00Z', payload: { id: 'x' } }),
    JSON.stringify({ type: 'response_item', timestamp: '2026-10-22T00:00:01Z', payload: { text: 'hi' } }),
  ].join('\n');
  const file = await inWorkspace('raw-log.jsonl.json', log);
  await expectCode('CONTEXT_RAW_LOG', () => loadTaskContext(file, WORKSPACE));
});

test('rejects a single JSONL log-event object', async () => {
  const event = JSON.stringify({ type: 'event_msg', timestamp: '2026-10-22T00:00:00Z', payload: {} });
  const file = await inWorkspace('single-log-event.json', event);
  await expectCode('CONTEXT_RAW_LOG', () => loadTaskContext(file, WORKSPACE));
});

test('rejects unknown top-level fields', async () => {
  const file = await inWorkspace('unknown-top.json', JSON.stringify(validContext({ notes: 'nope' })));
  await expectCode('CONTEXT_SCHEMA', () => loadTaskContext(file, WORKSPACE));
});

test('rejects a missing or non-exactly-1 schemaVersion', async () => {
  const missing = await inWorkspace('no-schema.json', JSON.stringify({ summary: 'x' }));
  await expectCode('CONTEXT_SCHEMA', () => loadTaskContext(missing, WORKSPACE));

  for (const badVersion of [0, 2, '1', 1.5, true, null]) {
    const file = await inWorkspace(`bad-version-${String(badVersion)}.json`, JSON.stringify({ schemaVersion: badVersion, summary: 'x' }));
    await expectCode('CONTEXT_SCHEMA', () => loadTaskContext(file, WORKSPACE));
  }
});

test('rejects system, developer, analysis and tool roles', async () => {
  for (const role of ['system', 'developer', 'analysis', 'tool']) {
    const content = JSON.stringify({ schemaVersion: 1, messages: [{ role, text: 'x' }] });
    const file = await inWorkspace(`role-${role}.json`, content);
    await expectCode('CONTEXT_ROLE', () => loadTaskContext(file, WORKSPACE));
  }
});

test('rejects malformed message objects', async () => {
  const cases = {
    'message-extra-field.json': { schemaVersion: 1, messages: [{ role: 'user', text: 'x', id: 1 }] },
    'message-missing-text.json': { schemaVersion: 1, messages: [{ role: 'user' }] },
    'message-missing-role.json': { schemaVersion: 1, messages: [{ text: 'x' }] },
    'message-not-object.json': { schemaVersion: 1, messages: ['user'] },
    'message-text-not-string.json': { schemaVersion: 1, messages: [{ role: 'user', text: 3 }] },
    'messages-not-array.json': { schemaVersion: 1, messages: { role: 'user', text: 'x' } },
  };
  for (const [name, value] of Object.entries(cases)) {
    const file = await inWorkspace(name, JSON.stringify(value));
    await expectCode('CONTEXT_SCHEMA', () => loadTaskContext(file, WORKSPACE));
  }
});

test('rejects wrong types for summary, content arrays and provenance', async () => {
  const cases = {
    'summary-not-string.json': { schemaVersion: 1, summary: 5 },
    'facts-not-array.json': { schemaVersion: 1, confirmedFacts: 'one' },
    'facts-item-not-string.json': { schemaVersion: 1, invariants: ['ok', 7] },
    'checks-item-null.json': { schemaVersion: 1, acceptanceChecks: [null] },
    'provenance-not-object.json': { schemaVersion: 1, summary: 'x', provenance: 'thread-1' },
    'provenance-unknown-field.json': { schemaVersion: 1, summary: 'x', provenance: { model: 'm' } },
    'provenance-bad-truncated.json': { schemaVersion: 1, summary: 'x', provenance: { truncated: 'yes' } },
    'provenance-bad-capturedAt.json': { schemaVersion: 1, summary: 'x', provenance: { capturedAt: 5 } },
  };
  for (const [name, value] of Object.entries(cases)) {
    const file = await inWorkspace(name, JSON.stringify(value));
    await expectCode('CONTEXT_SCHEMA', () => loadTaskContext(file, WORKSPACE));
  }
});

test('rejects contexts with no nonempty content', async () => {
  const cases = {
    'empty-content.json': { schemaVersion: 1 },
    'whitespace-content.json': { schemaVersion: 1, summary: '   ' },
    'empty-arrays.json': { schemaVersion: 1, confirmedFacts: [], invariants: [' '], acceptanceChecks: [] },
    'empty-message-text.json': { schemaVersion: 1, messages: [{ role: 'user', text: '' }] },
  };
  for (const [name, value] of Object.entries(cases)) {
    const file = await inWorkspace(name, JSON.stringify(value));
    await expectCode('CONTEXT_SCHEMA', () => loadTaskContext(file, WORKSPACE));
  }
});

test('rejects a top-level array or scalar document', async () => {
  const arrayFile = await inWorkspace('top-array.json', '[{"schemaVersion":1,"summary":"x"}]');
  await expectCode('CONTEXT_SCHEMA', () => loadTaskContext(arrayFile, WORKSPACE));
  const scalarFile = await inWorkspace('top-scalar.json', 'true');
  await expectCode('CONTEXT_SCHEMA', () => loadTaskContext(scalarFile, WORKSPACE));
});

test('refuses a reparse-point escape and accepts an in-root link', async (t) => {
  if (!symlinkSupported && !junctionSupported) {
    if(process.env.DSH_BRIDGE_REQUIRE_SPAWN_TESTS==='1')assert.fail('Strict tests require the link-escape check; no symlink/junction support available');
    t.diagnostic('no symlink/junction creation available; link-escape coverage not exercised');
    return t.skip('creating links is not permitted in this environment');
  }
  await outside('reparse-escape.json', KNOWN_LITERAL);

  // Escape case: a link inside the workspace that resolves outside it must be refused even
  // though its own name ends in .json and the file exists.
  if (junctionSupported) {
    const junction = await makeLink(OUTSIDE, path.join(WORKSPACE, 'junction-escape'), 'junction');
    await expectCode('CONTEXT_OUTSIDE_ROOT', () =>
      loadTaskContext(path.join(junction, 'reparse-escape.json'), WORKSPACE));
  } else {
    const escapeLink = await makeLink(
      path.join(OUTSIDE, 'reparse-escape.json'),
      path.join(WORKSPACE, 'symlink-escape.json'),
      'file',
    );
    await expectCode('CONTEXT_OUTSIDE_ROOT', () => loadTaskContext(escapeLink, WORKSPACE));
  }

  // Positive case: a link whose realpath stays inside the workspace is accepted, and the
  // returned path is the canonical target rather than the link the caller used.
  const nested = await inWorkspace(path.join('nested', 'nested.json'), KNOWN_LITERAL);
  const nestedLink = await makeLink(
    path.join(WORKSPACE, 'nested'),
    path.join(WORKSPACE, 'nested-link'),
    junctionSupported ? 'junction' : 'dir',
  );
  const viaLink = await loadTaskContext(path.join(nestedLink, 'nested.json'), WORKSPACE);
  assert.equal(viaLink.path, nested);
  assert.equal(viaLink.sha256, KNOWN_DIGEST);

  if (!symlinkSupported) {
    t.diagnostic('file symlinks unavailable; cross-extension link case not exercised');
    return;
  }
  const wrongExtTarget = await inWorkspace('not-json-target.txt', KNOWN_LITERAL);
  const wrongExtLink = await makeLink(wrongExtTarget, path.join(WORKSPACE, 'linked.json'), 'file');
  await expectCode('CONTEXT_PATH_NOT_JSON', () => loadTaskContext(wrongExtLink, WORKSPACE));
});
