/**
 * scheduler.test.mjs — offline tests for scheduler.mjs (node:test, no dependencies).
 *
 * All concurrency is controlled with explicit deferred promises; no setTimeout, no
 * setImmediate, no child processes, no network. Run either way:
 *   node --test scheduler.test.mjs
 *   node scheduler.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskScheduler } from '../src/scheduler.mjs';

/** A promise plus its externally controlled settle functions. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drain pending microtasks (every scheduler hop here is microtask-based). */
async function flush(turns = 8) {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

/** Assert that `promise` rejects with exactly `expected`. */
function rejectsWith(promise, expected) {
  return assert.rejects(promise, (error) => error === expected);
}

test('constructor defaults to 4 and accepts integers 1..5', () => {
  assert.equal(new TaskScheduler().snapshot().maxConcurrency, 4);
  assert.equal(new TaskScheduler({}).snapshot().maxConcurrency, 4);
  assert.equal(new TaskScheduler({ maxConcurrency: undefined }).snapshot().maxConcurrency, 4);
  for (const value of [1, 2, 3, 4, 5]) {
    assert.equal(new TaskScheduler({ maxConcurrency: value }).snapshot().maxConcurrency, value);
  }
});

test('constructor rejects anything that is not an integer in 1..5', () => {
  for (const bad of [0, 6, -1, 4.5, NaN, Infinity, -Infinity, '4', null, true, [], {}]) {
    assert.throws(() => new TaskScheduler({ maxConcurrency: bad }), {
      name: /^(TypeError|RangeError)$/,
    });
  }
  assert.throws(() => new TaskScheduler(null), TypeError);
  assert.throws(() => new TaskScheduler([]), TypeError);
});

test('run validates its arguments synchronously', () => {
  const scheduler = new TaskScheduler();
  assert.throws(() => scheduler.run(123, () => {}), TypeError);
  assert.throws(() => scheduler.run('ws', 'not-a-function'), TypeError);
  assert.throws(() => scheduler.run('ws', () => {}, { signal: {} }), TypeError);
  assert.throws(() => scheduler.run('ws', () => {}, { onQueued: 'x' }), TypeError);
  assert.throws(() => scheduler.run('ws', () => {}, { onStart: 1 }), TypeError);
  assert.equal(scheduler.snapshot().active, 0);
  assert.equal(scheduler.snapshot().pending, 0);
});

test('runs 4 concurrent operations and queues the fifth (default limit)', async () => {
  const scheduler = new TaskScheduler();
  const started = [];
  const gates = [];
  const tasks = [];
  for (let i = 0; i < 5; i += 1) {
    const gate = deferred();
    gates.push(gate);
    tasks.push(
      scheduler.run(`ws-${i}`, () => {
        started.push(i);
        return gate.promise;
      }),
    );
  }

  await flush();
  assert.deepEqual(started, [0, 1, 2, 3]);
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 4, active: 4, pending: 1 });

  gates[0].resolve('r0');
  await flush();
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 4, active: 4, pending: 0 });

  gates[1].resolve('r1');
  gates[2].resolve('r2');
  gates[3].resolve('r3');
  gates[4].resolve('r4');
  assert.deepEqual(await Promise.all(tasks), ['r0', 'r1', 'r2', 'r3', 'r4']);
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 4, active: 0, pending: 0 });
});

test('honours a configured limit of 5 and never exceeds it', async () => {
  const scheduler = new TaskScheduler({ maxConcurrency: 5 });
  const gates = Array.from({ length: 6 }, () => deferred());
  let observedMax = 0;
  const tasks = gates.map((gate, i) =>
    scheduler.run(`key-${i}`, () => {
      observedMax = Math.max(observedMax, scheduler.snapshot().active);
      return gate.promise;
    }),
  );

  await flush();
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 5, active: 5, pending: 1 });

  gates[0].resolve(0);
  await flush();
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 5, active: 5, pending: 0 });

  for (let i = 1; i < 6; i += 1) {
    gates[i].resolve(i);
  }
  assert.deepEqual(await Promise.all(tasks), [0, 1, 2, 3, 4, 5]);
  assert.equal(observedMax, 5);
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 5, active: 0, pending: 0 });
});

test('never runs two tasks with the same workspaceKey simultaneously', async () => {
  const scheduler = new TaskScheduler();
  const entered = [];
  const gates = [deferred(), deferred(), deferred()];
  const tasks = gates.map((gate, i) =>
    scheduler.run('shared-key', () => {
      entered.push(i);
      return gate.promise;
    }),
  );

  await flush();
  assert.deepEqual(entered, [0]);
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 4, active: 1, pending: 2 });

  gates[0].resolve('a');
  await flush();
  assert.deepEqual(entered, [0, 1]);
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 4, active: 1, pending: 1 });

  gates[1].resolve('b');
  await flush();
  assert.deepEqual(entered, [0, 1, 2]);

  gates[2].resolve('c');
  assert.deepEqual(await Promise.all(tasks), ['a', 'b', 'c']);
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 4, active: 0, pending: 0 });
});

test('a task blocked on a busy key does not block later eligible keys', async () => {
  const scheduler = new TaskScheduler({ maxConcurrency: 2 });
  const order = [];
  const gates = { a: deferred(), b: deferred(), c: deferred() };

  const a = scheduler.run('busy', () => {
    order.push('a');
    return gates.a.promise;
  });
  const b = scheduler.run('busy', () => {
    order.push('b');
    return gates.b.promise;
  });
  const c = scheduler.run('free', () => {
    order.push('c');
    return gates.c.promise;
  });

  await flush();
  assert.deepEqual(order, ['a', 'c']);
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 2, active: 2, pending: 1 });

  gates.a.resolve('a');
  await flush();
  assert.deepEqual(order, ['a', 'c', 'b']);
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 2, active: 2, pending: 0 });

  gates.b.resolve('b');
  gates.c.resolve('c');
  assert.deepEqual(await Promise.all([a, b, c]), ['a', 'b', 'c']);
  assert.equal(scheduler.snapshot().active, 0);
});

test('onQueued fires only for tasks that wait; onStart fires when work begins', async () => {
  const scheduler = new TaskScheduler({ maxConcurrency: 1 });
  const events = [];
  const gate = deferred();

  const first = scheduler.run('A', () => gate.promise, {
    onQueued: () => events.push('queued:A'),
    onStart: () => events.push('start:A'),
  });
  const second = scheduler.run('B', () => 'b', {
    onQueued: () => events.push('queued:B'),
    onStart: () => events.push('start:B'),
  });

  await flush();
  assert.deepEqual(events, ['start:A', 'queued:B']);

  gate.resolve('a');
  await flush();
  assert.deepEqual(events, ['start:A', 'queued:B', 'start:B']);
  assert.equal(await first, 'a');
  assert.equal(await second, 'b');
});

test('an already-aborted signal rejects without queueing or running', async () => {
  const scheduler = new TaskScheduler();
  const controller = new AbortController();
  controller.abort();
  let operationCalls = 0;
  let queuedCalls = 0;

  await assert.rejects(
    scheduler.run(
      'ws',
      () => {
        operationCalls += 1;
      },
      {
        signal: controller.signal,
        onQueued: () => {
          queuedCalls += 1;
        },
      },
    ),
    (error) => {
      if (controller.signal.reason !== undefined) {
        assert.equal(error, controller.signal.reason);
      } else {
        assert.equal(error.name, 'AbortError');
      }
      return true;
    },
  );

  assert.equal(operationCalls, 0);
  assert.equal(queuedCalls, 0);
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 4, active: 0, pending: 0 });
});

test('aborting a queued task removes it and it never runs', async () => {
  const scheduler = new TaskScheduler({ maxConcurrency: 1 });
  const gate = deferred();
  const controller = new AbortController();
  let cancelledCalls = 0;

  const running = scheduler.run('K1', () => gate.promise);
  const queued = scheduler.run(
    'K2',
    () => {
      cancelledCalls += 1;
      return 'never';
    },
    { signal: controller.signal },
  );

  await flush();
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 1, active: 1, pending: 1 });

  controller.abort();
  await assert.rejects(queued, (error) => {
    if (controller.signal.reason !== undefined) {
      assert.equal(error, controller.signal.reason);
    } else {
      assert.equal(error.name, 'AbortError');
    }
    return true;
  });

  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 1, active: 1, pending: 0 });

  gate.resolve('done');
  assert.equal(await running, 'done');
  await flush();
  assert.equal(cancelledCalls, 0);
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 1, active: 0, pending: 0 });
});

test('aborting a running task keeps capacity until the operation settles', async () => {
  const scheduler = new TaskScheduler({ maxConcurrency: 1 });
  const controller = new AbortController();
  const gate = deferred();
  const nextGate = deferred();
  let sawAbort = false;

  const running = scheduler.run(
    'K',
    () => {
      controller.signal.addEventListener('abort', () => {
        sawAbort = true;
      });
      return gate.promise;
    },
    { signal: controller.signal },
  );
  const next = scheduler.run('J', () => nextGate.promise);

  await flush();
  controller.abort();
  await flush();
  assert.equal(sawAbort, true);
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 1, active: 1, pending: 1 });

  gate.resolve('finished');
  await flush();
  assert.equal(await running, 'finished');
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 1, active: 1, pending: 0 });

  nextGate.resolve('next');
  assert.equal(await next, 'next');
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 1, active: 0, pending: 0 });
});

test('aborting after a queued task has started does not affect it', async () => {
  const scheduler = new TaskScheduler({ maxConcurrency: 1 });
  const controller = new AbortController();
  const gateA = deferred();
  const gateB = deferred();

  const a = scheduler.run('A', () => gateA.promise);
  const b = scheduler.run('B', () => gateB.promise, { signal: controller.signal });

  await flush();
  gateA.resolve('a');
  await flush();
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 1, active: 1, pending: 0 });

  controller.abort();
  await flush();
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 1, active: 1, pending: 0 });

  gateB.resolve('b');
  assert.equal(await b, 'b');
  assert.equal(await a, 'a');
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 1, active: 0, pending: 0 });
});

test('synchronous throws and rejections release capacity for the next task', async () => {
  const scheduler = new TaskScheduler({ maxConcurrency: 1 });
  const boom = new Error('boom');

  const throwing = scheduler.run('A', () => {
    throw boom;
  });
  const rejecting = scheduler.run('B', () => Promise.reject(boom));
  const recovered = scheduler.run('C', () => 'ok');

  await rejectsWith(throwing, boom);
  await rejectsWith(rejecting, boom);
  assert.equal(await recovered, 'ok');
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 1, active: 0, pending: 0 });
});

test('a throwing onStart rejects the task without leaking capacity', async () => {
  const scheduler = new TaskScheduler({ maxConcurrency: 1 });
  const boom = new Error('onStart failed');
  let operationCalls = 0;

  const first = scheduler.run(
    'A',
    () => {
      operationCalls += 1;
      return 'unreachable';
    },
    {
      onStart: () => {
        throw boom;
      },
    },
  );
  const second = scheduler.run('B', () => 'ok');

  await rejectsWith(first, boom);
  assert.equal(operationCalls, 0);
  assert.equal(await second, 'ok');
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 1, active: 0, pending: 0 });
});

test('a throwing onQueued rejects the task without leaving it queued', async () => {
  const scheduler = new TaskScheduler({ maxConcurrency: 1 });
  const gate = deferred();
  const boom = new Error('onQueued failed');
  let operationCalls = 0;

  const running = scheduler.run('A', () => gate.promise);
  const queued = scheduler.run(
    'B',
    () => {
      operationCalls += 1;
      return 'unreachable';
    },
    {
      onQueued: () => {
        throw boom;
      },
    },
  );

  await rejectsWith(queued, boom);
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 1, active: 1, pending: 0 });

  gate.resolve('done');
  assert.equal(await running, 'done');
  await flush();
  assert.equal(operationCalls, 0);
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 1, active: 0, pending: 0 });
});

test('close rejects queued and future tasks but leaves running tasks running', async () => {
  const scheduler = new TaskScheduler({ maxConcurrency: 1 });
  const gate = deferred();
  const reason = new Error('shutting down');

  const running = scheduler.run('A', () => gate.promise);
  const queuedB = scheduler.run('B', () => 'b');
  const queuedC = scheduler.run('C', () => 'c');

  await flush();
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 1, active: 1, pending: 2 });

  scheduler.close(reason);
  await rejectsWith(queuedB, reason);
  await rejectsWith(queuedC, reason);
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 1, active: 1, pending: 0 });

  await rejectsWith(scheduler.run('D', () => 'd'), reason);
  assert.equal(scheduler.snapshot().active, 1);

  gate.resolve('a');
  assert.equal(await running, 'a');
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 1, active: 0, pending: 0 });

  scheduler.close(new Error('second close'));
  await rejectsWith(scheduler.run('E', () => 'e'), reason);
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 1, active: 0, pending: 0 });
});

test('close without a reason still rejects with an Error', async () => {
  const scheduler = new TaskScheduler({ maxConcurrency: 1 });
  const gate = deferred();
  const running = scheduler.run('A', () => gate.promise);
  const queued = scheduler.run('B', () => 'b');

  await flush();
  scheduler.close();
  await assert.rejects(queued, (error) => {
    assert.equal(error instanceof Error, true);
    return true;
  });
  await assert.rejects(scheduler.run('C', () => 'c'), (error) => {
    assert.equal(error instanceof Error, true);
    return true;
  });

  gate.resolve('a');
  assert.equal(await running, 'a');
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 1, active: 0, pending: 0 });
});

test('operations are invoked with no arguments and slots survive many settles', async () => {
  const scheduler = new TaskScheduler({ maxConcurrency: 2 });
  const argumentCounts = [];
  const tasks = [];

  for (let i = 0; i < 20; i += 1) {
    tasks.push(
      scheduler.run(`k${i % 3}`, (...args) => {
        argumentCounts.push(args.length);
        return Promise.resolve(i);
      }),
    );
  }

  assert.deepEqual(await Promise.all(tasks), Array.from({ length: 20 }, (_, i) => i));
  assert.deepEqual(new Set(argumentCounts), new Set([0]));
  assert.deepEqual(scheduler.snapshot(), { maxConcurrency: 2, active: 0, pending: 0 });
});
