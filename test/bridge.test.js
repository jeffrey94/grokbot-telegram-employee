import assert from "node:assert/strict";
import test from "node:test";

import {
  Bridge,
  GROUP_HYBRID_HINT,
  GROUP_NOISE_EXACT,
  effectiveForumTopicId,
  formatTelegramSenderHeader,
  formatTelegramTopicHeader,
  formatTelegramChatHeader,
  GROUP_TOPIC_AGENT_HINT,
  isForwardedTelegramMessage,
  stripTelegramContextHeaders,
  DEFAULT_GROUP_KEYWORDS,
  buildGroupHybridHint,
  normalizeGroupKeywords,
  isGroupNoiseMessage,
  stripTranscriptPreamble,
  isGroupNoiseText,
  isRetryableAttachmentReadError,
  isSilentTelegramReply,
  isTelegramOriginContext,
  resolveTelegramTopicName,
} from "../src/bridge.js";
import { GrokClient } from "../src/grok-client.js";

// Example fast-path keywords used by the group tests (TELEGRAM_GROUP_KEYWORDS).
const TEST_GROUP_KEYWORDS = ["ticket", "help desk", "工单"];

function makeHarness() {
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
    groupKeywords: TEST_GROUP_KEYWORDS,
  });
  return { bridge, sent, sentOptions, state, grok, prompts, waits, agents, workflows, telegram };
}

const update = (text, overrides = {}) => ({
  update_id: 10,
  message: {
    text,
    chat: { id: 99, type: "private" },
    from: { id: 42 },
    ...overrides,
  },
});

test("formats Telegram sender headers from complete and partial identities", () => {
  assert.equal(
    formatTelegramSenderHeader({ id: 424242, first_name: " Alex", last_name: "Tester ", username: "@alextest" }),
    "[telegram-from] id=424242 name=Alex Tester username=@alextest",
  );
  assert.equal(
    formatTelegramSenderHeader({ id: 7, first_name: "Alex" }),
    "[telegram-from] id=7 name=Alex",
  );
  assert.equal(formatTelegramSenderHeader({}), "");
});

test("group prompts include the live sender header once", async () => {
  const { bridge, prompts } = makeHarness();
  await bridge.handleUpdate(update("Please open a ticket", {
    chat: { id: -1001, type: "supergroup" },
    from: { id: 424242, first_name: "Alex", last_name: "Tester", username: "alextest" },
  }));
  assert.equal(
    prompts[0][1],
    "[telegram-from] id=424242 name=Alex Tester username=@alextest\n[telegram-chat] id=-1001 type=supergroup\n\nPlease open a ticket",
  );
});

test("silently ignores unauthorized users and chats", async () => {
  const { bridge, sent } = makeHarness();
  await bridge.handleUpdate(update("hello", { from: { id: 7 } }));
  await bridge.handleUpdate(update("hello", { chat: { id: 7, type: "private" } }));
  // Allowlisted group soft-forwards non-noise; unauthorized group chat must still drop.
  await bridge.handleUpdate(update("hello", { chat: { id: -9999, type: "group" }, from: { id: 42 } }));
  assert.deepEqual(sent, []);
});

test("sends ordinary text with a deterministic nonce and waits for its reply", async () => {
  const { bridge, sent, grok, prompts, waits } = makeHarness();
  grok.getAgentWorkflows = async () => { throw new Error("ordinary prompts must not depend on workflow discovery"); };
  await bridge.handleUpdate(update("Please summarize today."));
  assert.deepEqual(sent, [{ chatId: 99, text: "Finished." }]);
  assert.deepEqual(prompts[0].slice(0, 3), ["chief", "[telegram-from] id=42\n[telegram-chat] id=99 type=private\n\nPlease summarize today.", "telegram:10:99:0"]);
  assert.deepEqual(waits[0].slice(0, 2), ["chief", "telegram:10:99:0"]);
});

test("lists and selects agents", async () => {
  const { bridge, sent, state } = makeHarness();
  await bridge.handleUpdate(update("/agents"));
  await bridge.handleUpdate(update("/use Research"));

  assert.match(sent[0].text, /Chief of Staff/);
  assert.match(sent[0].text, /Research/);
  assert.equal(state.getAgent(99), "research");
  assert.match(sent[1].text, /Research/);
});

test("lists live skills and runs a native slash-named skill with rich text", async () => {
  const { bridge, sent, prompts, workflows } = makeHarness();
  for (let index = 0; index < 25; index += 1) {
    workflows.push({ id: `enabled-${index}`, name: `enabled-skill-${index}`, trigger: null, isEnabledForAgent: true });
  }
  await bridge.handleUpdate(update("/skills"));
  assert.match(sent[0].text, /add-connector/);
  assert.doesNotMatch(sent[0].text, /Revenue-First Morning/);
  assert.doesNotMatch(sent[0].text, /hidden-global-skill/);
  assert.match(sent[0].text, /Showing 20 of 26/);

  await bridge.handleUpdate(update("/skills enabled-skill-24"));
  assert.match(sent[1].text, /enabled-skill-24/);
  assert.doesNotMatch(sent[1].text, /Showing 20/);

  await bridge.handleUpdate(update("/add-connector Set up Linear"));
  assert.equal(prompts[0][1], "[telegram-from] id=42\n[telegram-chat] id=99 type=private\n\n@add-connector Set up Linear");
  const skillNodes = JSON.parse(prompts[0][3].richText).content
    .flatMap((paragraph) => paragraph.content ?? []);
  assert.deepEqual(skillNodes.find((node) => node.type === "workflowReference"), {
    type: "workflowReference",
    attrs: { id: "skill-1", label: "add-connector", iconId: null, iconUrl: null },
  });
});

test("runs a skill through /run and reports an unknown exact name", async () => {
  const { bridge, sent, prompts } = makeHarness();
  await bridge.handleUpdate(update("/run add-connector Connect Slack"));
  assert.equal(prompts[0][1], "[telegram-from] id=42\n[telegram-chat] id=99 type=private\n\n@add-connector Connect Slack");

  await bridge.handleUpdate(update("/run missing-skill"));
  assert.match(sent.at(-1).text, /No exact skill-name match/);
});

test("lists routines and box plugin status without hard-coded names", async () => {
  const { bridge, sent } = makeHarness();
  await bridge.handleUpdate(update("/routines"));
  await bridge.handleUpdate(update("/plugins"));
  assert.match(sent[0].text, /Revenue-First Morning/);
  assert.match(sent[1].text, /context7.*connected/i);
});

test("turns exact agent and routine @ references into Grok composer nodes", async () => {
  const { bridge, prompts } = makeHarness();
  await bridge.handleUpdate(update("Ask @Research to check @Revenue-First Morning."));
  const richText = JSON.parse(prompts[0][3].richText);
  assert.deepEqual(richText.content.flatMap((paragraph) => paragraph.content ?? [])
    .filter((node) => node.type !== "text"), [
    { type: "mention", attrs: { id: "research", label: "Research" } },
    {
      type: "workflowReference",
      attrs: { id: "routine-1", label: "Revenue-First Morning", iconId: null, iconUrl: null },
    },
  ]);
});

test("leaves ambiguous @ labels as plain text instead of guessing an ID", async () => {
  const { bridge, agents, workflows, prompts } = makeHarness();
  agents.push({ id: "shared-agent", name: "Shared" });
  workflows.push({ id: "shared-routine", name: "Shared", trigger: { schedule: "daily" }, source: "automation" });
  await bridge.handleUpdate(update("Ask @Shared."));
  assert.equal(prompts[0][3].richText, undefined);
});

test("uploads the largest Telegram photo and sends it through Grok's native attachment path", async () => {
  const { bridge, sent, prompts } = makeHarness();
  bridge.telegram.downloadFile = async () => ({ bytes: new Uint8Array([1, 2, 3]), filename: "photo.jpg" });
  await bridge.handleUpdate(update(undefined, { photo: [{ file_id: "x" }] }));
  assert.equal(sent[0].text, "Finished.");
  assert.deepEqual(prompts[0][3].attachmentPaths, ["/attachments/telegram-photo-upload.jpg"]);
  assert.deepEqual(prompts[0][3].attachmentNames, ["telegram-photo-upload.jpg"]);
});

test("rejects empty unsupported messages", async () => {
  const { bridge, sent } = makeHarness();
  await bridge.handleUpdate(update(undefined));
  assert.match(sent[0].text, /photo/i);
});

test("stripTranscriptPreamble removes Transcript label for Telegram users", () => {
  assert.equal(
    stripTranscriptPreamble("Transcript: 嘿你可以帮我做一个决定吗？\n\n可以啊，Alex。你告诉我要决定什么。"),
    "可以啊，Alex。你告诉我要决定什么。",
  );
  assert.equal(
    stripTranscriptPreamble("Transcript: hello\nSure, I can help."),
    "Sure, I can help.",
  );
  assert.equal(stripTranscriptPreamble("Normal reply with no transcript."), "Normal reply with no transcript.");
});

test("asks Grok to transcribe a captionless voice note", async () => {
  const { bridge, prompts } = makeHarness();
  bridge.telegram.downloadFile = async () => ({ bytes: new Uint8Array([1]), filename: "voice.ogg" });
  await bridge.handleUpdate(update(undefined, { voice: { file_id: "voice" } }));
  assert.match(prompts[0][1], /Voice note attached/i);
  assert.match(prompts[0][1], /Do NOT install packages/i);
  assert.doesNotMatch(prompts[0][1], /whisper/i);
  assert.match(prompts[0][1], /Do NOT include a Transcript/i);
  assert.deepEqual(prompts[0][3].attachmentNames, ["telegram-voice.ogg"]);
});

test("delivers Grok attachments through Telegram", async () => {
  const { bridge, grok } = makeHarness();
  const delivered = [];
  grok.waitForReply = async () => ({
    messageId: "reply",
    text: "Report attached.",
    attachments: [{ path: "/attachments/report.pdf", filename: "report.pdf" }],
  });
  grok.readAttachment = async () => new Uint8Array([4, 5, 6]);
  bridge.telegram.sendAttachment = async (chatId, attachment, options) => delivered.push({ chatId, attachment, options });
  await bridge.handleUpdate(update("Make a report", { message_id: 77 }));
  assert.equal(delivered[0].attachment.filename, "report.pdf");
  assert.equal(delivered[0].options.replyToMessageId, 77);
});

test("marks failed authorized updates and replies with a safe error", async () => {
  const { bridge, sent } = makeHarness();
  const reactions = [];
  bridge.telegram.setMessageReaction = async (...args) => reactions.push(args);
  await bridge.handleError(update("fail", { message_id: 55 }));
  assert.equal(reactions[0][2], "❌");
  assert.match(sent[0].text, /couldn't finish/i);
});

test("does not silently fall back when a saved agent disappeared", async () => {
  const { bridge, sent, state } = makeHarness();
  state.selected.set(99, "deleted-agent");
  await bridge.handleUpdate(update("hello"));
  assert.match(sent[0].text, /selected agent/);
});

test("offers only Approve once and Deny, then resolves the exact pending request", async () => {
  const { bridge, grok, state, sent, sentOptions } = makeHarness();
  const resolved = [];
  grok.waitForReply = async (_agentId, _nonce, options) => {
    await options.onApproval({
      id: "entry-1",
      kind: "send-message",
      message: {
        type: "auto-review-approval",
        approval: {
          requestId: "request-1",
          status: "pending",
          summary: "Run a command",
          command: "touch /tmp/strict-test",
          reason: "Requested by the user",
        },
      },
    });
    return { messageId: "final", text: "Done." };
  };
  grok.getPendingApproval = async () => ({ message: { type: "auto-review-approval" } });
  grok.resolveAutoReviewApproval = async (...args) => resolved.push(args);

  await bridge.handleUpdate(update("Do it", { message_id: 70 }));
  const buttons = sentOptions[0].inlineKeyboard[0];
  assert.deepEqual(buttons.map((button) => button.text), ["Approve once", "Deny"]);
  assert.match(sent[0].text, /touch \/tmp\/strict-test/);
  const callbackData = buttons[0].callback_data;
  const token = callbackData.split(":")[1];
  assert.ok(state.getApproval(token));

  await bridge.handleCallbackQuery({ callback_query: {
    id: "callback-1",
    data: callbackData,
    from: { id: 42 },
    message: { message_id: 1, chat: { id: 99, type: "private" } },
  } });
  assert.deepEqual(resolved[0].slice(0, 4), ["chief", "entry-1", "request-1", true]);
  assert.equal(state.getApproval(token), undefined);
});

test("rejects an approval callback from a different user without touching Grok", async () => {
  const { bridge, grok, state } = makeHarness();
  let resolved = false;
  grok.resolveLocalToolPermission = async () => { resolved = true; };
  await state.setApproval("abcdefghijklmnopqrstuvwx", {
    type: "local-tool",
    agentId: "chief",
    entryId: "entry",
    requestId: "request",
    chatId: 99,
    userId: 42,
    messageId: 5,
    expiresAt: Date.now() + 60_000,
  });
  await bridge.handleCallbackQuery({ callback_query: {
    id: "callback-2",
    data: "gta:abcdefghijklmnopqrstuvwx:a",
    from: { id: 7 },
    message: { message_id: 5, chat: { id: 99, type: "private" } },
  } });
  assert.equal(resolved, false);
});

test("expires approval buttons without resolving Grok", async () => {
  const { bridge, grok, state } = makeHarness();
  let resolved = false;
  grok.resolveLocalToolPermission = async () => { resolved = true; };
  await state.setApproval("abcdefghijklmnopqrstuvwx", {
    type: "local-tool",
    agentId: "chief",
    entryId: "entry",
    requestId: "request",
    chatId: 99,
    userId: 42,
    messageId: 5,
    expiresAt: Date.now() - 1,
  });
  await bridge.handleCallbackQuery({ callback_query: {
    id: "callback-3",
    data: "gta:abcdefghijklmnopqrstuvwx:a",
    from: { id: 42 },
    message: { message_id: 5, chat: { id: 99, type: "private" } },
  } });
  assert.equal(resolved, false);
  assert.equal(state.getApproval("abcdefghijklmnopqrstuvwx"), undefined);
});

test("rechecks Grok and refuses a stale request", async () => {
  const { bridge, grok, state } = makeHarness();
  let resolved = false;
  grok.getPendingApproval = async () => undefined;
  grok.resolveAutoReviewApproval = async () => { resolved = true; };
  await state.setApproval("abcdefghijklmnopqrstuvwx", {
    type: "auto-review",
    agentId: "chief",
    entryId: "entry",
    requestId: "request",
    chatId: 99,
    userId: 42,
    messageId: 5,
    expiresAt: Date.now() + 60_000,
  });
  await bridge.handleCallbackQuery({ callback_query: {
    id: "callback-4",
    data: "gta:abcdefghijklmnopqrstuvwx:d",
    from: { id: 42 },
    message: { message_id: 5, chat: { id: 99, type: "private" } },
  } });
  assert.equal(resolved, false);
  assert.equal(state.getApproval("abcdefghijklmnopqrstuvwx"), undefined);
});

test("maps a local permission approval to allow once", async () => {
  const { bridge, grok, state } = makeHarness();
  const resolved = [];
  grok.getPendingApproval = async () => ({ message: { type: "local-tool-permission" } });
  grok.resolveLocalToolPermission = async (...args) => resolved.push(args);
  await state.setApproval("abcdefghijklmnopqrstuvwx", {
    type: "local-tool",
    agentId: "chief",
    entryId: "entry",
    requestId: "request",
    chatId: 99,
    userId: 42,
    messageId: 5,
    expiresAt: Date.now() + 60_000,
  });
  await bridge.handleCallbackQuery({ callback_query: {
    id: "callback-5",
    data: "gta:abcdefghijklmnopqrstuvwx:a",
    from: { id: 42 },
    message: { message_id: 5, chat: { id: 99, type: "private" } },
  } });
  assert.deepEqual(resolved[0].slice(0, 4), ["chief", "entry", "request", true]);
});

test("private 1:1 prompts still work after group policy", async () => {
  const { bridge, sent, prompts } = makeHarness();
  await bridge.handleUpdate(update("ping"));
  assert.equal(prompts[0][1], "[telegram-from] id=42\n[telegram-chat] id=99 type=private\n\nping");
  assert.equal(sent[0].text, "Finished.");
});

test("group exact noise without mention is dropped", async () => {
  const { bridge, sent, prompts } = makeHarness();
  await bridge.handleUpdate(update("ok", {
    chat: { id: -1001, type: "group" },
    from: { id: 999 },
  }));
  await bridge.handleUpdate(update("哈哈", {
    chat: { id: -1001, type: "group" },
    from: { id: 999 },
    message_id: 2,
  }));
  assert.deepEqual(sent, []);
  assert.deepEqual(prompts, []);
});

test("group soft-forward sends hybrid hint for non-keyword asks", async () => {
  const { bridge, sent, prompts } = makeHarness();
  await bridge.handleUpdate(update("帮我看看这个问题", {
    chat: { id: -1001, type: "group" },
    from: { id: 999 },
  }));
  assert.equal(prompts.length, 1);
  assert.match(prompts[0][1], /telegram-group-hybrid/);
  assert.match(prompts[0][1], /帮我看看这个问题/);
  assert.ok(prompts[0][1].startsWith(`[telegram-from] id=999\n[telegram-chat] id=-1001 type=group\n\n${GROUP_HYBRID_HINT}`));
  assert.equal(sent[0].text, "Finished.");
});

test("group @mention is accepted and mention stripped before Grok", async () => {
  const { bridge, sent, prompts } = makeHarness();
  const text = "@example_test_bot ping please";
  await bridge.handleUpdate(update(text, {
    chat: { id: -1001, type: "supergroup" },
    from: { id: 999 },
    entities: [{ type: "mention", offset: 0, length: "@example_test_bot".length }],
  }));
  assert.equal(prompts[0][1], "[telegram-from] id=999\n[telegram-chat] id=-1001 type=supergroup\n\nping please");
  assert.equal(sent[0].text, "Finished.");
});

test("group /help is accepted from any member in an allowlisted group", async () => {
  const { bridge, sent, prompts } = makeHarness();
  await bridge.handleUpdate(update("/help", {
    chat: { id: -1001, type: "group" },
    from: { id: 999 },
  }));
  assert.match(sent[0].text, /Send text, photos/);
  assert.deepEqual(prompts, []);
});

test("group message from a non-allowlisted chat id is rejected", async () => {
  const { bridge, sent, prompts } = makeHarness();
  await bridge.handleUpdate(update("/help", {
    chat: { id: -9999, type: "group" },
    from: { id: 42 },
  }));
  await bridge.handleUpdate(update("@example_test_bot hi", {
    chat: { id: -9999, type: "supergroup" },
    from: { id: 42 },
    entities: [{ type: "mention", offset: 0, length: "@example_test_bot".length }],
  }));
  assert.deepEqual(sent, []);
  assert.deepEqual(prompts, []);
});


test("mention-only group ping gets a short ack instead of dying silently", async () => {
  const { bridge, sent, sentOptions, prompts } = makeHarness();
  const text = "@example_test_bot";
  await bridge.handleUpdate(update(text, {
    chat: { id: -1001, type: "supergroup" },
    from: { id: 999 },
    message_id: 501,
    message_thread_id: 42,
    entities: [{ type: "mention", offset: 0, length: text.length }],
  }));
  assert.equal(prompts.length, 0);
  assert.match(sent[0].text, /here/i);
  assert.equal(sentOptions[0].replyToMessageId, 501);
  assert.equal(sentOptions[0].messageThreadId, 42);
});

test("forum topic replies preserve message_thread_id through delivery options", async () => {
  const { bridge, sent, sentOptions, prompts } = makeHarness();
  const text = "@example_test_bot what is up";
  await bridge.handleUpdate(update(text, {
    chat: { id: -1001, type: "supergroup" },
    from: { id: 999 },
    message_id: 777,
    message_thread_id: 99,
    entities: [{ type: "mention", offset: 0, length: "@example_test_bot".length }],
  }));
  assert.equal(prompts[0][1], "[telegram-from] id=999\n[telegram-chat] id=-1001 type=supergroup\n[telegram-topic] id=99\n\nwhat is up");
  assert.equal(sentOptions.at(-1).messageThreadId, 99);
  assert.equal(sent[0].text, "Finished.");
});

test("text_mention by bot id is treated as a bot mention", async () => {
  const { bridge, prompts } = makeHarness();
  await bridge.handleUpdate(update("hey bot", {
    chat: { id: -1001, type: "supergroup" },
    from: { id: 999 },
    entities: [{ type: "text_mention", offset: 0, length: 3, user: { id: 1, is_bot: true } }],
  }));
  // "hey bot" has no @ strip needed for text_mention without @username in text;
  // shouldHandle sees text_mention by bot id
  assert.equal(prompts.length, 1);
});

test("group keyword from TELEGRAM_GROUP_KEYWORDS is accepted without mention", async () => {
  const { bridge, sent, prompts } = makeHarness();
  await bridge.handleUpdate(update("Please open a ticket for Acme", {
    chat: { id: -1001, type: "group" },
    from: { id: 999 },
  }));
  assert.equal(prompts[0][1], "[telegram-from] id=999\n[telegram-chat] id=-1001 type=group\n\nPlease open a ticket for Acme");
  assert.doesNotMatch(prompts[0][1], /telegram-group-hybrid/);
  assert.equal(sent[0].text, "Finished.");
});

test("group CJK keyword and multi-word keyword phrase take the fast path", async () => {
  const { bridge, prompts } = makeHarness();
  await bridge.handleUpdate(update("麻烦开一个工单", {
    chat: { id: -1001, type: "supergroup" },
    from: { id: 999 },
  }));
  assert.equal(prompts.length, 1);
  await bridge.handleUpdate(update("need the help desk asap", {
    chat: { id: -1001, type: "supergroup" },
    from: { id: 999 },
    message_id: 2,
  }));
  assert.equal(prompts.length, 2);
});

test("group reply to this bot is accepted without mention", async () => {
  const { bridge, sent, prompts } = makeHarness();
  await bridge.handleUpdate(update("yes, that one", {
    chat: { id: -1001, type: "supergroup" },
    from: { id: 999 },
    reply_to_message: {
      message_id: 10,
      from: { id: 1, is_bot: true, username: "example_test_bot" },
      text: "Which client?",
    },
  }));
  assert.equal(prompts[0][1], "[telegram-from] id=999\n[telegram-chat] id=-1001 type=supergroup\n\nyes, that one");
  assert.equal(sent[0].text, "Finished.");
});

test("group reply to a different bot or human with noise is ignored", async () => {
  const { bridge, sent, prompts } = makeHarness();
  await bridge.handleUpdate(update("ok", {
    chat: { id: -1001, type: "group" },
    from: { id: 999 },
    reply_to_message: {
      message_id: 11,
      from: { id: 55, is_bot: true, username: "other_bot" },
      text: "hi",
    },
  }));
  await bridge.handleUpdate(update("lol", {
    chat: { id: -1001, type: "group" },
    from: { id: 999 },
    reply_to_message: {
      message_id: 12,
      from: { id: 42, is_bot: false, username: "alice" },
      text: "hi",
    },
  }));
  assert.deepEqual(sent, []);
  assert.deepEqual(prompts, []);
});

test("shouldHandleGroupMessage hybrid: noise false, soft-forward/keyword/mention/reply true", async () => {
  const { bridge } = makeHarness();
  await bridge.ensureBotUsername();
  const bot = "example_test_bot";
  assert.equal(bridge.shouldHandleGroupMessage({ text: "/status" }, bot), true);
  assert.equal(bridge.shouldHandleGroupMessage({
    text: "@example_test_bot hi",
    entities: [{ type: "mention", offset: 0, length: "@example_test_bot".length }],
  }, bot), true);
  assert.equal(bridge.shouldHandleGroupMessage({
    text: "ok",
    reply_to_message: { from: { id: 1, is_bot: true, username: "example_test_bot" } },
  }, bot), true);
  assert.equal(bridge.shouldHandleGroupMessage({ text: "ticket breakdown please" }, bot), true);
  assert.equal(bridge.shouldHandleGroupMessage({ text: "帮我看看这个问题" }, bot), true);
  assert.equal(bridge.shouldHandleGroupMessage({ text: "ok" }, bot), false);
  assert.equal(bridge.shouldHandleGroupMessage({ text: "哈哈" }, bot), false);
  assert.equal(isGroupNoiseText("ok"), true);
  assert.equal(isGroupNoiseText("哈哈"), true);
  assert.equal(isGroupNoiseText("帮我看看这个问题"), false);
  assert.equal(isGroupNoiseMessage({ sticker: { file_id: "s" } }), true);
  assert.equal(isGroupNoiseMessage({ voice: { file_id: "v", duration: 3 } }), false);
  assert.equal(isGroupNoiseMessage({ audio: { file_id: "a" } }), false);
  assert.equal(isGroupNoiseMessage({ video_note: { file_id: "vn" } }), false);
  assert.equal(bridge.shouldHandleGroupMessage({ voice: { file_id: "v", duration: 3 } }, bot), true);
  assert.equal(bridge.shouldHandleGroupMessage({ audio: { file_id: "a" } }, bot), true);
  assert.ok(GROUP_NOISE_EXACT.has("ok"));
  assert.deepEqual([...bridge.groupKeywords], TEST_GROUP_KEYWORDS);
  assert.deepEqual([...DEFAULT_GROUP_KEYWORDS], []);
});

test("group keywords are normalized and matched on word boundaries", () => {
  assert.deepEqual([...normalizeGroupKeywords(" Ticket , HELP desk,,工单 ,ticket")], ["ticket", "help desk", "工单"]);
  assert.deepEqual([...normalizeGroupKeywords(undefined)], []);
  const { bridge } = makeHarness();
  assert.equal(bridge.hasGroupKeyword("New TICKET: printer"), true);
  assert.equal(bridge.hasGroupKeyword("tickets"), false);
  assert.equal(bridge.hasGroupKeyword("call the Help Desk"), true);
  assert.equal(bridge.hasGroupKeyword("请开工单"), true);
  assert.equal(bridge.hasGroupKeyword("nothing here"), false);
});

test("without TELEGRAM_GROUP_KEYWORDS, group asks soft-forward with the default hint", async () => {
  const harness = makeHarness();
  const bridge = new Bridge({
    telegram: harness.telegram,
    grok: harness.grok,
    state: harness.state,
    allowedUserIds: new Set([42]),
    allowedChatIds: new Set([-1001]),
    defaultAgent: "Chief of Staff",
  });
  await bridge.handleUpdate(update("Please open a ticket", { chat: { id: -1001, type: "group" }, from: { id: 999 } }));
  assert.equal(
    harness.prompts[0][1],
    `[telegram-from] id=999\n[telegram-chat] id=-1001 type=group\n\n${GROUP_HYBRID_HINT}\n\nPlease open a ticket`,
  );
  assert.match(GROUP_HYBRID_HINT, /^\[telegram-group-hybrid\] .*NO_TELEGRAM_REPLY\.$/);
});

test("TELEGRAM_GROUP_HINT overrides the soft-forward instruction and keeps the tag", async () => {
  assert.equal(buildGroupHybridHint(undefined), GROUP_HYBRID_HINT);
  assert.equal(buildGroupHybridHint("  Reply only to support requests. "), "[telegram-group-hybrid] Reply only to support requests.");
  assert.equal(buildGroupHybridHint("[telegram-group-hybrid] Custom."), "[telegram-group-hybrid] Custom.");
  const harness = makeHarness();
  const bridge = new Bridge({
    telegram: harness.telegram,
    grok: harness.grok,
    state: harness.state,
    allowedUserIds: new Set([42]),
    allowedChatIds: new Set([-1001]),
    defaultAgent: "Chief of Staff",
    groupHint: "Reply only to support requests. Else exactly NO_TELEGRAM_REPLY.",
  });
  await bridge.handleUpdate(update("the printer is jammed", { chat: { id: -1001, type: "group" }, from: { id: 999 } }));
  assert.equal(
    harness.prompts[0][1],
    "[telegram-from] id=999\n[telegram-chat] id=-1001 type=group\n\n[telegram-group-hybrid] Reply only to support requests. Else exactly NO_TELEGRAM_REPLY.\n\nthe printer is jammed",
  );
});

test("TELEGRAM_VOICE_PROMPT_HINT is appended to voice prompts", async () => {
  const harness = makeHarness();
  const bridge = new Bridge({
    telegram: harness.telegram,
    grok: harness.grok,
    state: harness.state,
    allowedUserIds: new Set([42]),
    allowedChatIds: new Set([99]),
    defaultAgent: "Chief of Staff",
    voicePromptHint: "Use only the local whisper CLI.",
  });
  bridge.telegram.downloadFile = async () => ({ bytes: new Uint8Array([1]), filename: "voice.ogg" });
  await bridge.handleUpdate(update(undefined, { voice: { file_id: "voice" } }));
  assert.match(harness.prompts[0][1], /Voice note attached[\s\S]*Use only the local whisper CLI\.$/);
});

test("group photo caption with a keyword is accepted", async () => {
  const { bridge, prompts } = makeHarness();
  bridge.telegram.downloadFile = async () => ({ bytes: new Uint8Array([1]), filename: "photo.jpg" });
  await bridge.handleUpdate({
    update_id: 88,
    message: {
      caption: "ticket for March",
      chat: { id: -1001, type: "group" },
      from: { id: 999 },
      photo: [{ file_id: "ph1", width: 100, height: 100 }],
    },
  });
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0][1], "[telegram-from] id=999\n[telegram-chat] id=-1001 type=group\n\nticket for March");
});


test("NO_TELEGRAM_REPLY sentinel completes delivery without sendMessage", async () => {
  const { bridge, grok, state, sent } = makeHarness();
  grok.waitForReply = async () => ({
    messageId: "silent-1",
    text: "NO_TELEGRAM_REPLY",
    attachments: [],
  });
  await bridge.handleUpdate(update("side chat about lunch", {
    chat: { id: -1001, type: "group" },
    from: { id: 999 },
    message_id: 900,
  }));
  assert.equal(sent.length, 0);
  assert.equal(isSilentTelegramReply("NO_TELEGRAM_REPLY"), true);
  assert.equal(isSilentTelegramReply("[NO_TELEGRAM_REPLY]"), true);
  assert.equal(isSilentTelegramReply("⟦noreply⟧"), true);
  assert.equal(isSilentTelegramReply("NO_TELEGRAM_REPLY", [{ path: "/a" }]), false);
  const progressEntries = [...state.deliveries.values()];
  assert.ok(progressEntries.some((p) => p.completed === true));
});

test("group mention fast-path does not prepend hybrid hint", async () => {
  const { bridge, prompts } = makeHarness();
  const text = "@example_test_bot ping please";
  await bridge.handleUpdate(update(text, {
    chat: { id: -1001, type: "supergroup" },
    from: { id: 999 },
    entities: [{ type: "mention", offset: 0, length: "@example_test_bot".length }],
  }));
  assert.equal(prompts[0][1], "[telegram-from] id=999\n[telegram-chat] id=-1001 type=supergroup\n\nping please");
  assert.doesNotMatch(prompts[0][1], /telegram-group-hybrid/);
});

test("retries readAttachment then delivers the file on success", async () => {
  const { bridge, grok, state, sent } = makeHarness();
  bridge.attachmentReadAttempts = 5;
  bridge.attachmentReadBackoffMs = () => 0;
  let attempts = 0;
  const delivered = [];
  grok.readAttachment = async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("Grok attachment could not be read");
    return new Uint8Array([9, 9, 9]);
  };
  bridge.telegram.sendAttachment = async (chatId, attachment, options) => {
    delivered.push({ chatId, attachment, options });
    return { message_id: 50 + delivered.length };
  };

  const deliveryKey = "prompt:chief:p1:r1";
  await bridge.deliverTelegramParts({
    deliveryKey,
    chatId: 99,
    agentId: "chief",
    text: "Report ready.",
    attachments: [{ path: "/attachments/report.pdf", filename: "report.pdf" }],
  });

  assert.equal(attempts, 3);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "Report ready.");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].attachment.filename, "report.pdf");
  assert.deepEqual([...delivered[0].attachment.bytes], [9, 9, 9]);
  const progress = state.getDeliveryProgress(deliveryKey);
  assert.equal(progress?.completed, true);
  assert.equal(progress?.attachmentUnavailable, undefined);
  assert.equal(progress?.nextPart, 2);
});

test("retries readAttachment then sends unavailable notice and completes delivery", async () => {
  const { bridge, grok, state, sent } = makeHarness();
  bridge.attachmentReadAttempts = 5;
  bridge.attachmentReadBackoffMs = () => 0;
  let attempts = 0;
  const delivered = [];
  grok.readAttachment = async () => {
    attempts += 1;
    throw new Error("Grok attachment could not be read");
  };
  bridge.telegram.sendAttachment = async (chatId, attachment, options) => {
    delivered.push({ chatId, attachment, options });
  };

  const deliveryKey = "prompt:chief:p2:r2";
  await bridge.deliverTelegramParts({
    deliveryKey,
    chatId: 99,
    agentId: "chief",
    text: "Here is the file.",
    attachments: [{ path: "/attachments/missing.pdf", filename: "missing.pdf" }],
  });

  assert.equal(attempts, 5);
  assert.equal(delivered.length, 0);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].text, "Here is the file.");
  assert.match(sent[1].text, /wasn't ready to send \(missing\.pdf\)/i);
  const progress = state.getDeliveryProgress(deliveryKey);
  assert.equal(progress?.completed, true);
  assert.equal(progress?.attachmentUnavailable, true);
  assert.deepEqual(progress?.failedAttachmentParts, [1]);
  assert.equal(progress?.nextPart, 2);

  // Idempotent re-entry must not re-send text or notice.
  const sentBefore = sent.length;
  await bridge.deliverTelegramParts({
    deliveryKey,
    chatId: 99,
    agentId: "chief",
    text: "Here is the file.",
    attachments: [{ path: "/attachments/missing.pdf", filename: "missing.pdf" }],
  });
  assert.equal(sent.length, sentBefore);
  assert.equal(attempts, 5);
});

test("isRetryableAttachmentReadError treats size and format errors as permanent", () => {
  assert.equal(isRetryableAttachmentReadError(new Error("Grok attachment could not be read")), true);
  assert.equal(isRetryableAttachmentReadError(new Error("Grok attachment exceeds 20 MB")), false);
  assert.equal(isRetryableAttachmentReadError(new Error("Grok returned an unsupported data attachment")), false);
});

test("isTelegramOriginContext detects origin flag and telegram nonces", () => {
  assert.equal(isTelegramOriginContext({ origin: "telegram" }), true);
  assert.equal(isTelegramOriginContext({ clientNonce: "telegram:1:2:3" }), true);
  assert.equal(isTelegramOriginContext({}, "telegram:widget:abc:0"), true);
  assert.equal(isTelegramOriginContext({ origin: "desktop", clientNonce: "desktop:1" }), false);
  assert.equal(isTelegramOriginContext({}), false);
});

test("telegram-originated turn delivers every send-message including attachments", async () => {
  const { bridge, grok, sent, telegram } = makeHarness();
  const attachmentsSent = [];
  telegram.sendAttachment = async (chatId, attachment, options) => {
    attachmentsSent.push({ chatId, attachment, options });
    return { message_id: 200 + attachmentsSent.length };
  };
  const replyEntries = [
    { id: "ack", kind: "send-message", message: { type: "text", content: "Got it — preparing the report." } },
    { id: "final", kind: "send-message", message: { type: "text", content: "Report PDF is ready." } },
    {
      id: "pdf",
      kind: "send-message",
      message: { type: "attachment", url: "/attachments/summary.pdf", file_name: "summary.pdf" },
    },
  ];
  grok.waitForReply = async () => {
    const result = {
      messageId: "pdf",
      text: "Report PDF is ready.",
      attachments: [{ path: "/attachments/summary.pdf", filename: "summary.pdf" }],
    };
    Object.defineProperty(result, "entries", { value: replyEntries });
    return result;
  };
  grok.getTranscript = async () => [
    { id: "prompt", kind: "message", clientNonce: "telegram:10:99:501", message: { type: "text", content: "make report" } },
    ...replyEntries,
  ];
  grok.getTranscriptTail = grok.getTranscript;

  await bridge.handleUpdate(update("Please prepare the report", { message_id: 501 }));

  assert.deepEqual(
    sent.map(({ chatId, text }) => ({ chatId, text })),
    [
      { chatId: 99, text: "Got it — preparing the report." },
      { chatId: 99, text: "Report PDF is ready." },
    ],
  );
  assert.equal(attachmentsSent.length, 1);
  assert.equal(attachmentsSent[0].chatId, 99);
  assert.equal(attachmentsSent[0].attachment.filename, "summary.pdf");
  assert.equal(isTelegramOriginContext({ origin: "telegram", chatId: 99 }), true);
});

test("NO_TELEGRAM_REPLY remains silent among telegram multi-entry delivery", async () => {
  const { bridge, grok, sent } = makeHarness();
  const replyEntries = [
    { id: "silent", kind: "send-message", message: { type: "text", content: "NO_TELEGRAM_REPLY" } },
  ];
  grok.waitForReply = async () => {
    const result = { messageId: "silent", text: "NO_TELEGRAM_REPLY", attachments: [] };
    Object.defineProperty(result, "entries", { value: replyEntries });
    return result;
  };
  grok.getTranscript = async () => [
    { id: "prompt", kind: "message", clientNonce: "telegram:10:-1001:900", message: { type: "text", content: "lunch?" } },
    ...replyEntries,
  ];
  grok.getTranscriptTail = grok.getTranscript;

  await bridge.handleUpdate(update("side chat about lunch", {
    chat: { id: -1001, type: "group" },
    from: { id: 999 },
    message_id: 900,
  }));
  assert.equal(sent.length, 0);
});


test("formats telegram topic headers with and without names", () => {
  assert.equal(
    formatTelegramTopicHeader({ message_thread_id: 111 }, new Map([[111, "Support Desk"]])),
    "[telegram-topic] id=111 name=Support Desk",
  );
  assert.equal(
    formatTelegramTopicHeader({ message_thread_id: 7 }),
    "[telegram-topic] id=7",
  );
  assert.equal(formatTelegramTopicHeader({}), "");
  assert.equal(
    resolveTelegramTopicName({
      message_thread_id: 111,
      reply_to_message: { forum_topic_created: { name: " Support Desk " } },
    }),
    "Support Desk",
  );
  assert.equal(effectiveForumTopicId({ chat: { is_forum: true } }), 1);
  assert.equal(effectiveForumTopicId({ message_thread_id: 111, chat: { is_forum: true } }), 111);
  assert.equal(effectiveForumTopicId({ chat: { type: "private" } }), undefined);
});

test("topic header precedes hybrid hint after telegram-from", async () => {
  const { bridge, prompts } = makeHarness();
  await bridge.handleUpdate(update("帮我看看这个问题", {
    chat: { id: -1001, type: "supergroup", is_forum: true },
    from: { id: 999 },
    message_thread_id: 111,
    reply_to_message: { forum_topic_created: { name: "Support Desk" } },
  }));
  assert.equal(
    prompts[0][1],
    `[telegram-from] id=999\n[telegram-chat] id=-1001 type=supergroup\n[telegram-topic] id=111 name=Support Desk\n\n${GROUP_HYBRID_HINT}\n\n帮我看看这个问题`,
  );
});

test("topic allowlist allows Support Desk topic and denies others", async () => {
  const { bridge, prompts, sent } = makeHarness();
  bridge.allowedTopicIds = new Set([111]);
  bridge.topicNames = new Map([[111, "Support Desk"]]);

  await bridge.handleUpdate(update("@example_test_bot quote please", {
    chat: { id: -1001, type: "supergroup", is_forum: true },
    from: { id: 999 },
    message_thread_id: 111,
    entities: [{ type: "mention", offset: 0, length: "@example_test_bot".length }],
  }));
  assert.equal(prompts.length, 1);
  assert.match(prompts[0][1], /\[telegram-topic\] id=111 name=Support Desk/);

  await bridge.handleUpdate(update("@example_test_bot other topic", {
    chat: { id: -1001, type: "supergroup", is_forum: true },
    from: { id: 999 },
    message_id: 2,
    message_thread_id: 55,
    entities: [{ type: "mention", offset: 0, length: "@example_test_bot".length }],
  }));
  assert.equal(prompts.length, 1);
  assert.equal(sent.filter((row) => row.text === "Finished.").length, 1);
});

test("topic allowlist treats missing forum thread as General (id 1)", async () => {
  const { bridge, prompts } = makeHarness();
  bridge.allowedTopicIds = new Set([111]);
  await bridge.handleUpdate(update("@example_test_bot in general", {
    chat: { id: -1001, type: "supergroup", is_forum: true },
    from: { id: 999 },
    entities: [{ type: "mention", offset: 0, length: "@example_test_bot".length }],
  }));
  assert.equal(prompts.length, 0);

  bridge.allowedTopicIds = new Set([1]);
  await bridge.handleUpdate(update("@example_test_bot in general allowed", {
    chat: { id: -1001, type: "supergroup", is_forum: true },
    from: { id: 999 },
    message_id: 3,
    entities: [{ type: "mention", offset: 0, length: "@example_test_bot".length }],
  }));
  assert.equal(prompts.length, 1);
});

test("DMs are not topic-filtered even when allowlist is set", async () => {
  const { bridge, prompts } = makeHarness();
  bridge.allowedTopicIds = new Set([111]);
  await bridge.handleUpdate(update("private ping"));
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0][1], "[telegram-from] id=42\n[telegram-chat] id=99 type=private\n\nprivate ping");
});

test("empty topic allowlist keeps all-topics behavior", async () => {
  const { bridge, prompts } = makeHarness();
  bridge.allowedTopicIds = new Set();
  await bridge.handleUpdate(update("@example_test_bot anywhere", {
    chat: { id: -1001, type: "supergroup", is_forum: true },
    from: { id: 999 },
    message_thread_id: 55,
    entities: [{ type: "mention", offset: 0, length: "@example_test_bot".length }],
  }));
  assert.equal(prompts.length, 1);
  assert.match(prompts[0][1], /\[telegram-topic\] id=55/);
});

// ---- Per-topic agent routing (TELEGRAM_TOPIC_AGENTS) — fake ids/names only ----

function forumHarness(topicAgents) {
  const harness = makeHarness();
  harness.bridge.allowedTopicIds = new Set([111]);
  harness.bridge.topicNames = new Map([[111, "Support Desk"]]);
  harness.bridge.topicAgents = topicAgents;
  harness.bridge.telegram.downloadFile = async () => ({ bytes: new Uint8Array([1]), filename: "x.bin" });
  return harness;
}

const forumUpdate = (text, overrides = {}) => update(text, {
  chat: { id: -1001, type: "supergroup", is_forum: true },
  from: { id: 555, first_name: "Tech" },
  ...overrides,
});

test("name-mapped topic routes captionless photos to the mapped agent with the generic hint", async () => {
  const { bridge, prompts } = forumHarness([{ topic: "Site Logs", topicName: "site logs", agent: "research" }]);
  const message = {
    message_id: 11,
    message_thread_id: 700,
    photo: [{ file_id: "small" }, { file_id: "large" }],
    reply_to_message: { message_id: 700, forum_topic_created: { name: "Site Logs" } },
  };
  assert.equal(bridge.queueKeyForUpdate({ message: forumUpdate(undefined, message).message }), "-1001:agent:research");
  await bridge.handleUpdate(forumUpdate(undefined, message));
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0][0], "research");
  assert.equal(
    prompts[0][1],
    `[telegram-from] id=555 name=Tech\n[telegram-chat] id=-1001 type=supergroup\n[telegram-topic] id=700 name=Site Logs\n\n${GROUP_TOPIC_AGENT_HINT}\n\n[photo attached]`,
  );
  assert.ok(!prompts[0][1].includes(GROUP_HYBRID_HINT));
  assert.deepEqual(prompts[0][3].attachmentNames, ["telegram-photo-11.jpg"]);
});

test("id-mapped topic forwards all real text and voice, drops pure noise, ignores quote keywords", async () => {
  const { bridge, prompts } = forumHarness([{ topic: "701", topicId: 701, agent: "Research" }]);
  await bridge.handleUpdate(forumUpdate("Replaced the valve, pressure holding", { message_id: 1, message_thread_id: 701 }));
  await bridge.handleUpdate(forumUpdate(undefined, { message_id: 2, message_thread_id: 701, voice: { file_id: "v" } }));
  await bridge.handleUpdate(forumUpdate("quote for the valve", { message_id: 3, message_thread_id: 701 }));
  await bridge.handleUpdate(forumUpdate("ok", { message_id: 4, message_thread_id: 701 }));
  await bridge.handleUpdate(forumUpdate(undefined, { message_id: 5, message_thread_id: 701, sticker: { file_id: "s" } }));
  await bridge.handleUpdate(forumUpdate(undefined, {
    message_id: 6, message_thread_id: 701, document: { file_id: "d", file_name: "site.pdf" },
  }));
  assert.equal(prompts.length, 4);
  assert.ok(prompts.every((prompt) => prompt[0] === "research"));
  assert.ok(prompts.every((prompt) => prompt[1].includes(`${GROUP_TOPIC_AGENT_HINT}\n\n`)));
  assert.match(prompts[1][1], /\[voice note attached\]/);
  assert.deepEqual(prompts[1][3].attachmentNames, ["telegram-voice.ogg"]);
  assert.match(prompts[2][1], /quote for the valve$/);
  assert.deepEqual(prompts[3][3].attachmentNames, ["site.pdf"]);
});

test("learns a topic name from forum_topic_created, persists it, and routes later replies by name", async (t) => {
  const { bridge, prompts, sent, state } = forumHarness([{ topic: "Site Logs", topicName: "site logs", agent: "research" }]);
  const stored = [];
  state.setTopicName = async (chatId, threadId, name) => { stored.push([chatId, threadId, name]); return true; };
  const logs = [];
  t.mock.method(console, "error", (...args) => { logs.push(args.join(" ")); });
  await bridge.handleUpdate(forumUpdate(undefined, {
    message_id: 900, message_thread_id: 900, is_topic_message: true,
    forum_topic_created: { name: "Site Logs", icon_color: 1 },
  }));
  assert.equal(prompts.length, 0);
  assert.equal(sent.length, 0);
  assert.deepEqual(stored, [[-1001, 900, "Site Logs"]]);
  assert.ok(logs.some((line) => line.includes("topic learned chat=-1001 id=900 name=Site Logs")));

  // A reply to another member's message carries no forum_topic_created in reply_to_message.
  await bridge.handleUpdate(forumUpdate("Photo of the panel after cleaning", {
    message_id: 901, message_thread_id: 900, is_topic_message: true,
    reply_to_message: { message_id: 850, from: { id: 556, is_bot: false }, text: "done?" },
  }));
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0][0], "research");
  assert.match(prompts[0][1], /\[telegram-topic\] id=900 name=Site Logs/);

  // Renames are learned from forum_topic_edited.
  await bridge.handleUpdate(forumUpdate(undefined, {
    message_id: 902, message_thread_id: 900, forum_topic_edited: { name: "Site Logs 2" },
  }));
  assert.equal(bridge.topicNameLookup(-1001).get(900), "Site Logs 2");
});

test("learned topic names are seeded from persisted state on startup", async () => {
  const harness = makeHarness();
  const bridge = new Bridge({
    telegram: harness.telegram,
    grok: harness.grok,
    state: { ...harness.state, listTopicNames: () => ({ "-1001": { 900: "Site Logs" } }) },
    allowedUserIds: new Set([42]),
    allowedChatIds: new Set([-1001]),
    defaultAgent: "Chief of Staff",
    allowedTopicIds: new Set([111]),
    topicAgents: [{ topic: "Site Logs", topicName: "site logs", agent: "research" }],
  });
  const message = forumUpdate("Arrived on site", { message_thread_id: 900 }).message;
  assert.equal(bridge.topicAgentFor(message), "research");
  assert.equal(bridge.isTopicAllowlisted(message), true);
});

test("unmapped topics keep default routing, hybrid filter, and the allowlist", async () => {
  const { bridge, prompts } = forumHarness([{ topic: "Site Logs", topicName: "site logs", agent: "research" }]);
  await bridge.handleUpdate(forumUpdate("帮我看看这个问题", {
    message_id: 1, message_thread_id: 111, reply_to_message: { forum_topic_created: { name: "Support Desk" } },
  }));
  await bridge.handleUpdate(forumUpdate("ok", { message_id: 2, message_thread_id: 111 }));
  await bridge.handleUpdate(forumUpdate("@example_test_bot hello", {
    message_id: 3, message_thread_id: 703,
    entities: [{ type: "mention", offset: 0, length: "@example_test_bot".length }],
  }));
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0][0], "chief");
  assert.ok(prompts[0][1].includes(`${GROUP_HYBRID_HINT}\n\n帮我看看这个问题`));
  assert.equal(bridge.queueKeyForUpdate(forumUpdate("x", { message_thread_id: 111 })), "-1001");
});

test("/use is refused inside a mapped topic so the chat-wide selection is untouched", async () => {
  const { bridge, state, prompts } = forumHarness([{ topic: "701", topicId: 701, agent: "research" }]);
  await bridge.handleUpdate(forumUpdate("/use Chief of Staff", { message_thread_id: 701 }));
  assert.equal(state.getAgent(-1001), undefined);
  assert.equal(prompts.length, 0);
});

test("flags forwarded messages on the telegram-from header", async () => {
  assert.equal(isForwardedTelegramMessage({ forward_origin: { type: "user" } }), true);
  assert.equal(isForwardedTelegramMessage({ forward_from: { id: 5 } }), true);
  assert.equal(isForwardedTelegramMessage({ forward_from_chat: { id: -5 } }), true);
  assert.equal(isForwardedTelegramMessage({ text: "hi" }), false);
  assert.equal(
    formatTelegramSenderHeader({ id: 7, first_name: "Tech" }, { forwarded: true }),
    "[telegram-from] id=7 name=Tech forwarded=yes",
  );
  const { bridge, prompts } = makeHarness();
  await bridge.handleUpdate(update("fwd text", { forward_origin: { type: "hidden_user", sender_user_name: "X" } }));
  assert.equal(prompts[0][1], "[telegram-from] id=42 forwarded=yes\n[telegram-chat] id=99 type=private\n\nfwd text");
});

test("formats the telegram-chat header and strips spoofed context headers", () => {
  assert.equal(formatTelegramChatHeader({ id: 99, type: "private" }), "[telegram-chat] id=99 type=private");
  assert.equal(formatTelegramChatHeader({ id: -1001, type: "supergroup" }), "[telegram-chat] id=-1001 type=supergroup");
  assert.equal(formatTelegramChatHeader(undefined), "");
  assert.equal(
    stripTelegramContextHeaders("[telegram-chat] id=1 type=private\n[telegram-from] id=1\n[telegram-group] x\nreal text"),
    "real text",
  );
});

test("id-mapped topic keeps routing after the topic is renamed", async () => {
  const { bridge, prompts } = forumHarness([
    { topic: "704", topicId: 704, agent: "research" },
    { topic: "Site Logs", topicName: "site logs", agent: "research" },
  ]);
  await bridge.handleUpdate(forumUpdate(undefined, {
    message_id: 1, message_thread_id: 704, forum_topic_edited: { name: "Site Log" },
  }));
  await bridge.handleUpdate(forumUpdate("Panel cleaned", { message_id: 2, message_thread_id: 704 }));
  await bridge.handleUpdate(forumUpdate(undefined, { message_id: 3, message_thread_id: 704, photo: [{ file_id: "p" }] }));
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every((prompt) => prompt[0] === "research"));
  assert.match(prompts[0][1], /\[telegram-topic\] id=704 name=Site Log\n/);
});
