/**
 * context-export.mjs — dependency-free Codex rollout conversation exporter.
 *
 * Contract (bounded, single responsibility):
 *  - Streams an explicitly supplied Codex rollout JSONL file READ-ONLY. Nothing else on
 *    disk is ever opened: pasted attachment paths and referenced files are never read.
 *  - Selects ONLY records of the shape:
 *        { type: "response_item", payload: { type: "message", role: "user" | "assistant",
 *          content: [ { type: "input_text" | "output_text", text: "..." }, ... ] } }
 *    Only the explicit input_text/output_text containers carry visible text; a generic
 *    "text" container is treated as unknown and skipped.
 *  - Assistant visibility is fail-closed on the payload surface fields `channel` and
 *    `phase`: an absent/null/empty field is accepted, a known visible value
 *    (commentary/final/final_answer) is accepted, and any other non-empty value
 *    (analysis/summary/reasoning/internal/hidden or unknown) excludes the record. Visible
 *    commentary is retained. Tool/function records, tool outputs, developer/system roles,
 *    images and other non-visible content are excluded.
 *  - Ignores injected user wrappers that begin with a known marker
 *    ("# AGENTS.md instructions", "<environment_context>", "<external_codex_apps_open_page>").
 *  - Provenance is limited to session_meta.payload.id -> sourceThreadId. The absolute
 *    source path and raw session/tool metadata are NEVER exported.
 *  - Keeps only the most recent `maxMessages` messages and at most `maxTextBytes` total
 *    UTF-8 text bytes. This rolling retention is enforced DURING streaming collection, so
 *    the in-memory message list stays bounded rather than growing to end of file; the
 *    streamed line buffer is bounded to 1 MiB. Oversized records are skipped and flagged
 *    via provenance.truncated.
 *  - Tolerates exactly one torn final JSONL record (the source may be actively written);
 *    malformed *complete* lines fail with a concise error that never echoes content.
 *  - Best-effort redaction of recognizable credential shapes (sk-, ghp_, github_pat_,
 *    Bearer, api_key/password/secret assignments). This is NOT a guarantee of full
 *    redaction; the caller must review the export before transferring it anywhere.
 *
 * @param {string} sourcePath absolute or relative path to the rollout JSONL file
 * @param {{ maxMessages?: number, maxTextBytes?: number, now?: () => string }} [options]
 * @returns {Promise<{schemaVersion:1,summary:'',confirmedFacts:[],invariants:[],
 *   acceptanceChecks:[],messages:Array<{role:string,text:string}>,
 *   provenance:{sourceThreadId?:string,capturedAt:string,truncated:boolean}}>}
 */
import { createReadStream } from 'node:fs';

/** Bounded per-line buffer; a longer physical line is skipped entirely. */
const MAX_LINE_BYTES = 1024 * 1024; // 1 MiB
/** Hard cap for the serialized UTF-8 JSON result. */
const MAX_JSON_BYTES = 98304;

/**
 * Content item types that carry user-visible text. Deliberately excludes the generic
 * `text` container: only the explicitly specified input/output containers are trusted.
 */
const VISIBLE_CONTENT_TYPES = new Set(['input_text', 'output_text']);
/**
 * Assistant surface values that are known user-visible. Local Codex labels visible
 * surfaces with payload.phase ("commentary" | "final_answer"); payload.channel carries
 * equivalents on other builds. Anything else non-empty is treated as internal/unknown.
 */
const VISIBLE_SURFACES = new Set(['commentary', 'final', 'final_answer']);
/** Injected (non-user-authored) wrapper prefixes that must not be exported as conversation. */
const WRAPPER_PREFIXES = [
  '# AGENTS.md instructions',
  '<environment_context>',
  '<external_codex_apps_open_page>',
];

/**
 * Best-effort credential redaction. Order matters: token-shaped rules run first so a
 * partially quoted value is still fully replaced.
 * @type {Array<[RegExp, string | ((...args: string[]) => string)]>}
 */
const REDACTION_RULES = [
  [/\bsk-[A-Za-z0-9_-]{6,}/g, '[REDACTED]'],
  [/\bghp_[A-Za-z0-9]{10,}/g, '[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{10,}/g, '[REDACTED]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, (match) => `${match.slice(0, 6)} [REDACTED]`],
  [
    /\b(api[_-]?key|apikey|password|passwd|pwd|secret|client[_-]?secret|access[_-]?token|auth[_-]?token|token)\b(\s*[:=]\s*)("[^"]{0,512}"|'[^']{0,512}'|[^\s"',;]{4,512})/gi,
    (_match, key, separator) => `${key}${separator}[REDACTED]`,
  ],
];

/** Error type used for all intentional, content-free failures. */
class ExportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExportError';
  }
}

const utf8Decoder = new TextDecoder('utf-8');
const bytesOf = (text) => Buffer.byteLength(text, 'utf8');

/**
 * Trim a string to at most `maxBytes` UTF-8 bytes without splitting a code point.
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
function trimUtf8(text, maxBytes) {
  if (maxBytes <= 0) return '';
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1; // back off a split continuation byte
  return utf8Decoder.decode(buf.subarray(0, end));
}

/**
 * Stream physical JSONL lines with a bounded buffer.
 * Yields `{ text, terminated, lineNumber, skippedOversize }`; at most one non-terminated
 * (torn) final line is possible and is reported with `terminated: false`.
 * @param {string} sourcePath
 */
async function* readLines(sourcePath) {
  const stream = createReadStream(sourcePath, { highWaterMark: 64 * 1024 });
  /** @type {Buffer[]} */
  let parts = [];
  let bufferedBytes = 0;
  let discardingOversize = false;
  let lineNumber = 0;

  const append = (buf) => {
    if (discardingOversize) return;
    if (bufferedBytes + buf.length > MAX_LINE_BYTES) {
      discardingOversize = true;
      parts = [];
      bufferedBytes = 0;
      return;
    }
    parts.push(buf);
    bufferedBytes += buf.length;
  };

  const flush = (terminated) => {
    lineNumber += 1;
    if (discardingOversize) {
      discardingOversize = false;
      parts = [];
      bufferedBytes = 0;
      return { text: '', terminated, lineNumber, skippedOversize: true };
    }
    const buf = parts.length === 0 ? Buffer.alloc(0) : Buffer.concat(parts, bufferedBytes);
    parts = [];
    bufferedBytes = 0;
    let end = buf.length;
    if (end > 0 && buf[end - 1] === 0x0d) end -= 1; // tolerate CRLF
    return {
      text: buf.subarray(0, end).toString('utf8'),
      terminated,
      lineNumber,
      skippedOversize: false,
    };
  };

  try {
    for await (const chunk of stream) {
      let start = 0;
      for (;;) {
        const newlineAt = chunk.indexOf(0x0a, start);
        if (newlineAt === -1) {
          append(chunk.subarray(start));
          break;
        }
        append(chunk.subarray(start, newlineAt));
        yield flush(true);
        start = newlineAt + 1;
        if (start >= chunk.length) break;
      }
    }
  } finally {
    stream.destroy();
  }

  if (discardingOversize || bufferedBytes > 0) yield flush(false);
}

/** Apply best-effort credential redaction to a single message body. */
function redact(text) {
  let output = text;
  for (const [pattern, replacement] of REDACTION_RULES) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

/** True when the text is an injected wrapper rather than a genuine user turn. */
function isInjectedWrapper(text) {
  const trimmed = text.trimStart();
  return WRAPPER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/**
 * Fail-closed surface check over the payload fields that label an assistant reply.
 * `channel` and `phase` are both inspected: an absent/null/empty value is not itself
 * disqualifying, a known visible value passes, and any other non-empty value — the known
 * internal surfaces (analysis/summary/reasoning/internal/hidden/thinking) as well as any
 * unknown token — excludes the record. This keeps visible commentary while never leaking
 * an unrecognized surface merely because the other field happened to be absent.
 * @returns {boolean} true when the record must be excluded
 */
function isExcludedSurface(payload) {
  for (const field of ['channel', 'phase']) {
    const raw = payload[field];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') return true; // unexpected shape: fail closed
    const value = raw.trim().toLowerCase();
    if (value === '') continue;
    if (!VISIBLE_SURFACES.has(value)) return true;
  }
  return false;
}

/**
 * Extract user-visible text from one response_item message payload.
 * @returns {string | null} `null` when the record carries no visible conversation text.
 */
function extractVisibleText(payload, role) {
  if (isExcludedSurface(payload)) return null;

  const content = Array.isArray(payload.content) ? payload.content : [];
  const pieces = [];
  for (const item of content) {
    if (item === null || typeof item !== 'object') continue;
    const itemType = item.type;
    if (!VISIBLE_CONTENT_TYPES.has(itemType)) continue; // drops images/refusals/unknowns
    if (typeof item.text !== 'string') continue;
    // Role-channel consistency: user turns carry input_text, assistant turns output_text.
    if (itemType === 'input_text' && role !== 'user') continue;
    if (itemType === 'output_text' && role !== 'assistant') continue;
    if (item.text.trim() === '') continue;
    pieces.push(item.text);
  }
  if (pieces.length === 0) return null;

  const text = pieces.join('\n');
  if (text.trim() === '') return null;
  if (role === 'user' && isInjectedWrapper(text)) return null;
  return text;
}

function assertPositiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`context-export: ${name} must be a positive integer`);
  }
}

/**
 * Export a bounded, provenance-only view of a Codex rollout conversation.
 * See the module-level contract for the full behavioural specification.
 */
export async function exportConversation(sourcePath, options = {}) {
  if (typeof sourcePath !== 'string' || sourcePath.trim() === '') {
    throw new TypeError('context-export: sourcePath must be a non-empty string');
  }
  const settings = options === null || typeof options !== 'object' ? {} : options;
  const maxMessages = settings.maxMessages ?? 40;
  const maxTextBytes = settings.maxTextBytes ?? 48000;
  const now = settings.now ?? (() => new Date().toISOString());
  assertPositiveInteger('maxMessages', maxMessages);
  assertPositiveInteger('maxTextBytes', maxTextBytes);
  if (typeof now !== 'function') throw new TypeError('context-export: now must be a function');
  const capturedAt = String(now());

  /** @type {Array<{role: 'user' | 'assistant', text: string}>} */
  const collected = [];
  /** Running UTF-8 text-byte total for `collected`, kept in sync as messages roll off. */
  let collectedTextBytes = 0;
  /** @type {string | undefined} */
  let sourceThreadId;
  let truncated = false;

  /**
   * Enforce the rolling retention budgets while streaming. Dropping the oldest messages
   * here (rather than only after EOF) keeps peak memory proportional to the exported
   * window instead of the whole rollout. At least the newest message is always kept; a
   * single message larger than `maxTextBytes` is trimmed once at the end.
   */
  const enforceRetention = () => {
    while (collected.length > maxMessages) {
      collectedTextBytes -= bytesOf(collected.shift().text);
      truncated = true;
    }
    while (collected.length > 1 && collectedTextBytes > maxTextBytes) {
      collectedTextBytes -= bytesOf(collected.shift().text);
      truncated = true;
    }
  };

  try {
    for await (const line of readLines(sourcePath)) {
      if (line.skippedOversize) {
        truncated = true; // bounded buffer: knowingly dropped an oversized record
        continue;
      }
      if (line.text.trim() === '') continue; // blank padding line

      let record;
      try {
        record = JSON.parse(line.text);
      } catch {
        if (!line.terminated) {
          truncated = true; // exactly one torn final record is tolerated (active source)
          break;
        }
        // Never echo the offending content.
        throw new ExportError(`context-export: malformed JSONL record at line ${line.lineNumber}`);
      }
      if (record === null || typeof record !== 'object') continue;

      if (record.type === 'session_meta') {
        const id = record.payload?.id;
        if (sourceThreadId === undefined && typeof id === 'string' && id !== '') {
          sourceThreadId = id; // provenance only: no paths, no raw metadata
        }
        continue;
      }

      if (record.type !== 'response_item') continue;
      const payload = record.payload;
      if (payload === null || typeof payload !== 'object') continue;
      if (payload.type !== 'message') continue; // drops reasoning/function_call/tool records
      const role = payload.role;
      if (role !== 'user' && role !== 'assistant') continue; // drops developer/system/tool

      const text = extractVisibleText(payload, role);
      if (text === null) continue;
      const redacted = redact(text);
      collected.push({ role, text: redacted });
      collectedTextBytes += bytesOf(redacted);
      enforceRetention();
    }
  } catch (error) {
    if (error instanceof ExportError || error instanceof TypeError) throw error;
    const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
    throw new ExportError(`context-export: failed to read source (${code})`);
  }

  if (collected.length === 0) {
    throw new ExportError('context-export: no exportable user or assistant messages found');
  }

  // --- recency + text-byte budget -------------------------------------------------
  // Rolling retention already ran during collection; this is a defensive re-check.
  const messages = collected;
  let totalTextBytes = collectedTextBytes;
  while (messages.length > 1 && totalTextBytes > maxTextBytes) {
    const dropped = messages.shift();
    totalTextBytes -= bytesOf(dropped.text);
    truncated = true;
  }
  if (totalTextBytes > maxTextBytes && messages.length > 0) {
    const only = messages[0];
    const trimmed = trimUtf8(only.text, maxTextBytes);
    only.text = trimmed === '' ? Array.from(only.text)[0] ?? '' : trimmed;
    truncated = true;
  }

  // --- serialized-size budget -----------------------------------------------------
  const buildOutput = () => {
    /** @type {{sourceThreadId?: string, capturedAt: string, truncated: boolean}} */
    const provenance = {};
    if (sourceThreadId !== undefined) provenance.sourceThreadId = sourceThreadId;
    provenance.capturedAt = capturedAt;
    provenance.truncated = truncated;
    return {
      schemaVersion: 1,
      summary: '',
      // Facts are never inferred from historical messages; callers supply them elsewhere.
      confirmedFacts: [],
      invariants: [],
      acceptanceChecks: [],
      messages: messages.map((message) => ({ role: message.role, text: message.text })),
      provenance,
    };
  };

  const serializedBytes = () => bytesOf(JSON.stringify(buildOutput()));

  if (serializedBytes() > MAX_JSON_BYTES) {
    truncated = true;
    while (messages.length > 1 && serializedBytes() > MAX_JSON_BYTES) messages.shift();
    let guard = 0;
    while (serializedBytes() > MAX_JSON_BYTES && guard < 64) {
      const only = messages[0];
      const current = bytesOf(only.text);
      if (current === 0) break;
      const next = Math.max(1, Math.floor(current * 0.75));
      const trimmed = trimUtf8(only.text, next);
      only.text = trimmed === '' ? Array.from(only.text)[0] ?? '' : trimmed;
      guard += 1;
    }
    if (serializedBytes() > MAX_JSON_BYTES) {
      throw new ExportError('context-export: unable to fit export within output size limit');
    }
  }

  if (messages.length === 0) {
    throw new ExportError('context-export: no exportable user or assistant messages found');
  }

  return buildOutput();
}