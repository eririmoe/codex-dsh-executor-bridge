// task-context.mjs — dependency-free Node ESM loader for a single, reviewed task-context file.
//
// SECURITY MODEL
//   The JSON this module returns is REVIEWED HISTORY DATA, never new authority. It is data a
//   caller may render for a human or an operator; it must not be treated as instructions,
//   policy, or tool authorisation. This module reads exactly one file — the one named by the
//   caller — and never reads other files, credentials, environment secrets, or auto-discovers
//   sessions/threads. Callers must not widen that contract.
//
//   Accepted input is a single absolute path to a regular `.json` file whose realpath is
//   contained in realpath(workspace). Parent traversal, symlink escapes, directories, oversized
//   files, invalid UTF-8, invalid JSON and raw Codex JSONL logs are all refused.

import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/** Maximum accepted file size in bytes; anything larger is refused. */
export const MAX_CONTEXT_BYTES = 98304;

/** Maximum accepted number of messages. */
export const MAX_CONTEXT_MESSAGES = 60;

const TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'summary',
  'confirmedFacts',
  'invariants',
  'acceptanceChecks',
  'messages',
  'provenance',
]);

const MESSAGE_KEYS = new Set(['role', 'text']);
const MESSAGE_ROLES = new Set(['user', 'assistant']);
const PROVENANCE_KEYS = new Set(['sourceThreadId', 'capturedAt', 'truncated']);
const CONTENT_ARRAY_KEYS = ['confirmedFacts', 'invariants', 'acceptanceChecks'];

/** Error thrown for every refused input. `code` is stable and machine-checkable. */
export class TaskContextError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TaskContextError';
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new TaskContextError(code, message);
};

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

/** True when the text looks like a multi-record JSONL log rather than one JSON document. */
function looksLikeJsonl(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return false;
    try {
      if (!isPlainObject(JSON.parse(trimmed))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** True for a single log-event object such as a Codex JSONL record. */
function looksLikeLogEvent(value) {
  return isPlainObject(value) && typeof value.type === 'string' &&
    ('payload' in value || 'timestamp' in value);
}

function validateStringArray(value, key) {
  if (!Array.isArray(value)) fail('CONTEXT_SCHEMA', `"${key}" must be an array of strings`);
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string') {
      fail('CONTEXT_SCHEMA', `"${key}[${index}]" must be a string`);
    }
  }
}

function validateMessages(value) {
  if (!Array.isArray(value)) fail('CONTEXT_SCHEMA', '"messages" must be an array');
  if (value.length > MAX_CONTEXT_MESSAGES) {
    fail('CONTEXT_SCHEMA', `"messages" may hold at most ${MAX_CONTEXT_MESSAGES} entries`);
  }
  for (const [index, message] of value.entries()) {
    if (!isPlainObject(message)) fail('CONTEXT_SCHEMA', `"messages[${index}]" must be an object`);
    for (const key of Object.keys(message)) {
      if (!MESSAGE_KEYS.has(key)) {
        // Deliberately content-free: never echo the rejected field name.
        fail('CONTEXT_SCHEMA', `"messages[${index}]" has an unknown field`);
      }
    }
    if (!('role' in message) || !('text' in message)) {
      fail('CONTEXT_SCHEMA', `"messages[${index}]" must have exactly "role" and "text"`);
    }
    if (typeof message.role !== 'string' || !MESSAGE_ROLES.has(message.role)) {
      fail('CONTEXT_ROLE', `"messages[${index}].role" must be "user" or "assistant"`);
    }
    if (typeof message.text !== 'string') {
      fail('CONTEXT_SCHEMA', `"messages[${index}].text" must be a string`);
    }
  }
}

function validateProvenance(value) {
  if (!isPlainObject(value)) fail('CONTEXT_SCHEMA', '"provenance" must be an object');
  for (const key of Object.keys(value)) {
    if (!PROVENANCE_KEYS.has(key)) {
      fail('CONTEXT_SCHEMA', '"provenance" has an unknown field');
    }
  }
  if ('sourceThreadId' in value && typeof value.sourceThreadId !== 'string') {
    fail('CONTEXT_SCHEMA', '"provenance.sourceThreadId" must be a string');
  }
  if ('capturedAt' in value && typeof value.capturedAt !== 'string') {
    fail('CONTEXT_SCHEMA', '"provenance.capturedAt" must be a string');
  }
  if ('truncated' in value && typeof value.truncated !== 'boolean') {
    fail('CONTEXT_SCHEMA', '"provenance.truncated" must be a boolean');
  }
}

/** Strict schema check; throws TaskContextError on any deviation. */
function validateSchema(value) {
  if (!isPlainObject(value)) fail('CONTEXT_SCHEMA', 'context must be a single JSON object');

  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_KEYS.has(key)) fail('CONTEXT_SCHEMA', 'unknown top-level field');
  }

  if (!('schemaVersion' in value)) fail('CONTEXT_SCHEMA', '"schemaVersion" is required');
  if (value.schemaVersion !== 1) {
    // Deliberately content-free: never echo the rejected value.
    fail('CONTEXT_SCHEMA', '"schemaVersion" must be exactly 1');
  }

  if ('summary' in value && typeof value.summary !== 'string') {
    fail('CONTEXT_SCHEMA', '"summary" must be a string');
  }
  for (const key of CONTENT_ARRAY_KEYS) {
    if (key in value) validateStringArray(value[key], key);
  }
  if ('messages' in value) validateMessages(value.messages);
  if ('provenance' in value) validateProvenance(value.provenance);

  const hasContent =
    isNonEmptyString(value.summary) ||
    CONTENT_ARRAY_KEYS.some((key) => Array.isArray(value[key]) && value[key].some(isNonEmptyString)) ||
    (Array.isArray(value.messages) && value.messages.some((m) => isNonEmptyString(m?.text)));

  if (!hasContent) {
    fail(
      'CONTEXT_SCHEMA',
      'context must carry at least one nonempty summary, confirmedFact, invariant, acceptanceCheck, or message',
    );
  }
}

/** Reject `..` segments in the caller-supplied path before touching the filesystem. */
function assertNoTraversal(input) {
  const segments = input.split(/[\\/]+/);
  if (segments.includes('..')) {
    fail('CONTEXT_PATH_TRAVERSAL', 'contextPath must not contain ".." segments');
  }
}

function assertContained(rootCanonical, targetCanonical) {
  const relative = path.relative(rootCanonical, targetCanonical);
  // '..notes.json' is a legal in-root filename: only a bare '..' or a leading '..<sep>' escapes.
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('CONTEXT_OUTSIDE_ROOT', 'contextPath resolves outside of workspace');
  }
}

async function readBounded(canonicalPath) {
  // Deterministic pre-check for the common refusals; the bounded read below remains the
  // authoritative guard against a file that grows between this check and the read.
  let precheck;
  try {
    precheck = await stat(canonicalPath);
  } catch (error) {
    if (error?.code === 'ENOENT') fail('CONTEXT_NOT_FOUND', 'contextPath no longer exists');
    fail('CONTEXT_IO', `cannot stat contextPath: ${error?.code ?? 'unknown'}`);
  }
  if (!precheck.isFile()) fail('CONTEXT_NOT_FILE', 'contextPath must be a regular file');
  if (precheck.size > MAX_CONTEXT_BYTES) {
    fail('CONTEXT_TOO_LARGE', `contextPath exceeds ${MAX_CONTEXT_BYTES} bytes`);
  }

  let handle;
  try {
    handle = await open(canonicalPath, 'r');
  } catch (error) {
    if (error?.code === 'ENOENT') fail('CONTEXT_NOT_FOUND', 'contextPath does not exist');
    if (error?.code === 'EISDIR') fail('CONTEXT_NOT_FILE', 'contextPath is a directory');
    fail('CONTEXT_IO', `cannot open contextPath: ${error?.code ?? 'unknown'}`);
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) fail('CONTEXT_NOT_FILE', 'contextPath must be a regular file');
    if (stats.size > MAX_CONTEXT_BYTES) {
      fail('CONTEXT_TOO_LARGE', `contextPath exceeds ${MAX_CONTEXT_BYTES} bytes`);
    }

    // Bounded read of maxBytes + 1. FileHandle.read may short-read before EOF, so loop until the
    // buffer is full or EOF; a file that grows after stat() can never make us hold more than the
    // cap, and filling the extra byte proves the cap held.
    const buffer = Buffer.allocUnsafe(MAX_CONTEXT_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break; // EOF: the whole file fitted in the buffer
      offset += bytesRead;
    }
    if (offset > MAX_CONTEXT_BYTES) {
      fail('CONTEXT_TOO_LARGE', `contextPath exceeds ${MAX_CONTEXT_BYTES} bytes`);
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

/**
 * Load one reviewed task-context file.
 *
 * @param {string|undefined|null} contextPath absolute path to a `.json` file
 * @param {string} workspace absolute workspace root that must contain the file
 * @returns {Promise<null | {path: string, sha256: string, text: string, bytes: number}>}
 *   `null` when `contextPath` is undefined/null. Otherwise the canonical path, the SHA-256 of
 *   exactly the file's UTF-8 content bytes, the original JSON string, and that byte length.
 * @throws {TaskContextError} for every other refused input
 */
export async function loadTaskContext(contextPath, workspace) {
  if (contextPath === undefined || contextPath === null) return null;

  if (typeof contextPath !== 'string' || contextPath.length === 0) {
    fail('CONTEXT_PATH', 'contextPath must be a nonempty string');
  }
  if (typeof workspace !== 'string' || workspace.length === 0) {
    fail('CONTEXT_WORKSPACE', 'workspace must be a nonempty absolute path string');
  }
  if (!path.isAbsolute(contextPath)) {
    fail('CONTEXT_PATH_NOT_ABSOLUTE', 'contextPath must be absolute');
  }
  if (!path.isAbsolute(workspace)) {
    fail('CONTEXT_WORKSPACE', 'workspace must be absolute');
  }
  assertNoTraversal(contextPath);
  if (path.extname(contextPath).toLowerCase() !== '.json') {
    fail('CONTEXT_PATH_NOT_JSON', 'contextPath must name a .json file');
  }

  let rootCanonical;
  try {
    rootCanonical = await realpath(workspace);
  } catch (error) {
    fail('CONTEXT_WORKSPACE', `workspace is not resolvable: ${error?.code ?? 'unknown'}`);
  }

  let canonicalPath;
  try {
    canonicalPath = await realpath(contextPath);
  } catch (error) {
    if (error?.code === 'ENOENT') fail('CONTEXT_NOT_FOUND', 'contextPath does not exist');
    fail('CONTEXT_IO', `cannot resolve contextPath: ${error?.code ?? 'unknown'}`);
  }

  assertContained(rootCanonical, canonicalPath);
  // The real target, not just the name the caller used, must itself be a .json file.
  if (path.extname(canonicalPath).toLowerCase() !== '.json') {
    fail('CONTEXT_PATH_NOT_JSON', 'contextPath target must be a .json file');
  }

  const buffer = await readBounded(canonicalPath);

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    fail('CONTEXT_ENCODING', 'contextPath is not valid UTF-8');
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (looksLikeJsonl(text)) {
      fail('CONTEXT_RAW_LOG', 'raw Codex JSONL logs are not accepted as task context');
    }
    // Deliberately content-free: JSON.parse's message can embed a snippet of the file body.
    fail('CONTEXT_JSON', 'contextPath is not valid JSON');
  }

  if (looksLikeLogEvent(parsed)) {
    fail('CONTEXT_RAW_LOG', 'raw Codex JSONL logs are not accepted as task context');
  }
  validateSchema(parsed);

  // SHA-256 over exactly the UTF-8 content bytes read; with the fatal decoder this equals the
  // digest of `Buffer.from(text, 'utf8')`.
  return {
    path: canonicalPath,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    text,
    bytes: buffer.length,
  };
}