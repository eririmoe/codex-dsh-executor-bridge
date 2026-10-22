/**
 * headless-monitor.mjs
 *
 * Dependency-free observer for DSH `--json` JSONL stdout.
 *
 * The monitor is purely event-driven: it never schedules timers and never
 * fabricates progress. `lastActivityAt` only advances when a well-formed JSONL
 * event is actually parsed.
 *
 * Design contract
 * ---------------
 * - `push(chunk)` accepts JS strings (a chunk may be fragmented at any position,
 *   including in the middle of a surrogate pair) and, defensively, `Uint8Array`
 *   / `Buffer` chunks which are decoded with a streaming UTF-8 decoder.
 * - `flush()` consumes the final partial line (a record that never received its
 *   trailing newline).
 * - `snapshot()` returns a fresh object containing *safe* metadata only. It can
 *   never contain prompts, reasoning text, tool inputs or tool results.
 * - `finish(...)` returns `{ ok, kind, message, text, metadata }`. The raw final
 *   answer is exposed only through `text`.
 *
 * Failure precedence used by `finish` (most authoritative first):
 *   1. abortReason `timeout` / `cancelled`
 *   2. a non-`completed` `turn_end` reason (explicit and more informative)
 *   3. clean success (exitCode === 0, `completed` turn_end, `final` received,
 *      no protocol failure, no signal)
 *   4. signal
 *   5. explicit `error` event (more informative than a generic exit code)
 *   6. non-zero exit code
 *   7. protocol failure (malformed / oversized record)
 *   8. missing `turn_end`
 *   9. `completed` turn_end without a `final` event
 *  10. otherwise `interrupted`
 *
 * Precedence note: an out-of-band `abortReason` beats a protocol failure because
 * killing a process mid-line legitimately truncates the last record; the
 * deliberate abort is the ground truth, not the resulting torn JSON.
 */

const DEFAULT_MAX_LINE_BYTES = 1048576;

/** Total memory spent buffering a single unterminated line is bounded by this. */

let cachedEncoder = null;

function utf8Length(str) {
  if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') {
    return Buffer.byteLength(str, 'utf8');
  }
  if (cachedEncoder === null) cachedEncoder = new TextEncoder();
  return cachedEncoder.encode(str).length;
}

function extractTurnReasonKind(reason) {
  if (typeof reason === 'string') return reason;
  if (reason !== null && typeof reason === 'object' && typeof reason.kind === 'string') {
    return reason.kind;
  }
  return null;
}

/** Map an upstream turn_end reason to a stable public error kind. */
function mapTurnEndKind(kind) {
  switch (kind) {
    case 'error':
      return 'turn_error';
    case 'aborted':
      return 'aborted';
    case 'interrupted':
      return 'interrupted';
    case 'max-tokens':
    case 'max_tokens':
      return 'max_tokens';
    case 'timeout':
      return 'timeout';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return 'unfinished';
  }
}

export class HeadlessMonitor {
  #now;
  #maxLineBytes;

  /** Partially received line (no newline seen yet). */
  #pending = '';
  /** UTF-8 byte length of `#pending` (tracked incrementally, O(chunk) total). */
  #pendingBytes = 0;
  /** True while discarding the remainder of an oversized line. */
  #skipping = false;
  #decoder = null;

  /** First protocol failure is retained; later ones are discarded. */
  #firstFailure = null;
  /** Number of non-blank records offered to the parser (for error messages). */
  #records = 0;

  // --- safe metadata -------------------------------------------------------
  #eventCount = 0;
  #sessionId = null;
  #lastPhase = null;
  #turnEndKind = null;
  #finalReceived = false;
  #toolErrorCount = 0;
  #lastTool = null;
  #lastActivityAt = null;

  // --- answer text (returned only via `text`) ------------------------------
  #streamedText = '';
  #finalText = null;
  // --- internal only, never surfaced in metadata ---------------------------
  #errorEvent = null;

  constructor({ now = Date.now, maxLineBytes = DEFAULT_MAX_LINE_BYTES } = {}) {
    if (typeof now !== 'function') {
      throw new TypeError('HeadlessMonitor: `now` must be a function');
    }
    if (!Number.isInteger(maxLineBytes) || maxLineBytes <= 0) {
      throw new TypeError('HeadlessMonitor: `maxLineBytes` must be a positive integer');
    }
    this.#now = now;
    this.#maxLineBytes = maxLineBytes;
  }

  /** Feed a chunk of stdout. Strings are concatenated verbatim. */
  push(chunk) {
    if (chunk === null || chunk === undefined) return;
    let text;
    if (typeof chunk === 'string') {
      text = chunk;
    } else if (chunk instanceof Uint8Array) {
      if (this.#decoder === null) this.#decoder = new TextDecoder('utf-8');
      text = this.#decoder.decode(chunk, { stream: true });
    } else {
      text = String(chunk);
    }
    if (text.length === 0) return;
    this.#consume(text);
  }

  /** Consume the final partial line, if any. Safe to call more than once. */
  flush() {
    if (this.#decoder !== null) {
      const tail = this.#decoder.decode();
      if (tail.length > 0) this.#consume(tail);
    }
    if (this.#skipping) {
      this.#skipping = false;
      this.#pending = '';
      this.#pendingBytes = 0;
    }
    if (this.#pending.length > 0) {
      const line = this.#pending;
      this.#pending = '';
      this.#pendingBytes = 0;
      this.#handleLine(line);
    }
  }

  /** Safe metadata only: never contains prompts, reasoning, tool I/O. */
  snapshot() {
    return {
      eventCount: this.#eventCount,
      sessionId: this.#sessionId,
      lastPhase: this.#lastPhase,
      turnEndKind: this.#turnEndKind,
      finalReceived: this.#finalReceived,
      toolErrorCount: this.#toolErrorCount,
      lastTool: this.#lastTool,
      lastActivityAt: this.#lastActivityAt,
    };
  }

  /**
   * Decide the terminal outcome.
   * @param {{exitCode?: number|null, signal?: string|null, abortReason?: string|null}} [options]
   * @returns {{ok: boolean, kind: string, message: string, text: string, metadata: object}}
   */
  finish(options = {}) {
    const { exitCode = null, signal = null, abortReason = null } = options ?? {};
    const metadata = this.snapshot();
    const text = this.#finalText !== null ? this.#finalText : this.#streamedText;
    const done = (ok, kind, message) => ({ ok, kind, message, text, metadata });

    // 1. Explicit out-of-band abort wins: it is the ground truth even if the
    //    kill tore the last record in half.
    if (abortReason === 'timeout') {
      return done(false, 'timeout', 'process aborted: timeout');
    }
    if (abortReason === 'cancelled' || abortReason === 'canceled') {
      return done(false, 'cancelled', 'process aborted: cancelled');
    }

    // 2. A non-completed turn reason is explicit and more informative than a
    //    generic process exit. It must never be accepted, even with exit 0.
    if (this.#turnEndKind !== null && this.#turnEndKind !== 'completed') {
      return done(
        false,
        mapTurnEndKind(this.#turnEndKind),
        `turn ended without completion (reason: ${this.#turnEndKind})`,
      );
    }

    // 3. Clean success requires all of: exit 0, completed turn_end, a final
    //    event, and no protocol failure.
    if (
      exitCode === 0 &&
      signal === null &&
      this.#turnEndKind === 'completed' &&
      this.#finalReceived &&
      this.#firstFailure === null &&
      this.#errorEvent === null
    ) {
      return done(true, 'ok', 'turn completed');
    }

    // 4. Terminated by a signal.
    if (signal !== null && signal !== undefined) {
      return done(false, 'process_exit', `process terminated by signal ${signal}`);
    }

    // 5. An explicit error event is more informative than a generic exit code.
    if (this.#errorEvent !== null) {
      const code = this.#errorEvent.code;
      return done(false, 'error', code ? `error event: ${code}` : 'error event');
    }

    // 6. Non-zero exit code.
    if (exitCode !== null && exitCode !== undefined && exitCode !== 0) {
      return done(false, 'process_exit', `process exited with code ${exitCode}`);
    }

    // 7. Data corruption.
    if (this.#firstFailure !== null) {
      return done(false, 'protocol_error', this.#firstFailure.message);
    }

    // 8. Stream ended before any turn_end.
    if (this.#turnEndKind === null) {
      return done(false, 'interrupted', 'no turn_end received before process end');
    }

    // 9. Turn completed but no final answer was emitted.
    if (this.#turnEndKind === 'completed' && !this.#finalReceived) {
      return done(false, 'no_final', 'turn completed without a final event');
    }

    // 10. completed + final but the process did not report a clean exit code.
    if (this.#turnEndKind === 'completed' && this.#finalReceived) {
      return done(
        false,
        'process_exit',
        `process did not report a clean exit code (exitCode: ${String(exitCode)})`,
      );
    }

    return done(false, 'interrupted', 'process ended without a completed turn');
  }

  // -------------------------------------------------------------------------
  #consume(chunk) {
    let i = 0;
    const n = chunk.length;
    while (i < n) {
      if (this.#skipping) {
        const nl = chunk.indexOf('\n', i);
        if (nl === -1) return; // still inside the oversized line
        this.#skipping = false;
        i = nl + 1;
        continue;
      }
      const nl = chunk.indexOf('\n', i);
      if (nl === -1) {
        const seg = chunk.slice(i);
        this.#pending += seg;
        this.#pendingBytes += utf8Length(seg);
        if (this.#pendingBytes > this.#maxLineBytes) {
          // The line can only grow, so it is already known to be oversized.
          // Record the failure and stop buffering it (bounded memory).
          this.#fail(
            `record ${this.#records + 1} exceeds maxLineBytes (${this.#maxLineBytes} bytes)`,
          );
          this.#pending = '';
          this.#pendingBytes = 0;
          this.#skipping = true;
        }
        return;
      }
      const part = chunk.slice(i, nl);
      i = nl + 1;
      const line = this.#pending + part;
      this.#pending = '';
      this.#pendingBytes = 0;
      this.#handleLine(line);
    }
  }

  #handleLine(rawLine) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length === 0) return; // blank records are ignored
    this.#records += 1;
    const record = this.#records;
    if (utf8Length(line) > this.#maxLineBytes) {
      this.#fail(`record ${record} exceeds maxLineBytes (${this.#maxLineBytes} bytes)`);
      return;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      this.#fail(`record ${record} is not valid JSON`);
      return;
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      this.#fail(`record ${record} is not a JSON object`);
      return;
    }
    this.#applyEvent(event);
  }

  #fail(message) {
    if (this.#firstFailure === null) {
      this.#firstFailure = { kind: 'protocol_error', message };
    }
  }

  #applyEvent(event) {
    this.#eventCount += 1;
    const type = typeof event.type === 'string' ? event.type : null;
    switch (type) {
      case 'session':
        if (typeof event.sessionId === 'string') this.#sessionId = event.sessionId;
        break;
      case 'status':
        if (typeof event.phase === 'string') this.#lastPhase = event.phase;
        if (event.phase === 'turn_end') {
          const kind = extractTurnReasonKind(event.reason);
          if (kind !== null) this.#turnEndKind = kind;
        }
        break;
      case 'tool_call':
        // Only the tool *name* is kept; `input` is deliberately never retained.
        if (typeof event.tool === 'string') this.#lastTool = event.tool;
        break;
      case 'tool_result':
        // Only the outcome is counted; `result` is deliberately never retained.
        if (typeof event.status === 'string' && event.status !== 'completed') {
          this.#toolErrorCount += 1;
        }
        break;
      case 'text':
        if (typeof event.text === 'string') this.#streamedText += event.text;
        break;
      case 'thinking':
        // Reasoning text is deliberately dropped: it must never leak anywhere.
        break;
      case 'final':
        this.#finalReceived = true;
        if (typeof event.text === 'string') this.#finalText = event.text;
        break;
      case 'error':
        // Only the code is retained internally, and only as a message hint.
        this.#errorEvent = { code: typeof event.code === 'string' ? event.code : null };
        break;
      default:
        // Unknown future event types are ignored but still count as activity.
        break;
    }
    this.#lastActivityAt = this.#now();
  }
}

export default HeadlessMonitor;
