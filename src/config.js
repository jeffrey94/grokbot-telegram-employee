import path from "node:path";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseIds(env, name) {
  const raw = required(env, name);
  const values = raw.split(",").map((value) => value.trim());
  if (values.some((value) => !/^-?\d+$/.test(value))) {
    throw new Error(`${name} must contain only comma-separated numeric IDs`);
  }
  return new Set(values.map(Number));
}

function optionalId(env, name) {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  if (!/^-?\d+$/.test(raw)) throw new Error(`${name} must be a numeric ID`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe numeric ID`);
  return value;
}


function optionalIds(env, name) {
  const raw = env[name]?.trim();
  if (!raw) return new Set();
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (values.some((value) => !/^-?\d+$/.test(value))) {
    throw new Error(`${name} must contain only comma-separated numeric IDs`);
  }
  return new Set(values.map(Number));
}

function parseTopicNames(env, name) {
  const raw = env[name]?.trim();
  if (!raw) return new Map();
  let jsonText = raw;
  if (
    (jsonText.startsWith("'") && jsonText.endsWith("'"))
    || (jsonText.startsWith('"') && jsonText.endsWith('"'))
  ) {
    jsonText = jsonText.slice(1, -1);
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error(`${name} must be a JSON object of numeric id -> name strings`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object of numeric id -> name strings`);
  }
  const map = new Map();
  for (const [key, value] of Object.entries(parsed)) {
    if (!/^-?\d+$/.test(key)) {
      throw new Error(`${name} keys must be numeric topic IDs`);
    }
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${name} values must be non-empty name strings`);
    }
    map.set(Number(key), value.trim());
  }
  return map;
}

/**
 * TELEGRAM_TOPIC_AGENTS: comma-separated `<topicIdOrName>=<agentIdOrName>`.
 * Numeric keys match forum topic ids; other keys match topic names
 * case-insensitively. Values are Grok agent ids or exact names.
 */
function parseTopicAgents(env, name) {
  let raw = env[name]?.trim();
  if (!raw) return [];
  if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
    raw = raw.slice(1, -1);
  }
  const routes = [];
  for (const item of raw.split(",").map((value) => value.trim()).filter(Boolean)) {
    const separator = item.indexOf("=");
    const topic = separator > 0 ? item.slice(0, separator).trim() : "";
    const agent = separator > 0 ? item.slice(separator + 1).trim() : "";
    if (!topic || !agent) {
      throw new Error(`${name} must be comma-separated <topicIdOrName>=<agentIdOrName> pairs`);
    }
    if (/^\d+$/.test(topic)) {
      const topicId = Number(topic);
      if (!Number.isSafeInteger(topicId) || topicId <= 0) {
        throw new Error(`${name} topic ids must be positive integers`);
      }
      routes.push({ topic, topicId, agent });
    } else {
      routes.push({ topic, topicName: topic.toLocaleLowerCase(), agent });
    }
  }
  return routes;
}

function stripWrappingQuotes(raw) {
  if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
    return raw.slice(1, -1).trim();
  }
  return raw;
}

/** TELEGRAM_GROUP_KEYWORDS: comma-separated, case-insensitive. Empty/unset = none. */
function parseKeywords(env, name) {
  const raw = env[name]?.trim();
  if (!raw) return [];
  return [...new Set(stripWrappingQuotes(raw)
    .split(",")
    .map((value) => value.trim().toLocaleLowerCase())
    .filter(Boolean))];
}

function optionalText(env, name) {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  return stripWrappingQuotes(raw) || undefined;
}

function optionalBoolean(env, name, fallback) {
  const raw = env[name]?.trim().toLocaleLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be on/off, true/false, yes/no, or 1/0`);
}

function positiveInteger(env, name, fallback) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function gatewayToken(env) {
  const direct = env.GROK_GATEWAY_TOKEN?.trim();
  if (direct) return direct;
  const filename = env.GROK_GATEWAY_TOKEN_FILE?.trim();
  if (!filename) throw new Error("GROK_GATEWAY_TOKEN or GROK_GATEWAY_TOKEN_FILE is required");
  const descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw;
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error("GROK_GATEWAY_TOKEN_FILE must be a regular file");
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error("GROK_GATEWAY_TOKEN_FILE must not be readable by group or others");
    }
    raw = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
  try {
    const parsed = JSON.parse(raw);
    const token = parsed.gatewayToken ?? parsed.token;
    if (typeof token === "string" && token.trim()) {
      return token.trim();
    }
  } catch {}
  throw new Error("GROK_GATEWAY_TOKEN_FILE does not contain a recognized gateway token field");
}

export function loadConfig(env = process.env) {
  const gatewayUrl = required(env, "GROK_GATEWAY_URL").replace(/\/$/, "");
  const parsedGateway = new URL(gatewayUrl);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsedGateway.hostname)) {
    throw new Error("GROK_GATEWAY_URL must use a loopback host");
  }

  const allowedUserIds = parseIds(env, "TELEGRAM_ALLOWED_USER_IDS");
  const allowedChatIds = parseIds(env, "TELEGRAM_ALLOWED_CHAT_IDS");
  const mirrorChatId = optionalId(env, "GROK_DESKTOP_MIRROR_CHAT_ID");
  const mirrorUserId = optionalId(env, "GROK_DESKTOP_MIRROR_USER_ID");
  if ((mirrorChatId === undefined) !== (mirrorUserId === undefined)) {
    throw new Error("GROK_DESKTOP_MIRROR_CHAT_ID and GROK_DESKTOP_MIRROR_USER_ID must be set together");
  }
  if (mirrorChatId !== undefined && !allowedChatIds.has(mirrorChatId)) {
    throw new Error("GROK_DESKTOP_MIRROR_CHAT_ID must be in TELEGRAM_ALLOWED_CHAT_IDS");
  }
  if (mirrorUserId !== undefined && !allowedUserIds.has(mirrorUserId)) {
    throw new Error("GROK_DESKTOP_MIRROR_USER_ID must be in TELEGRAM_ALLOWED_USER_IDS");
  }

  const allowedTopicIds = optionalIds(env, "TELEGRAM_ALLOWED_TOPIC_IDS");
  const topicNames = parseTopicNames(env, "TELEGRAM_TOPIC_NAMES");
  const topicAgents = parseTopicAgents(env, "TELEGRAM_TOPIC_AGENTS");
  const groupKeywords = parseKeywords(env, "TELEGRAM_GROUP_KEYWORDS");
  const groupHint = optionalText(env, "TELEGRAM_GROUP_HINT");
  const voicePromptHint = optionalText(env, "TELEGRAM_VOICE_PROMPT_HINT");
  const mediaBundling = optionalBoolean(env, "TELEGRAM_MEDIA_BUNDLING", true)
    ? {
      albumDebounceMs: positiveInteger(env, "TELEGRAM_BUNDLE_ALBUM_DEBOUNCE_MS", 1_800),
      burstWindowMs: positiveInteger(env, "TELEGRAM_BUNDLE_BURST_WINDOW_MS", 3_000),
      maxWaitMs: positiveInteger(env, "TELEGRAM_BUNDLE_MAX_WAIT_MS", 8_000),
      maxItems: positiveInteger(env, "TELEGRAM_BUNDLE_MAX_ITEMS", 10),
    }
    : false;

  return {
    telegramToken: required(env, "TELEGRAM_BOT_TOKEN"),
    allowedUserIds,
    allowedChatIds,
    gatewayUrl,
    gatewayToken: gatewayToken(env),
    defaultAgent: env.GROK_DEFAULT_AGENT?.trim() || "Chief of Staff",
    statePath: path.resolve(env.BRIDGE_STATE_PATH?.trim() || "bridge-state.json"),
    replyTimeoutMs: positiveInteger(env, "GROK_REPLY_TIMEOUT_MS", 10 * 60_000),
    pollIntervalMs: positiveInteger(env, "GROK_POLL_INTERVAL_MS", 1_000),
    mirrorChatId,
    mirrorUserId,
    allowedTopicIds,
    topicNames,
    topicAgents,
    groupKeywords,
    groupHint,
    voicePromptHint,
    mediaBundling,
  };
}
