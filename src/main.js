import { Bridge } from "./bridge.js";
import { setTimeout as sleep } from "node:timers/promises";
import { loadConfig } from "./config.js";
import { GrokClient } from "./grok-client.js";
import { JsonStateStore } from "./state.js";
import { TelegramClient } from "./telegram-client.js";
import { UpdateDispatcher } from "./update-dispatcher.js";

const config = loadConfig();
const state = new JsonStateStore(config.statePath);
await state.load();

const telegram = new TelegramClient(config.telegramToken);
const grok = new GrokClient(config.gatewayUrl, config.gatewayToken, {
  pollIntervalMs: config.pollIntervalMs,
  replyTimeoutMs: config.replyTimeoutMs,
});
const bridge = new Bridge({
  telegram,
  grok,
  state,
  allowedUserIds: config.allowedUserIds,
  allowedChatIds: config.allowedChatIds,
  defaultAgent: config.defaultAgent,
  mirrorChatId: config.mirrorChatId,
  mirrorUserId: config.mirrorUserId,
  allowedTopicIds: config.allowedTopicIds,
  topicNames: config.topicNames,
  topicAgents: config.topicAgents,
  groupKeywords: config.groupKeywords,
  groupHint: config.groupHint,
  voicePromptHint: config.voicePromptHint,
});
const dispatcher = new UpdateDispatcher(bridge, { bundling: config.mediaBundling });

await telegram.setMyCommands([
  { command: "help", description: "Show help" },
  { command: "agents", description: "List Grok agents" },
  { command: "use", description: "Select a Grok agent" },
  { command: "status", description: "Show selected agent status" },
  { command: "mirror", description: "Control desktop mirroring" },
  { command: "skills", description: "List Grok skills" },
  { command: "run", description: "Run a Grok skill" },
  { command: "routines", description: "List mentionable routines" },
  { command: "mentions", description: "List @ references" },
  { command: "plugins", description: "List plugin status" },
  { command: "settings", description: "Explain desktop-only settings" },
  { command: "commands", description: "Show all bridge commands" },
]);

let stopping = false;
const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    shutdown.abort();
  });
}

console.log(
  `grokbot-telegram-bridge started allowChats=${config.allowedChatIds.size} allowedTopics=${config.allowedTopicIds.size || "all"} groupKeywords=${config.groupKeywords.length} customGroupHint=${config.groupHint ? "yes" : "no"} defaultAgent=${JSON.stringify(config.defaultAgent)} replyTimeoutMs=${config.replyTimeoutMs}`,
);
console.log(
  `topic agents loaded count=${config.topicAgents.length} map=${JSON.stringify(Object.fromEntries(config.topicAgents.map((route) => [route.topic, route.agent])))} learnedTopics=${JSON.stringify(state.listTopicNames())}`,
);
console.log(
  dispatcher.bundlingEnabled
    ? `media bundling albumDebounceMs=${dispatcher.bundling.albumDebounceMs} burstWindowMs=${dispatcher.bundling.burstWindowMs} maxWaitMs=${dispatcher.bundling.maxWaitMs} maxItems=${dispatcher.bundling.maxItems}`
    : "media bundling disabled",
);
const mirrorTask = bridge.runDesktopMirror({ signal: shutdown.signal }).catch((error) => {
  if (!stopping && error.name !== "AbortError") console.error("Desktop mirror stopped:", error.message);
});
let consecutiveFailures = 0;
const pendingCommits = [];
const inFlightUpdateIds = new Set();
// Once an update_id is accepted for dispatch in this process, never schedule it
// again — closes the race where getUpdates(oldOffset) returns a just-finished
// update after inFlight was cleared but before / while offset commit settles.
const seenUpdateIds = new Set();
let commitQueue = Promise.resolve();

function markProcessed(record) {
  record.processed = true;
  commitQueue = commitQueue.then(async () => {
    while (pendingCommits[0]?.processed) {
      const completed = pendingCommits.shift();
      await state.setOffset(completed.offset);
    }
  });
  return commitQueue;
}

function isShutdownAbort(_error) {
  // Request timeouts use AbortSignal.timeout() / AbortSignal.any([...]), so they
  // also surface as AbortError. Only withhold the Telegram ACK when *shutdown*
  // aborted the work — otherwise the ordered commit queue wedges forever.
  return stopping || shutdown.signal.aborted;
}

while (!stopping) {
  try {
    // Poll from the last *committed* offset only. Advancing the Telegram
    // getUpdates offset before handleUpdate/waitForOwnedReply finishes ACKs
    // updates that a per-chat queue may still be blocked on; a restart then
    // loses them (empty getUpdates, state.offset unchanged).
    const pollOffset = state.offset;
    const updates = await telegram.getUpdates(pollOffset, 30, { signal: shutdown.signal });
    let scheduled = 0;
    for (const update of updates) {
      if (inFlightUpdateIds.has(update.update_id) || seenUpdateIds.has(update.update_id)) continue;
      inFlightUpdateIds.add(update.update_id);
      seenUpdateIds.add(update.update_id);
      if (seenUpdateIds.size > 2_000) {
        const oldest = seenUpdateIds.values().next().value;
        seenUpdateIds.delete(oldest);
      }
      const record = { offset: update.update_id + 1, processed: false, updateId: update.update_id };
      pendingCommits.push(record);
      scheduled += 1;
      void dispatcher.dispatch(update, { signal: shutdown.signal }).then(
        () => markProcessed(record),
        (error) => {
          if (isShutdownAbort(error)) {
            // Leave uncommitted so a restart can reclaim still-pending Telegram updates.
            return;
          }
          console.error("Update dispatch failed:", error.message);
          // Commit past failures (incl. HTTP/request AbortError timeouts) so the
          // poll offset can advance and the chat queue cannot wedge forever.
          return markProcessed(record);
        },
      ).finally(() => {
        inFlightUpdateIds.delete(update.update_id);
      }).catch((error) => console.error("State commit failed:", error.message));
    }
    if (updates.length > 0 && scheduled === 0) {
      // Long-poll returned only in-flight updates; brief pause avoids a spin.
      await sleep(500, undefined, { signal: shutdown.signal });
    }
    consecutiveFailures = 0;
  } catch (error) {
    if (stopping || error.name === "AbortError") break;
    console.error("Bridge polling failed:", error.message);
    consecutiveFailures += 1;
    const backoffMs = Math.min(1_000 * (2 ** (consecutiveFailures - 1)), 30_000);
    try {
      await sleep(backoffMs, undefined, { signal: shutdown.signal });
    } catch (sleepError) {
      if (stopping || sleepError.name === "AbortError") break;
      throw sleepError;
    }
  }
}

await dispatcher.drain();
await commitQueue;
await mirrorTask;
console.log("grokbot-telegram-bridge stopped");
