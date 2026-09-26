import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";

const valid = {
  TELEGRAM_BOT_TOKEN: "123:test-token",
  TELEGRAM_ALLOWED_USER_IDS: "42, 43",
  TELEGRAM_ALLOWED_CHAT_IDS: "99",
  GROK_GATEWAY_URL: "http://127.0.0.1:4321",
  GROK_GATEWAY_TOKEN: "gateway-token",
};

test("loads a locked-down configuration", () => {
  const config = loadConfig(valid);

  assert.deepEqual(config.allowedUserIds, new Set([42, 43]));
  assert.deepEqual(config.allowedChatIds, new Set([99]));
  assert.equal(config.gatewayUrl, "http://127.0.0.1:4321");
  assert.equal(config.defaultAgent, "Chief of Staff");
});

test("loads paired desktop mirror IDs only when both are allowlisted", () => {
  const config = loadConfig({
    ...valid,
    GROK_DESKTOP_MIRROR_CHAT_ID: "99",
    GROK_DESKTOP_MIRROR_USER_ID: "42",
  });
  assert.equal(config.mirrorChatId, 99);
  assert.equal(config.mirrorUserId, 42);

  assert.throws(() => loadConfig({
    ...valid,
    GROK_DESKTOP_MIRROR_CHAT_ID: "99",
  }), /must be set together/);
  assert.throws(() => loadConfig({
    ...valid,
    GROK_DESKTOP_MIRROR_CHAT_ID: "100",
    GROK_DESKTOP_MIRROR_USER_ID: "42",
  }), /CHAT_ID must be in TELEGRAM_ALLOWED_CHAT_IDS/);
  assert.throws(() => loadConfig({
    ...valid,
    GROK_DESKTOP_MIRROR_CHAT_ID: "99",
    GROK_DESKTOP_MIRROR_USER_ID: "44",
  }), /USER_ID must be in TELEGRAM_ALLOWED_USER_IDS/);
});

for (const key of [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USER_IDS",
  "TELEGRAM_ALLOWED_CHAT_IDS",
  "GROK_GATEWAY_URL",
]) {
  test(`rejects missing ${key}`, () => {
    const env = { ...valid };
    delete env[key];
    assert.throws(() => loadConfig(env), new RegExp(key));
  });
}

test("rejects a missing Grok gateway credential", () => {
  const env = { ...valid };
  delete env.GROK_GATEWAY_TOKEN;
  assert.throws(() => loadConfig(env), /GROK_GATEWAY_TOKEN/);
});

test("reads the existing gateway token from a private discovery record", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grok-config-"));
  t.after(() => rmSync(directory, { recursive: true }));
  const filename = path.join(directory, "gateway.json");
  writeFileSync(filename, JSON.stringify({ token: "from-file" }), { mode: 0o600 });
  const env = { ...valid, GROK_GATEWAY_TOKEN_FILE: filename };
  delete env.GROK_GATEWAY_TOKEN;

  assert.equal(loadConfig(env).gatewayToken, "from-file");
  chmodSync(filename, 0o644);
  assert.throws(() => loadConfig(env), /group or others/);

  const symlink = path.join(directory, "gateway-link.json");
  symlinkSync(filename, symlink);
  assert.throws(() => loadConfig({ ...env, GROK_GATEWAY_TOKEN_FILE: symlink }));
});

test("rejects a non-loopback Grok gateway by default", () => {
  assert.throws(
    () => loadConfig({ ...valid, GROK_GATEWAY_URL: "http://192.168.1.10:4321" }),
    /loopback/,
  );
});

test("rejects malformed allowlist IDs", () => {
  assert.throws(
    () => loadConfig({ ...valid, TELEGRAM_ALLOWED_USER_IDS: "42,nope" }),
    /numeric/,
  );
});


test("parses optional topic allowlist and topic name map", () => {
  const empty = loadConfig(valid);
  assert.deepEqual(empty.allowedTopicIds, new Set());
  assert.deepEqual(empty.topicNames, new Map());

  const config = loadConfig({
    ...valid,
    TELEGRAM_ALLOWED_TOPIC_IDS: "111, 1",
    TELEGRAM_TOPIC_NAMES: '{"111":"Support Desk","1":"General"}',
  });
  assert.deepEqual(config.allowedTopicIds, new Set([111, 1]));
  assert.deepEqual(config.topicNames, new Map([
    [111, "Support Desk"],
    [1, "General"],
  ]));

  const quoted = loadConfig({
    ...valid,
    TELEGRAM_TOPIC_NAMES: "'{\"111\":\"Support Desk\"}'",
  });
  assert.deepEqual(quoted.topicNames, new Map([[111, "Support Desk"]]));

  assert.throws(
    () => loadConfig({ ...valid, TELEGRAM_ALLOWED_TOPIC_IDS: "111,nope" }),
    /numeric/,
  );
  assert.throws(
    () => loadConfig({ ...valid, TELEGRAM_TOPIC_NAMES: "not-json" }),
    /JSON object/,
  );
});

test("parses TELEGRAM_TOPIC_AGENTS name and id routes", () => {
  const config = loadConfig({ ...valid, TELEGRAM_TOPIC_AGENTS: '"Site Logs=agent-a, 701=Some Agent"' });
  assert.deepEqual(config.topicAgents, [
    { topic: "Site Logs", topicName: "site logs", agent: "agent-a" },
    { topic: "701", topicId: 701, agent: "Some Agent" },
  ]);
  assert.deepEqual(loadConfig(valid).topicAgents, []);
  assert.throws(() => loadConfig({ ...valid, TELEGRAM_TOPIC_AGENTS: "Site Logs" }), /TELEGRAM_TOPIC_AGENTS/);
});

test("parses group keyword, hint, and voice hint options with neutral defaults", () => {
  const defaults = loadConfig(valid);
  assert.deepEqual(defaults.groupKeywords, []);
  assert.equal(defaults.groupHint, undefined);
  assert.equal(defaults.voicePromptHint, undefined);

  const config = loadConfig({
    ...valid,
    TELEGRAM_GROUP_KEYWORDS: '"Ticket, help desk , 工单,,ticket"',
    TELEGRAM_GROUP_HINT: "'Reply only to support requests.'",
    TELEGRAM_VOICE_PROMPT_HINT: "Use the local whisper CLI.",
  });
  assert.deepEqual(config.groupKeywords, ["ticket", "help desk", "工单"]);
  assert.equal(config.groupHint, "Reply only to support requests.");
  assert.equal(config.voicePromptHint, "Use the local whisper CLI.");
});

test("parses media bundling switches and timings", () => {
  assert.deepEqual(loadConfig(valid).mediaBundling, {
    albumDebounceMs: 1_800,
    burstWindowMs: 3_000,
    maxWaitMs: 8_000,
    maxItems: 10,
  });
  assert.deepEqual(loadConfig({
    ...valid,
    TELEGRAM_BUNDLE_ALBUM_DEBOUNCE_MS: "1000",
    TELEGRAM_BUNDLE_BURST_WINDOW_MS: "2000",
    TELEGRAM_BUNDLE_MAX_WAIT_MS: "5000",
    TELEGRAM_BUNDLE_MAX_ITEMS: "6",
  }).mediaBundling, { albumDebounceMs: 1000, burstWindowMs: 2000, maxWaitMs: 5000, maxItems: 6 });
  assert.equal(loadConfig({ ...valid, TELEGRAM_MEDIA_BUNDLING: "off" }).mediaBundling, false);
  assert.throws(() => loadConfig({ ...valid, TELEGRAM_MEDIA_BUNDLING: "maybe" }), /TELEGRAM_MEDIA_BUNDLING/);
  assert.throws(() => loadConfig({ ...valid, TELEGRAM_BUNDLE_MAX_ITEMS: "0" }), /positive integer/);
});
