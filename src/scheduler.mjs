/**
 * scheduler.mjs
 *
 * Dependency-free bounded task scheduler (Node ESM).
 *
 * Contract
 * --------
 * - `new TaskScheduler({ maxConcurrency })` accepts an integer 1..5 only (default 4).
 * - `run(workspaceKey, operation, { signal, onQueued, onStart })` returns a promise that
 *   settles exactly like `operation()` (its resolved value, its rejection, or a synchronous
 *   throw). `operation` is always invoked with zero arguments.
 * - The number of simultaneously running operations never exceeds `maxConcurrency`.
 * - Two operations sharing the same `workspaceKey` are never active at the same time.
 * - The queue is scanned for the first eligible task, so a task blocked on an already-active
 *   workspace key never prevents later tasks for other keys from using a free slot
 *   (no head-of-line blocking).
 * - `workspaceKey` is an opaque, already-canonicalized string supplied by the caller. This
 *   module never normalizes, resolves, or otherwise interprets it as a filesystem path.
 *
 * Queue callbacks
 * ---------------
 * - `onQueued()` fires only when a task actually has to wait in the pending queue
 *   (not for tasks that start immediately).
 * - `onStart()` fires when a task begins executing (immediately or after waiting).
 * - If either callback throws, the task's promise rejects with that error and no queue slot
 *   or concurrency slot is leaked.
 *
 * Cancellation
 * ------------
 * - A task whose `signal` is already aborted is rejected without being queued and without
 *   invoking `operation` (and without invoking `onQueued`/`onStart`).
 * - Aborting a queued task removes it from the queue and rejects its promise. Cancelled
 *   work is never started.
 * - Aborting a running task is not interpreted by the scheduler: the operation observes the
 *   caller's own signal independently, and capacity is released only when the operation
 *   actually settles. The returned promise is not settled early.
 * - Capacity and the workspace key are released on resolve, reject, and synchronous throw.
 *
 * Shutdown
 * --------
 * - `close(reason)` rejects every queued task with `reason` and rejects all future `run`
 *   calls with the same `reason`. Already running tasks are not stopped or rejected; their
 *   capacity is released normally when they settle. `close` is idempotent.
 */

const DEFAULT_MAX_CONCURRENCY = 4;
const MIN_MAX_CONCURRENCY = 1;
const MAX_MAX_CONCURRENCY = 5;

/** Build the rejection reason for an aborted task, preferring the signal's own reason. */
function abortReason(signal) {
  if (signal !== null && signal !== undefined && signal.reason !== undefined) {
    return signal.reason;
  }
  const error = new Error('Task aborted');
  error.name = 'AbortError';
  return error;
}

/** Minimal structural check for an AbortSignal-like object (avoids importing anything). */
function isAbortSignalLike(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.aborted === 'boolean' &&
    typeof value.addEventListener === 'function' &&
    typeof value.removeEventListener === 'function'
  );
}

function isOptionalCallback(value) {
  return value === undefined || value === null || typeof value === 'function';
}

export class TaskScheduler {
  #maxConcurrency;
  #active = 0;
  /** Workspace keys that currently have a running task (serialization guard). */
  #activeKeys = new Set();
  /** Pending tasks in arrival order. */
  #pending = [];
  /** Re-entrancy guard so a synchronous burst of settles cannot recurse without bound. */
  #pumping = false;
  #closed = false;
  #closedReason = null;

  constructor(options = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('TaskScheduler options must be an object');
    }
    const { maxConcurrency = DEFAULT_MAX_CONCURRENCY } = options;
    if (typeof maxConcurrency !== 'number' || !Number.isInteger(maxConcurrency)) {
      throw new TypeError('maxConcurrency must be an integer between 1 and 5');
    }
    if (maxConcurrency < MIN_MAX_CONCURRENCY || maxConcurrency > MAX_MAX_CONCURRENCY) {
      throw new RangeError(
        `maxConcurrency must be between ${MIN_MAX_CONCURRENCY} and ${MAX_MAX_CONCURRENCY}`,
      );
    }
    this.#maxConcurrency = maxConcurrency;
  }

  /**
   * Schedule `operation` for `workspaceKey`.
   *
   * Argument validation failures throw synchronously (programmer errors); runtime state
   * failures (closed scheduler, aborted signal) reject the returned promise.
   *
   * @param {string} workspaceKey opaque, already-canonicalized workspace identifier
   * @param {() => unknown} operation invoked with zero arguments when the task starts
   * @param {{ signal?: AbortSignal, onQueued?: () => void, onStart?: () => void }} [options]
   * @returns {Promise<unknown>}
   */
  run(workspaceKey, operation, options = null) {
    if (typeof workspaceKey !== 'string') {
      throw new TypeError('workspaceKey must be a string');
    }
    if (typeof operation !== 'function') {
      throw new TypeError('operation must be a function');
    }
    if (
      options !== null &&
      options !== undefined &&
      (typeof options !== 'object' || Array.isArray(options))
    ) {
      throw new TypeError('options must be an object');
    }
    const { signal = null, onQueued = null, onStart = null } = options ?? {};
    if (signal !== null && signal !== undefined && !isAbortSignalLike(signal)) {
      throw new TypeError('signal must be an AbortSignal');
    }
    if (!isOptionalCallback(onQueued)) {
      throw new TypeError('onQueued must be a function');
    }
    if (!isOptionalCallback(onStart)) {
      throw new TypeError('onStart must be a function');
    }

    if (this.#closed) {
      return Promise.reject(this.#closedReason);
    }
    if (signal !== null && signal !== undefined && signal.aborted) {
      return Promise.reject(abortReason(signal));
    }

    return new Promise((resolve, reject) => {
      const task = {
        workspaceKey,
        operation,
        signal: signal ?? null,
        onQueued,
        onStart,
        resolve,
        reject,
        abortHandler: null,
        settled: false,
      };

      // Slow path decision is made synchronously here: start now, or wait in the queue.
      if (this.#active < this.#maxConcurrency && !this.#activeKeys.has(workspaceKey)) {
        this.#start(task);
        return;
      }

      this.#pending.push(task);
      task.abortHandler = () => {
        const index = this.#pending.indexOf(task);
        if (index !== -1) {
          this.#pending.splice(index, 1);
        }
        this.#detachAbort(task);
        task.settled = true;
        task.reject(abortReason(task.signal));
      };
      if (task.signal !== null) {
        task.signal.addEventListener('abort', task.abortHandler, { once: true });
      }

      if (typeof onQueued === 'function') {
        try {
          onQueued();
        } catch (error) {
          const index = this.#pending.indexOf(task);
          if (index !== -1) {
            this.#pending.splice(index, 1);
          }
          this.#detachAbort(task);
          task.settled = true;
          reject(error);
        }
      }
    });
  }

  /** @returns {{ maxConcurrency: number, active: number, pending: number }} */
  snapshot() {
    return {
      maxConcurrency: this.#maxConcurrency,
      active: this.#active,
      pending: this.#pending.length,
    };
  }

  /**
   * Reject queued tasks and refuse new ones. Running tasks are left untouched and still
   * release their capacity when they settle. Idempotent: later calls are ignored and the
   * first reason is kept.
   *
   * @param {unknown} [reason]
   */
  close(reason) {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#closedReason = reason === undefined ? new Error('TaskScheduler is closed') : reason;

    const queued = this.#pending.splice(0, this.#pending.length);
    for (const task of queued) {
      this.#detachAbort(task);
      task.settled = true;
      task.reject(this.#closedReason);
    }
  }

  /** Claim capacity for `task` and run it, settling the promise with the operation outcome. */
  #start(task) {
    this.#detachAbort(task);
    this.#active += 1;
    this.#activeKeys.add(task.workspaceKey);

    if (typeof task.onStart === 'function') {
      try {
        task.onStart();
      } catch (error) {
        this.#settle(task, task.reject, error);
        return;
      }
    }

    let result;
    try {
      result = task.operation();
    } catch (error) {
      this.#settle(task, task.reject, error);
      return;
    }

    Promise.resolve(result).then(
      (value) => {
        this.#settle(task, task.resolve, value);
      },
      (error) => {
        this.#settle(task, task.reject, error);
      },
    );
  }

  /** Release capacity + workspace key, settle the caller promise, then admit more work. */
  #settle(task, settleFn, value) {
    if (task.settled) {
      return;
    }
    task.settled = true;
    this.#active -= 1;
    this.#activeKeys.delete(task.workspaceKey);
    this.#detachAbort(task);
    settleFn(value);
    this.#pump();
  }

  /** Detach the queued-abort listener so no listener/queue state leaks. */
  #detachAbort(task) {
    if (task.abortHandler !== null && task.signal !== null) {
      task.signal.removeEventListener('abort', task.abortHandler);
    }
    task.abortHandler = null;
  }

  /** Start queued tasks while a slot and an unblocked workspace key are both available. */
  #pump() {
    if (this.#pumping) {
      return;
    }
    this.#pumping = true;
    try {
      while (this.#active < this.#maxConcurrency) {
        let index = -1;
        for (let i = 0; i < this.#pending.length; i += 1) {
          if (!this.#activeKeys.has(this.#pending[i].workspaceKey)) {
            index = i;
            break;
          }
        }
        if (index === -1) {
          break;
        }
        const [task] = this.#pending.splice(index, 1);
        this.#start(task);
      }
    } finally {
      this.#pumping = false;
    }
  }
}

export default TaskScheduler;