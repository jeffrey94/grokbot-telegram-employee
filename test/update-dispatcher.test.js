import assert from "node:assert/strict";
import test from "node:test";

import { UpdateDispatcher } from "../src/update-dispatcher.js";

test("processes approval callbacks while the chat prompt is still waiting", async () => {
  let releaseMessage;
  const events = [];
  const bridge = {
    handleUpdate: async () => {
      events.push("message-start");
      await new Promise((resolve) => { releaseMessage = resolve; });
      events.push("message-end");
    },
    handleCallbackQuery: async () => { events.push("callback"); },
    handleError: async () => {},
    handleCallbackError: async () => {},
  };
  const dispatcher = new UpdateDispatcher(bridge);
  const messageTask = dispatcher.dispatch({ message: { chat: { id: 99 } } });
  await new Promise((resolve) => setImmediate(resolve));
  await dispatcher.dispatch({ callback_query: { id: "c1" } });
  assert.deepEqual(events, ["message-start", "callback"]);
  releaseMessage();
  await messageTask;
  await dispatcher.drain();
  assert.deepEqual(events, ["message-start", "callback", "message-end"]);
});

test("topic-routed updates use their own queue so they do not block the chat queue", async () => {
  let releaseSlow;
  const order = [];
  const bridge = {
    queueKeyForUpdate: (update) => update.key,
    handleUpdate: async (update) => {
      if (update.slow) await new Promise((resolve) => { releaseSlow = resolve; });
      order.push(update.update_id);
    },
    handleError: async () => {},
  };
  const dispatcher = new UpdateDispatcher(bridge);
  const slow = dispatcher.dispatch({ update_id: 1, key: "-1001:agent:x", slow: true, message: { chat: { id: -1001 } } });
  await dispatcher.dispatch({ update_id: 2, key: "-1001", message: { chat: { id: -1001 } } });
  assert.deepEqual(order, [2]);
  releaseSlow();
  await slow;
  assert.deepEqual(order, [2, 1]);
});
