import assert from "node:assert/strict";
import test from "node:test";

/**
 * Replicates the main.js poll-offset policy: Telegram getUpdates must use the
 * last committed offset while work is in flight, and duplicate update_ids are
 * skipped via an in-flight set.
 *
 * Request timeouts also surface as AbortError (AbortSignal.timeout). Those must
 * still markProcessed so the ordered commit queue cannot wedge. Only a true
 * shutdown abort withholds the ACK.
 */
function createPollHarness(options = {}) {
  const state = { offset: options.initialOffset ?? 10 };
  const pendingCommits = [];
  const inFlightUpdateIds = new Set();
  const pollOffsets = [];
  let commitQueue = Promise.resolve();
  let stopping = options.stopping ?? false;
  let shutdownAborted = options.shutdownAborted ?? false;

  function markProcessed(record) {
    record.processed = true;
    commitQueue = commitQueue.then(async () => {
      while (pendingCommits[0]?.processed) {
        const completed = pendingCommits.shift();
        state.offset = completed.offset;
      }
    });
    return commitQueue;
  }

  function isShutdownAbort() {
    return stopping || shutdownAborted;
  }

  async function pollOnce(updates) {
    const pollOffset = state.offset;
    pollOffsets.push(pollOffset);
    let scheduled = 0;
    const tasks = [];
    for (const update of updates) {
      if (inFlightUpdateIds.has(update.update_id)) continue;
      inFlightUpdateIds.add(update.update_id);
      const record = { offset: update.update_id + 1, processed: false, updateId: update.update_id };
      pendingCommits.push(record);
      scheduled += 1;
      let release;
      let reject;
      const gate = new Promise((resolve, rev) => {
        release = resolve;
        reject = rev;
      });
      const task = gate.then(
        () => markProcessed(record),
        (error) => {
          if (isShutdownAbort(error)) return;
          return markProcessed(record);
        },
      ).finally(() => {
        inFlightUpdateIds.delete(update.update_id);
      });
      tasks.push({ task, release, reject, record });
    }
    return { scheduled, tasks };
  }

  return {
    state,
    pendingCommits,
    inFlightUpdateIds,
    pollOffsets,
    get commitQueue() {
      return commitQueue;
    },
    pollOnce,
    setStopping(value) {
      stopping = value;
    },
    setShutdownAborted(value) {
      shutdownAborted = value;
    },
  };
}

test("does not advance Telegram poll offset past uncommitted updates", async () => {
  const h = createPollHarness();

  const first = await h.pollOnce([{ update_id: 10 }, { update_id: 11 }]);
  assert.equal(first.scheduled, 2);
  assert.equal(h.state.offset, 10);
  assert.deepEqual(h.pollOffsets, [10]);

  // Second poll while both are still in flight must still use committed offset.
  const second = await h.pollOnce([{ update_id: 10 }, { update_id: 11 }, { update_id: 12 }]);
  assert.equal(second.scheduled, 1); // only 12 is new
  assert.equal(h.state.offset, 10);
  assert.deepEqual(h.pollOffsets, [10, 10]);

  // Finish update 10 then 11; offset walks forward in order.
  first.tasks[0].release();
  await first.tasks[0].task;
  assert.equal(h.state.offset, 11);
  first.tasks[1].release();
  await first.tasks[1].task;
  assert.equal(h.state.offset, 12);

  second.tasks[0].release();
  await second.tasks[0].task;
  await h.commitQueue;
  assert.equal(h.state.offset, 13);

  const third = await h.pollOnce([]);
  assert.deepEqual(h.pollOffsets.at(-1), 13);
  assert.equal(third.scheduled, 0);
});

test("request-timeout AbortError still commits offset (does not wedge)", async () => {
  const h = createPollHarness();
  const first = await h.pollOnce([{ update_id: 10 }, { update_id: 11 }]);

  // Simulate HTTP/request timeout: AbortError while shutdown is NOT aborted.
  const timeoutErr = new Error("The operation was aborted due to timeout");
  timeoutErr.name = "AbortError";
  first.tasks[0].reject(timeoutErr);
  await first.tasks[0].task;
  assert.equal(h.state.offset, 11, "timeout AbortError must markProcessed");
  assert.equal(h.inFlightUpdateIds.has(10), false);

  first.tasks[1].release();
  await first.tasks[1].task;
  await h.commitQueue;
  assert.equal(h.state.offset, 12);
});

test("shutdown AbortError withholds ACK so restart can reclaim", async () => {
  const h = createPollHarness();
  const first = await h.pollOnce([{ update_id: 10 }]);
  h.setStopping(true);
  h.setShutdownAborted(true);

  const abortErr = new Error("Aborted");
  abortErr.name = "AbortError";
  first.tasks[0].reject(abortErr);
  await first.tasks[0].task;
  await h.commitQueue;

  assert.equal(h.state.offset, 10, "shutdown must not advance committed offset");
  assert.equal(first.tasks[0].record.processed, false);
  assert.equal(h.pendingCommits.length, 1);
});
