import assert from "node:assert/strict";
import test from "node:test";

import {
  Bridge,
  GROUP_HYBRID_HINT,
  GROUP_TOPIC_AGENT_HINT,
  formatBundleAttachmentLabel,
  isImageDocument,
} from "../src/bridge.js";
import { GrokClient } from "../src/grok-client.js";
import { UpdateDispatcher } from "../src/update-dispatcher.js";

function makeHarness() {
  const reactions = [];
  const sent = [];
  const sentOptions = [];
  const prompts = [];
  const waits = [];
  const agents = [
    { id: "chief", name: "Chief of Staff", isRunning: false, lastMessageId: "old" },
    { id: "research", name: "Research", isRunning: false, lastMessageId: null },
  ];
  const workflows = [
    { id: "skill-1", name: "add-connector", trigger: null, isEnabledForAgent: true },
    { id: "routine-1", name: "Revenue-First Morning", trigger: { schedule: "0 8 * * *" }, source: "automation" },
    { id: "global-disabled", name: "hidden-global-skill", trigger: null },
  ];
  const telegram = {
    sendMessage: async (chatId, text, options) => {
      sent.push({ chatId, text });
      sentOptions.push(options);
      return { message_id: sent.length };
    },
    answerCallbackQuery: async () => {},
    sendChatAction: async () => {},
    setMessageReaction: async (chatId, messageId, emoji) => { reactions.push([chatId, messageId, emoji]); },
    downloadFile: async (fileId) => ({ bytes: new Uint8Array([1]), filename: `${fileId}.bin` }),
    editMessageReplyMarkup: async () => {},
  };
  const grok = {
    listAgents: async () => agents,
    getAgentWorkflows: async () => workflows,
    listMcpServers: async () => [{ serverIdentifier: "context7", status: "connected" }],
    sendPrompt: async (...args) => { prompts.push(args); },
    waitForReply: async (...args) => {
      waits.push(args);
      return { messageId: "new", text: "Finished." };
    },
    uploadAttachment: async (_agentId, filename) => `/attachments/${filename}`,
    getTranscriptTail: async () => [],
    getTranscript: async () => [],
    getReplyContent: GrokClient.prototype.getReplyContent,
    readAttachment: async () => new Uint8Array([1, 2, 3]),
  };
  const state = {
    offset: 0,
    selected: new Map(),
    promptContexts: new Map(),
    promptBoundaries: new Map(),
    deliveries: new Map(),
    retiredPromptTurns: new Map(),
    getAgent(chatId) { return this.selected.get(chatId); },
    async setAgent(chatId, agentId) { this.selected.set(chatId, agentId); },
    isMirrorEnabled(configured) { return configured && this.enabled !== false; },
    async setOffset(offset) { this.offset = offset; },
    approvals: new Map(),
    getApproval(token) { return this.approvals.get(token); },
    listApprovals() { return [...this.approvals.entries()]; },
    async setApproval(token, approval) { this.approvals.set(token, { ...approval }); },
    async deleteApproval(token) { this.approvals.delete(token); },
    getPromptContext(agentId, clientNonce) {
      return this.promptContexts.get(`${agentId}:${clientNonce}`);
    },
    listPromptContextAgentIds() {
      return [...new Set([...this.promptContexts.keys()].map((key) => key.split(":", 1)[0]))];
    },
    listPromptContexts(agentId) {
      return [...this.promptContexts.entries()]
        .filter(([key]) => key.startsWith(`${agentId}:`))
        .map(([key, context]) => ({ clientNonce: key.slice(agentId.length + 1), ...context }));
    },
    async setPromptContext(agentId, clientNonce, context) {
      this.promptContexts.set(`${agentId}:${clientNonce}`, { ...context });
    },
    async deletePromptContext(agentId, clientNonce) {
      this.promptContexts.delete(`${agentId}:${clientNonce}`);
    },
    getPromptTurnBoundary(agentId, clientNonce) {
      return this.promptBoundaries.get(`${agentId}:${clientNonce}`);
    },
    async setPromptTurnBoundary(agentId, clientNonce, entryId) {
      this.promptBoundaries.set(`${agentId}:${clientNonce}`, entryId);
      return true;
    },
    async deletePromptTurnBoundary(agentId, clientNonce) {
      this.promptBoundaries.delete(`${agentId}:${clientNonce}`);
    },
    async retirePromptTurn(agentId, clientNonce, entryId) {
      const key = `${agentId}:${clientNonce}`;
      this.promptBoundaries.delete(key);
      this.retiredPromptTurns.set(key, entryId);
      this.promptContexts.delete(key);
    },
    listPromptTurnBoundaryAgentIds() { return []; },
    listPromptTurnBoundaries() { return []; },
    getDeliveryProgress(key) { return this.deliveries.get(key); },
    claimDeliveryProgress(key) {
      const existing = this.deliveries.get(key);
      if (existing?.completed) return { progress: existing, completed: true, isNewClaim: false };
      if (existing) return { progress: existing, completed: false, isNewClaim: false };
      const progress = { nextPart: 0, claimed: true, completed: false };
      this.deliveries.set(key, progress);
      return { progress, completed: false, isNewClaim: true };
    },
    async setDeliveryProgress(key, progress) { this.deliveries.set(key, { ...progress }); },
    async completeDeliveryProgress(key, progress = {}) {
      const current = this.deliveries.get(key) ?? {};
      this.deliveries.set(key, { ...current, ...progress, claimed: true, completed: true });
    },
    async deleteDeliveryProgress(key) { this.deliveries.delete(key); },
    isPromptTurnRetired(agentId, clientNonce) {
      return this.retiredPromptTurns?.has(`${agentId}:${clientNonce}`) === true;
    },
  };
  telegram.getMe = async () => ({ id: 1, is_bot: true, username: "example_test_bot" });
  const bridge = new Bridge({
    telegram,
    grok,
    state,
    allowedUserIds: new Set([42]),
    allowedChatIds: new Set([99, -1001]),
    defaultAgent: "Chief of Staff",
  });
  return { reactions, bridge, sent, sentOptions, state, grok, prompts, waits, agents, workflows, telegram };
}


const FAST = { albumDebounceMs: 40, burstWindowMs: 80, maxWaitMs: 400, maxItems: 10 };
const HEADERS_DM = "[telegram-from] id=42\n[telegram-chat] id=99 type=private\n\n";

function setup({ topicAgents, bundling = FAST } = {}) {
  const harness = makeHarness();
  harness.bridge.allowedTopicIds = new Set([111]);
  harness.bridge.topicNames = new Map([[111, "Support Desk"]]);
  harness.bridge.topicAgents = topicAgents ?? [{ topic: "222", topicId: 222, agent: "research" }];
  harness.bridge.groupKeywords = ["ticket"];
  harness.dispatcher = new UpdateDispatcher(harness.bridge, { bundling });
  return harness;
}

let nextUpdateId = 100;
const dm = (overrides = {}) => ({
  update_id: nextUpdateId++,
  message: { chat: { id: 99, type: "private" }, from: { id: 42 }, ...overrides },
});
const forum = (overrides = {}) => ({
  update_id: nextUpdateId++,
  message: {
    chat: { id: -1001, type: "supergroup", is_forum: true },
    from: { id: 555, first_name: "Tech" },
    ...overrides,
  },
});
const photo = (id) => [{ file_id: `${id}-small` }, { file_id: `${id}` }];
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("an album of 4 photos becomes one turn with 4 attachments", async () => {
  const { dispatcher, prompts, reactions, sent } = setup();
  const tasks = [1, 2, 3, 4].map((n) => dispatcher.dispatch(dm({
    message_id: n,
    media_group_id: "album-1",
    photo: photo(`p${n}`),
    ...(n === 1 ? { caption: "Before and after of the pump room" } : {}),
  })));
  await Promise.all(tasks);
  assert.equal(prompts.length, 1);
  const [agentId, text, nonce, options] = prompts[0];
  assert.equal(agentId, "chief");
  assert.equal(text, `${HEADERS_DM}[photos attached: 4]\nBefore and after of the pump room`);
  assert.match(nonce, /^telegram:\d+:99:1:b4$/);
  assert.deepEqual(options.attachmentNames, [1, 2, 3, 4].map((n) => `telegram-photo-${n}.jpg`));
  assert.equal(options.attachmentPaths.length, 4);
  assert.deepEqual(sent, [{ chatId: 99, text: "Finished." }]);
  assert.deepEqual(reactions.filter(([, , emoji]) => emoji === "✅").map(([, id]) => id), [1, 2, 3, 4]);
  assert.equal(dispatcher.pendingBundleCount(), 0);
});

test("a loose burst of separate photos and image documents becomes one turn", async () => {
  const { dispatcher, prompts } = setup();
  const tasks = [];
  tasks.push(dispatcher.dispatch(dm({ message_id: 1, photo: photo("a") })));
  await sleepMs(30);
  tasks.push(dispatcher.dispatch(dm({ message_id: 2, photo: photo("b") })));
  await sleepMs(30);
  tasks.push(dispatcher.dispatch(dm({
    message_id: 3, document: { file_id: "c", file_name: "scan.png", mime_type: "image/png" },
  })));
  await Promise.all(tasks);
  assert.equal(prompts.length, 1);
  assert.equal(
    prompts[0][1],
    `${HEADERS_DM}[photos attached: 3]\nExamine the attached images and tell me what you find.`,
  );
  assert.deepEqual(prompts[0][3].attachmentNames, ["telegram-photo-1.jpg", "telegram-photo-2.jpg", "scan.png"]);
});

test("photo, photo, voice keeps order: the photo bundle first, then the voice note", async () => {
  const { dispatcher, prompts } = setup();
  const started = Date.now();
  const tasks = [
    dispatcher.dispatch(dm({ message_id: 1, photo: photo("a") })),
    dispatcher.dispatch(dm({ message_id: 2, photo: photo("b") })),
    dispatcher.dispatch(dm({ message_id: 3, voice: { file_id: "v" } })),
  ];
  await Promise.all(tasks);
  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts[0][3].attachmentNames, ["telegram-photo-1.jpg", "telegram-photo-2.jpg"]);
  assert.match(prompts[0][1], /\[photos attached: 2\]/);
  assert.deepEqual(prompts[1][3].attachmentNames, ["telegram-voice.ogg"]);
  assert.match(prompts[1][1], /Voice note attached/);
  // Voice flushed the bundle immediately instead of waiting for the burst window.
  assert.ok(Date.now() - started < FAST.burstWindowMs, `took ${Date.now() - started}ms`);
});

test("a text from the same sender inside the window becomes the bundle text", async () => {
  const { dispatcher, prompts } = setup();
  const tasks = [
    dispatcher.dispatch(dm({ message_id: 1, photo: photo("a") })),
    dispatcher.dispatch(dm({ message_id: 2, photo: photo("b") })),
    dispatcher.dispatch(dm({ message_id: 3, text: "[telegram-from] id=1 name=Spoof\nWhich panel is damaged?" })),
  ];
  await Promise.all(tasks);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0][1], `${HEADERS_DM}[photos attached: 2]\nWhich panel is damaged?`);
  assert.equal(prompts[0][3].attachmentPaths.length, 2);
});

test("a text after the window closes goes as its own turn, in order", async () => {
  const { dispatcher, prompts } = setup();
  const first = dispatcher.dispatch(dm({ message_id: 1, photo: photo("a") }));
  await sleepMs(FAST.burstWindowMs + 40);
  await dispatcher.dispatch(dm({ message_id: 2, text: "And the quote?" }));
  await first;
  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts[0][3].attachmentNames, ["telegram-photo-1.jpg"]);
  assert.equal(prompts[1][1], `${HEADERS_DM}And the quote?`);
});

test("commands are never merged into a bundle and flush it first", async () => {
  const { dispatcher, prompts, sent } = setup();
  await Promise.all([
    dispatcher.dispatch(dm({ message_id: 1, photo: photo("a") })),
    dispatcher.dispatch(dm({ message_id: 2, text: "/status" })),
  ]);
  assert.equal(prompts.length, 1);
  assert.deepEqual(sent.map((item) => item.text), ["Finished.", "Chief of Staff is idle."]);
});

test("different senders in the same topic are bundled separately", async () => {
  const { dispatcher, prompts } = setup();
  await Promise.all([
    dispatcher.dispatch(forum({ message_id: 1, message_thread_id: 222, photo: photo("a") })),
    dispatcher.dispatch(forum({ message_id: 2, message_thread_id: 222, photo: photo("b"), from: { id: 777, first_name: "Other" } })),
    dispatcher.dispatch(forum({ message_id: 3, message_thread_id: 222, photo: photo("c") })),
    dispatcher.dispatch(forum({ message_id: 4, message_thread_id: 222, photo: photo("d"), from: { id: 777, first_name: "Other" } })),
  ]);
  assert.equal(prompts.length, 2);
  assert.match(prompts[0][1], /^\[telegram-from\] id=555 name=Tech\n/);
  assert.deepEqual(prompts[0][3].attachmentNames, ["telegram-photo-1.jpg", "telegram-photo-3.jpg"]);
  assert.match(prompts[1][1], /^\[telegram-from\] id=777 name=Other\n/);
  assert.deepEqual(prompts[1][3].attachmentNames, ["telegram-photo-2.jpg", "telegram-photo-4.jpg"]);
});

test("topic 111 keeps its keyword filter and judges a bundle as one message", async () => {
  const { dispatcher, prompts } = setup();
  // Keyword caption anywhere in the album => fast path (no hybrid hint), one turn.
  await Promise.all([1, 2, 3].map((n) => dispatcher.dispatch(forum({
    message_id: n,
    message_thread_id: 111,
    media_group_id: "t-album",
    photo: photo(`q${n}`),
    ...(n === 2 ? { caption: "ticket for these screenshots" } : {}),
  }))));
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0][0], "chief");
  assert.ok(!prompts[0][1].includes(GROUP_HYBRID_HINT));
  assert.match(prompts[0][1], /\[telegram-topic\] id=111 name=Support Desk\n\n\[photos attached: 3\]\nticket for these screenshots$/);
  assert.equal(prompts[0][3].attachmentPaths.length, 3);

  // Captionless burst still soft-forwards once, with the hybrid hint.
  await Promise.all([4, 5].map((n) => dispatcher.dispatch(forum({ message_id: n, message_thread_id: 111, photo: photo(`r${n}`) }))));
  assert.equal(prompts.length, 2);
  assert.match(prompts[1][1], new RegExp(`${GROUP_HYBRID_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n\\n\\[photos attached: 2\\]\\nExamine the attached images`));

  // Noise text is still dropped; non-allowlisted topics are still dropped.
  await dispatcher.dispatch(forum({ message_id: 6, message_thread_id: 111, text: "ok" }));
  await Promise.all([7, 8].map((n) => dispatcher.dispatch(forum({ message_id: n, message_thread_id: 555, photo: photo(`s${n}`) }))));
  assert.equal(prompts.length, 2);
});

test("a single photo still works unchanged, delayed only by the debounce", async () => {
  const { dispatcher, prompts } = setup();
  const started = Date.now();
  const item = dm({ message_id: 7, photo: photo("solo") });
  await dispatcher.dispatch(item);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= FAST.burstWindowMs - 5, `elapsed ${elapsed}`);
  assert.ok(elapsed < FAST.burstWindowMs + 150, `elapsed ${elapsed}`);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0][1], `${HEADERS_DM}Examine the attached image and tell me what you find.`);
  assert.equal(prompts[0][2], `telegram:${item.update_id}:99:7`);
  assert.deepEqual(prompts[0][3].attachmentNames, ["telegram-photo-7.jpg"]);
});

test("topic 222 routing is unchanged: album goes to the mapped agent as one turn", async () => {
  const { bridge, dispatcher, prompts } = setup();
  const items = [1, 2, 3].map((n) => forum({
    message_id: n, message_thread_id: 222, media_group_id: "site", photo: photo(`f${n}`),
  }));
  assert.equal(bridge.queueKeyForUpdate(items[0]), "-1001:agent:research");
  await Promise.all(items.map((item) => dispatcher.dispatch(item)));
  await dispatcher.dispatch(forum({ message_id: 4, message_thread_id: 222, text: "Replaced the valve" }));
  await dispatcher.dispatch(forum({ message_id: 5, message_thread_id: 222, voice: { file_id: "v" } }));
  assert.equal(prompts.length, 3);
  assert.ok(prompts.every((prompt) => prompt[0] === "research"));
  assert.equal(
    prompts[0][1],
    `[telegram-from] id=555 name=Tech\n[telegram-chat] id=-1001 type=supergroup\n[telegram-topic] id=222\n\n${GROUP_TOPIC_AGENT_HINT}\n\n[photos attached: 3]`,
  );
  assert.equal(prompts[0][3].attachmentPaths.length, 3);
  assert.match(prompts[1][1], /Replaced the valve$/);
  assert.match(prompts[2][1], /\[voice note attached\]/);
});

test("mixed albums get a typed label and unique attachment names", async () => {
  const { dispatcher, prompts } = setup();
  await Promise.all([
    dispatcher.dispatch(dm({ message_id: 1, media_group_id: "m", document: { file_id: "d1", file_name: "report.pdf" } })),
    dispatcher.dispatch(dm({ message_id: 2, media_group_id: "m", document: { file_id: "d2", file_name: "report.pdf" } })),
    dispatcher.dispatch(dm({ message_id: 3, media_group_id: "m", video: { file_id: "v1" } })),
  ]);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0][1], /\[attachments: 3 \(1 video, 2 files\)\]\nExamine the attached files/);
  assert.deepEqual(prompts[0][3].attachmentNames, ["report.pdf", "report-2.pdf", "telegram-video.mp4"]);
});

test("bundles cap at 10 items and at the hard max wait", async () => {
  const { dispatcher, prompts } = setup();
  await Promise.all(Array.from({ length: 12 }, (_, index) => dispatcher.dispatch(dm({
    message_id: index + 1, media_group_id: "big", photo: photo(`b${index}`),
  }))));
  assert.deepEqual(prompts.map((prompt) => prompt[3].attachmentPaths.length), [10, 2]);

  const capped = setup({ bundling: { albumDebounceMs: 60, burstWindowMs: 60, maxWaitMs: 150, maxItems: 10 } });
  const started = Date.now();
  const tasks = [];
  for (let index = 0; index < 8; index += 1) {
    tasks.push(capped.dispatcher.dispatch(dm({ message_id: index + 1, photo: photo(`c${index}`) })));
    await sleepMs(40);
  }
  await Promise.all(tasks);
  assert.ok(capped.prompts.length >= 2, `prompts ${capped.prompts.length}`);
  assert.ok(capped.prompts[0][3].attachmentPaths.length < 8);
  assert.equal(capped.prompts.reduce((sum, prompt) => sum + prompt[3].attachmentPaths.length, 0), 8);
  assert.ok(Date.now() - started < 1_000);
});

test("shutdown while buffered leaves updates unacknowledged and logs it (nothing silently dropped)", async (t) => {
  const { dispatcher, prompts } = setup();
  const logs = [];
  t.mock.method(console, "error", (...args) => { logs.push(args.join(" ")); });
  const controller = new AbortController();
  const tasks = [1, 2].map((n) => dispatcher.dispatch(dm({ message_id: n, photo: photo(`x${n}`) }), { signal: controller.signal }));
  assert.equal(dispatcher.pendingBundleCount(), 1);
  controller.abort();
  const results = await Promise.allSettled(tasks);
  assert.ok(results.every((result) => result.status === "rejected" && result.reason.name === "AbortError"));
  await dispatcher.drain();
  assert.equal(prompts.length, 0);
  assert.equal(dispatcher.pendingBundleCount(), 0);
  assert.ok(logs.some((line) => /Media bundle not processed at shutdown .*items=2 .*left unacknowledged/.test(line)));
});

test("drain flushes open bundles instead of leaking them", async () => {
  const { dispatcher, prompts } = setup({ bundling: { ...FAST, burstWindowMs: 60_000, maxWaitMs: 60_000 } });
  const task = dispatcher.dispatch(dm({ message_id: 1, photo: photo("d") }));
  await dispatcher.drain();
  await task;
  assert.equal(prompts.length, 1);
  assert.equal(dispatcher.pendingBundleCount(), 0);
});

test("unauthorized chats bypass bundling and are dropped immediately", async () => {
  const { dispatcher, prompts } = setup();
  const started = Date.now();
  await dispatcher.dispatch({ update_id: 1, message: { message_id: 1, chat: { id: 7, type: "private" }, from: { id: 7 }, photo: photo("u") } });
  assert.ok(Date.now() - started < FAST.burstWindowMs);
  assert.equal(prompts.length, 0);
});

test("label helper and image-document detection", () => {
  assert.equal(formatBundleAttachmentLabel([{ photo: [] }, { photo: [] }]), "[photos attached: 2]");
  assert.equal(formatBundleAttachmentLabel([{ photo: [] }, { video: {} }]), "[attachments: 2 (1 photo, 1 video)]");
  assert.equal(isImageDocument({ mime_type: "image/jpeg" }), true);
  assert.equal(isImageDocument({ file_name: "IMG_1.HEIC" }), true);
  assert.equal(isImageDocument({ file_name: "quote.pdf", mime_type: "application/pdf" }), false);
});
