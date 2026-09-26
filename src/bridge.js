import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { isTopLevelPromptEntry } from "./grok-client.js";
import { buildRichText, findStructuredReferences } from "./grok-rich-text.js";

const HELP = [
  "Send text, photos, or file attachments to your selected Grok agent.",
  "",
  "/agents - list agents",
  "/use <exact name> - select an agent",
  "/status - show the selected agent",
  "/mirror status|on|off - control configured desktop mirroring",
  "/skills - list the selected agent's live skills",
  "/run <exact skill> [request] - run a skill",
  "/routines - list routines available to @ mention",
  "/mentions - list structured @ references",
  "/plugins - list box plugin connection status",
  "/settings - explain desktop-only settings actions",
  "/commands - show this help",
  "/help - show this help",
  "",
  "Telegram attachments are limited to 20 MB. Supported approvals offer only Approve once or Deny.",
  "Telegram-safe routine choice cards are one-time actions and expire in 12 hours.",
].join("\n");

/**
 * Optional group fast-path keywords (TELEGRAM_GROUP_KEYWORDS). A group message
 * whose text/caption contains one of these is forwarded without the soft-forward
 * hint, like a mention. Empty by default: only mentions, slash commands and
 * replies to the bot take the fast path.
 */
export const DEFAULT_GROUP_KEYWORDS = Object.freeze([]);

/** Normalized exact-match group chatter that should not wake the bot. */
export const GROUP_NOISE_EXACT = Object.freeze(new Set([
  "ok",
  "okay",
  "okok",
  "kk",
  "k",
  "lol",
  "lmao",
  "haha",
  "hahaha",
  "hehe",
  "hihi",
  "哈哈",
  "哈哈哈",
  "呵呵",
  "嗯",
  "哦",
  "喔",
  "好",
  "好的",
  "好滴",
  "收到",
  "谢谢",
  "多谢",
  "thx",
  "thanks",
  "thank you",
  "ty",
  "np",
  "cool",
  "nice",
  "yep",
  "yup",
  "yeah",
  "yes",
  "no",
  "nope",
  "👍",
  "😂",
  "🙏",
  "👀",
  "😊",
  "😄",
  "✅",
  "👌",
  "❤️",
  "💯",
]));

/** Sentinel reply texts: intentional Telegram silence (exact trim match). */
export const TELEGRAM_NO_REPLY_SENTINELS = Object.freeze(new Set([
  "NO_TELEGRAM_REPLY",
  "[NO_TELEGRAM_REPLY]",
  "⟦noreply⟧",
]));

const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF\u2060]/g;
const LETTER_DIGIT_CJK_RE = /[0-9A-Za-z\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** Trim, lower-case, strip zero-width characters. */
export function normalizeGroupNoiseText(text) {
  if (typeof text !== "string") return "";
  return text.replace(ZERO_WIDTH_RE, "").trim().toLocaleLowerCase();
}

/** True for exact ack/emoji noise or short punctuation/emoji-only chatter. */
export function isGroupNoiseText(text) {
  const normalized = normalizeGroupNoiseText(text);
  if (!normalized) return true;
  if (GROUP_NOISE_EXACT.has(normalized)) return true;
  // Pure emoji / punctuation-only (≤6 chars, no letters/digits/CJK).
  if (normalized.length <= 6 && !LETTER_DIGIT_CJK_RE.test(normalized)) return true;
  return false;
}

/**
 * True for stickers/animations without usable caption, or service/empty
 * chatter. False when photo/document/video/voice/audio/video_note (caption
 * optional), or text itself is not noise — voice notes are soft-forwarded.
 */
export function isGroupNoiseMessage(message) {
  if (!message || typeof message !== "object") return true;
  const text = typeof message.text === "string" ? message.text
    : typeof message.caption === "string" ? message.caption
      : "";
  const trimmed = text.trim();
  const hasMeaningfulText = trimmed.length >= 2 && !isGroupNoiseText(trimmed);

  // Service / membership noise
  if (message.new_chat_members || message.left_chat_member || message.new_chat_title
    || message.new_chat_photo || message.delete_chat_photo || message.group_chat_created
    || message.supergroup_chat_created || message.migrate_to_chat_id || message.migrate_from_chat_id
    || message.pinned_message || message.message_auto_delete_timer_changed) {
    return true;
  }

  if (message.sticker || message.animation) {
    return !hasMeaningfulText;
  }
  if (message.voice || message.video_note || message.audio
    || message.photo || message.document || message.video) {
    // Media with any caption that is not noise, or meaningful text → not noise.
    if (hasMeaningfulText) return false;
    if (trimmed && !isGroupNoiseText(trimmed)) return false;
    // Captionless media still soft-forwards (photo, scan, voice memo).
    return false;
  }
  if (!trimmed) return true;
  return isGroupNoiseText(trimmed);
}

/** True when agent reply is intentional Telegram silence (no attachments). */
export function isSilentTelegramReply(text, attachments = []) {
  if (Array.isArray(attachments) && attachments.length > 0) return false;
  if (typeof text !== "string") return false;
  return TELEGRAM_NO_REPLY_SENTINELS.has(text.trim());
}

/** True when a prompt context / nonce belongs to an inbound Telegram turn. */
export function isTelegramOriginContext(context = {}, fallbackNonce) {
  if (context?.origin === "telegram") return true;
  const nonce = fallbackNonce
    ?? context?.clientNonce
    ?? context?.contextKey;
  return typeof nonce === "string" && nonce.startsWith("telegram:");
}

/** True when Telegram marks the message as forwarded (Bot API 7+ or legacy fields). */
export function isForwardedTelegramMessage(message) {
  return Boolean(message?.forward_origin || message?.forward_from || message?.forward_from_chat
    || message?.forward_sender_name || message?.forward_date);
}

/** Format the live Telegram sender identity for Grok prompt context. */
export function formatTelegramSenderHeader(from, { forwarded = false } = {}) {
  const fields = [];
  const id = from?.id;
  if (Number.isSafeInteger(id) || (typeof id === "string" && /^-?\d+$/.test(id.trim()))) {
    fields.push(`id=${String(id).trim()}`);
  }
  const name = [from?.first_name, from?.last_name]
    .filter((part) => typeof part === "string" && part.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (name) fields.push(`name=${name}`);
  if (typeof from?.username === "string") {
    const username = from.username.trim().replace(/^@+/, "");
    if (username) fields.push(`username=@${username}`);
  }
  if (fields.length && forwarded) fields.push("forwarded=yes");
  return fields.length ? `[telegram-from] ${fields.join(" ")}` : "";
}

/** Chat identity header: `[telegram-chat] id=<chat id> type=<private|group|supergroup>`. */
export function formatTelegramChatHeader(chat) {
  const id = chat?.id;
  if (!Number.isSafeInteger(id)) return "";
  const type = typeof chat?.type === "string" && /^[a-z_]+$/.test(chat.type) ? chat.type : "unknown";
  return `[telegram-chat] id=${id} type=${type}`;
}

function stripTelegramContextHeaders(text) {
  if (typeof text !== "string") return text;
  return text.replace(
    /^(?:\[telegram-(?:from|topic|chat|group|group-hybrid)\][^\r\n]*(?:\r?\n|$)\s*)+/u,
    "",
  ).trim();
}

/** Drop leading Transcript: blocks from voice replies so Telegram users see only the answer. */
export function stripTranscriptPreamble(text) {
  if (typeof text !== "string" || !text.trim()) return text;
  let out = text.trimStart();
  // "Transcript: …" on its own first line (optionally followed by blank lines)
  out = out.replace(/^Transcript\s*[:：]\s*[^\r\n]*(?:\r?\n)+/iu, "");
  // Whole message is only a transcript line with no body — drop the label, keep spoken text after colon
  if (/^Transcript\s*[:：]\s*/iu.test(out) && !/\r?\n/.test(out)) {
    out = out.replace(/^Transcript\s*[:：]\s*/iu, "");
  } else {
    out = out.replace(/^Transcript\s*[:：]\s*/iu, "");
  }
  return out.trimStart();
}


/** Prefer forum_topic_created / edited on the message or reply chain. */
export function resolveTelegramTopicName(message, topicNames = new Map()) {
  const candidates = [
    message?.forum_topic_created?.name,
    message?.forum_topic_edited?.name,
    message?.reply_to_message?.forum_topic_created?.name,
    message?.reply_to_message?.forum_topic_edited?.name,
  ];
  for (const name of candidates) {
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  const threadId = message?.message_thread_id;
  if (Number.isSafeInteger(threadId) && topicNames instanceof Map && topicNames.has(threadId)) {
    return topicNames.get(threadId);
  }
  if (Number.isSafeInteger(threadId) && topicNames && typeof topicNames === "object" && !(topicNames instanceof Map)) {
    const mapped = topicNames[threadId] ?? topicNames[String(threadId)];
    if (typeof mapped === "string" && mapped.trim()) return mapped.trim();
  }
  return undefined;
}

/** Header when message_thread_id is present; name optional. */
export function formatTelegramTopicHeader(message, topicNames = new Map()) {
  if (!Number.isSafeInteger(message?.message_thread_id)) return "";
  const fields = [`id=${message.message_thread_id}`];
  const name = resolveTelegramTopicName(message, topicNames);
  if (name) fields.push(`name=${name}`);
  return `[telegram-topic] ${fields.join(" ")}`;
}

/** Forum General is thread 1; some General messages omit message_thread_id. */
export function effectiveForumTopicId(message) {
  if (Number.isSafeInteger(message?.message_thread_id)) return message.message_thread_id;
  if (message?.chat?.is_forum === true) return 1;
  return undefined;
}

const GROUP_HYBRID_HINT_TAG = "[telegram-group-hybrid]";
/**
 * Default soft-forward hint for unmapped group traffic. Override the instruction
 * text with TELEGRAM_GROUP_HINT; the [telegram-group-hybrid] tag is kept.
 */
const GROUP_HYBRID_HINT = `${GROUP_HYBRID_HINT_TAG} Reply only if this message is a request you can help with or is addressed to you. Otherwise reply exactly NO_TELEGRAM_REPLY.`;

/** Normalize a TELEGRAM_GROUP_HINT override; always starts with the hybrid tag. */
export function buildGroupHybridHint(override) {
  const text = typeof override === "string" ? override.replace(/\s+/g, " ").trim() : "";
  if (!text) return GROUP_HYBRID_HINT;
  return text.startsWith(GROUP_HYBRID_HINT_TAG) ? text : `${GROUP_HYBRID_HINT_TAG} ${text}`;
}

/** Normalize TELEGRAM_GROUP_KEYWORDS (array or comma-separated string). */
export function normalizeGroupKeywords(keywords) {
  const list = Array.isArray(keywords)
    ? keywords
    : typeof keywords === "string" ? keywords.split(",") : DEFAULT_GROUP_KEYWORDS;
  return Object.freeze([...new Set(list
    .map((keyword) => (typeof keyword === "string" ? keyword.trim().toLocaleLowerCase() : ""))
    .filter(Boolean))]);
}
/** Generic hint for forum topics routed to a dedicated agent via TELEGRAM_TOPIC_AGENTS. */
const GROUP_TOPIC_AGENT_HINT = "[telegram-group] Reply only if this is part of your job or addressed to you; otherwise reply exactly NO_TELEGRAM_REPLY.";

const APPROVAL_TTL_MS = 10 * 60_000;
const ROUTINE_WIDGET_TTL_MS = 12 * 60 * 60_000;
const APPROVAL_TEXT_LIMIT = 3_500;
const SKILL_LIST_LIMIT = 20;
const ROUTINE_WIDGET_CALLBACK = /^gtw:([A-Za-z0-9_-]{24}):([0-9a-z])$/;
const ROUTINE_WIDGET_NONCE = /^telegram:widget:([A-Za-z0-9_-]{24}):[0-9a-z]$/;
const ATTACHMENT_READ_ATTEMPTS = 5;
const ATTACHMENT_READ_BACKOFF_MIN_MS = 300;
const ATTACHMENT_READ_BACKOFF_MAX_MS = 800;

function approvalDetails(entry) {
  if (entry?.message?.type === "auto-review-approval") {
    const approval = entry.message.approval;
    return {
      type: "auto-review",
      requestId: approval.requestId,
      title: "Grok approval required",
      fields: [
        ["Action", approval.summary],
        ["Command", approval.command],
        ["Reason", approval.reason],
        ["Proposed rule", approval.proposedRule],
        ["Surface", approval.surface],
      ],
    };
  }
  if (entry?.message?.type === "local-tool-permission") {
    const ask = entry.message.ask;
    return {
      type: "local-tool",
      requestId: ask.requestId,
      title: "Local computer permission required",
      fields: [
        ["Action", ask.action],
        ["Target", ask.target],
        ["Description", ask.description],
      ],
    };
  }
  return undefined;
}

function telegramSafeRoutineWidget(entry) {
  if (entry?.kind !== "send-message" || entry.message?.type !== "widget") return undefined;
  const widget = entry.message.widget;
  if (!widget || typeof widget.prompt !== "string" || !widget.prompt.trim()) return undefined;
  if (!Array.isArray(widget.options) || widget.options.length < 1 || widget.options.length > 10) {
    return undefined;
  }
  const choices = [];
  for (const option of widget.options) {
    if (typeof option?.label !== "string" || !option.label.trim()) return undefined;
    if (typeof option?.value !== "string" || !option.value.trim()) return undefined;
    choices.push({
      label: option.label.trim().slice(0, 64),
      value: option.value,
    });
  }
  const helpText = typeof widget.helpText === "string" ? widget.helpText.trim() : "";
  const text = [widget.prompt.trim(), helpText].filter(Boolean).join("\n\n");
  if (!text || text.length > APPROVAL_TEXT_LIMIT) return undefined;
  return { text, choices };
}

function routineWidgetNonce(token, choiceIndex) {
  return `telegram:widget:${token}:${choiceIndex.toString(36)}`;
}

function formatApproval(details) {
  const lines = [`⚠️ ${details.title}`, ""];
  for (const [label, value] of details.fields) {
    if (value === undefined || value === null || value === "") continue;
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    lines.push(`${label}:`, rendered, "");
  }
  lines.push("This authorization applies to this request only and expires in 10 minutes.");
  return lines.join("\n");
}

function newestTranscriptEntryId(entries) {
  return [...entries].reverse().find((entry) => typeof entry?.id === "string" && entry.id)?.id;
}

function messageAttachments(message) {
  const attachments = [];
  const largestPhoto = message.photo?.at(-1);
  if (largestPhoto?.file_id) {
    attachments.push({ fileId: largestPhoto.file_id, filename: `telegram-photo-${message.message_id ?? "upload"}.jpg` });
  }
  for (const [kind, fallback] of [
    ["document", "telegram-file.bin"],
    ["audio", "telegram-audio.bin"],
    ["voice", "telegram-voice.ogg"],
    ["video", "telegram-video.mp4"],
    ["video_note", "telegram-video-note.mp4"],
  ]) {
    const media = message[kind];
    if (media?.file_id) attachments.push({ fileId: media.file_id, filename: media.file_name || fallback });
  }
  return attachments;
}

function withVoiceHint(prompt, voiceHint) {
  const hint = typeof voiceHint === "string" ? voiceHint.trim() : "";
  return hint ? `${prompt} ${hint}` : prompt;
}

function defaultAttachmentPrompt(message, voiceHint) {
  if (message.voice) return withVoiceHint("Voice note attached. Understand what I said and reply in one final natural message to the user (no progress updates). Prefer listening to the attachment directly. Do NOT install packages or download speech models mid-request. Do NOT include a Transcript: line or raw transcript dump in the user-visible reply — just answer as if you heard them.", voiceHint);
  if (message.audio) return withVoiceHint("Audio attached. Understand it and reply in one final natural message. Do NOT install packages or download speech models mid-request. Do NOT put Transcript: or a raw transcript dump in the user-visible reply.", voiceHint);
  if (message.photo) return "Examine the attached image and tell me what you find.";
  return "Examine the attached file and tell me what you find.";
}

/** Neutral attachment prompt for topic-routed agents (they decide replies themselves). */
function topicAgentAttachmentPrompt(message, voiceHint) {
  if (message.voice) return withVoiceHint("[voice note attached] Do not install packages or download speech models to transcribe it.", voiceHint);
  if (message.audio) return "[audio attached]";
  if (message.photo) return "[photo attached]";
  if (message.video || message.video_note) return "[video attached]";
  return "[file attached]";
}

/** True for Telegram documents that are images (sent "as file", uncompressed). */
export function isImageDocument(document) {
  if (!document || typeof document !== "object") return false;
  if (typeof document.mime_type === "string" && /^image\//i.test(document.mime_type)) return true;
  return typeof document.file_name === "string"
    && /\.(?:jpe?g|png|webp|heic|heif|gif|bmp|tiff?)$/i.test(document.file_name);
}

function hasTelegramMedia(message) {
  return Boolean(message?.photo || message?.document || message?.video || message?.video_note
    || message?.voice || message?.audio || message?.sticker || message?.animation);
}

/** `[photos attached: N]` for image-only bundles, otherwise a typed attachment count. */
export function formatBundleAttachmentLabel(messages) {
  const counts = { photo: 0, video: 0, audio: 0, file: 0 };
  for (const message of messages ?? []) {
    if (message?.photo || isImageDocument(message?.document)) counts.photo += 1;
    else if (message?.video || message?.video_note) counts.video += 1;
    else if (message?.voice || message?.audio) counts.audio += 1;
    else if (message?.document) counts.file += 1;
  }
  const total = counts.photo + counts.video + counts.audio + counts.file;
  if (total > 0 && total === counts.photo) return `[photos attached: ${total}]`;
  const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const parts = [
    counts.photo ? plural(counts.photo, "photo") : "",
    counts.video ? plural(counts.video, "video") : "",
    counts.audio ? plural(counts.audio, "audio file") : "",
    counts.file ? plural(counts.file, "file") : "",
  ].filter(Boolean);
  return `[attachments: ${total}${parts.length ? ` (${parts.join(", ")})` : ""}]`;
}

function uniqueAttachmentNames(attachments) {
  const seen = new Map();
  return attachments.map((attachment) => {
    const name = attachment.filename || "telegram-file.bin";
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count === 0) return attachment;
    const dot = name.lastIndexOf(".");
    const renamed = dot > 0 ? `${name.slice(0, dot)}-${count + 1}${name.slice(dot)}` : `${name}-${count + 1}`;
    return { ...attachment, filename: renamed };
  });
}

function normalize(value) {
  return value.trim().toLocaleLowerCase();
}

function availableWorkflows(workflows) {
  return workflows.filter((workflow) => workflow?.id && workflow?.name
    && (workflow.source === "automation" || workflow.isEnabledForAgent === true));
}

function splitWorkflows(workflows) {
  const available = availableWorkflows(workflows);
  return {
    skills: available.filter((workflow) => workflow.trigger == null),
    routines: available.filter((workflow) => workflow.trigger != null),
  };
}

function matchSkillInvocation(argumentsText, skills) {
  const normalized = normalize(argumentsText);
  return [...skills]
    .sort((left, right) => right.name.length - left.name.length)
    .find((skill) => normalized === normalize(skill.name)
      || normalized.startsWith(`${normalize(skill.name)} `));
}

function workflowReference(workflow) {
  return {
    type: "workflowReference",
    id: workflow.id,
    label: workflow.name,
    iconId: workflow.iconId ?? workflow.icon?.iconId,
    iconUrl: workflow.iconUrl ?? workflow.icon?.iconUrl,
  };
}

function workflowPrompt(skill, argumentsText) {
  const request = argumentsText.slice(skill.name.length).trim();
  return `@${skill.name}${request ? ` ${request}` : ""}`;
}

function routineDescription(routine) {
  return routine.scheduleDescription ?? routine.trigger?.schedule ?? "triggered routine";
}


function defaultAttachmentReadBackoffMs(attemptIndex) {
  if (ATTACHMENT_READ_ATTEMPTS <= 2) return ATTACHMENT_READ_BACKOFF_MIN_MS;
  const span = ATTACHMENT_READ_BACKOFF_MAX_MS - ATTACHMENT_READ_BACKOFF_MIN_MS;
  const t = attemptIndex / Math.max(1, ATTACHMENT_READ_ATTEMPTS - 2);
  return Math.round(ATTACHMENT_READ_BACKOFF_MIN_MS + (span * t));
}

/** Permanent attachment failures should not burn the retry budget. */
export function isRetryableAttachmentReadError(error) {
  const message = String(error?.message ?? error ?? "");
  if (/exceeds 20 MB|empty or exceeds|unsupported data attachment|invalid file attachment URL/i.test(message)) {
    return false;
  }
  return true;
}

function attachmentDisplayName(attachment) {
  if (typeof attachment?.filename === "string" && attachment.filename.trim()) {
    return attachment.filename.trim();
  }
  if (typeof attachment?.path === "string" && attachment.path) {
    return attachment.path.split("/").at(-1) || "file";
  }
  return "file";
}

export class Bridge {
  constructor({
    telegram,
    grok,
    state,
    allowedUserIds,
    allowedChatIds,
    defaultAgent,
    mirrorChatId,
    mirrorUserId,
    allowedTopicIds,
    topicNames,
    topicAgents,
    groupKeywords = DEFAULT_GROUP_KEYWORDS,
    groupHint,
    voicePromptHint,
    attachmentReadAttempts = ATTACHMENT_READ_ATTEMPTS,
    attachmentReadBackoffMs = defaultAttachmentReadBackoffMs,
  }) {
    Object.assign(this, {
      telegram,
      grok,
      state,
      allowedUserIds,
      allowedChatIds,
      defaultAgent,
      mirrorChatId,
      mirrorUserId,
      allowedTopicIds: allowedTopicIds instanceof Set ? allowedTopicIds : new Set(allowedTopicIds ?? []),
      topicNames: topicNames instanceof Map
        ? topicNames
        : new Map(Object.entries(topicNames ?? {}).map(([id, name]) => [Number(id), name])),
      topicAgents: Array.isArray(topicAgents) ? topicAgents : [],
      groupKeywords: normalizeGroupKeywords(groupKeywords),
      groupHybridHint: buildGroupHybridHint(groupHint),
      voicePromptHint: typeof voicePromptHint === "string" ? voicePromptHint.trim() : "",
      attachmentReadAttempts,
      attachmentReadBackoffMs,
    });
    this.botUsername = undefined;
    this.firstWatchSnapshots = new Map();
    this.agentMirrorQueues = new Map();
    this.widgetCallbackQueues = new Map();
    // chatId -> Map(threadId -> name); seeded from persisted state.
    this.learnedTopicNames = new Map();
    const persisted = typeof this.state?.listTopicNames === "function" ? this.state.listTopicNames() : undefined;
    for (const [chatKey, names] of Object.entries(persisted ?? {})) {
      for (const [threadKey, name] of Object.entries(names ?? {})) {
        if (/^-?\d+$/.test(chatKey) && /^\d+$/.test(threadKey) && typeof name === "string" && name) {
          this.learnedTopicMap(Number(chatKey)).set(Number(threadKey), name);
        }
      }
    }
  }

  learnedTopicMap(chatId) {
    const key = String(chatId);
    if (!this.learnedTopicNames.has(key)) this.learnedTopicNames.set(key, new Map());
    return this.learnedTopicNames.get(key);
  }

  isGroupChat(chat) {
    return chat?.type === "group" || chat?.type === "supergroup";
  }

  /**
   * Learn forum topic names from forum_topic_created / forum_topic_edited service
   * messages and from reply_to_message.forum_topic_created, which Telegram attaches
   * to ordinary (non-reply) messages inside a topic. Persisted in the state file.
   */
  async learnTopicNameFromMessage(message) {
    if (!this.isGroupChat(message?.chat)) return;
    if (message.chat.is_forum !== true && message.is_topic_message !== true) return;
    const threadId = Number.isSafeInteger(message?.message_thread_id)
      ? message.message_thread_id
      : undefined;
    const name = resolveTelegramTopicName(message, new Map());
    if (threadId === undefined || !name) return;
    const learned = this.learnedTopicMap(message.chat.id);
    if (learned.get(threadId) === name) return;
    learned.set(threadId, name);
    console.error(`topic learned chat=${message.chat.id} id=${threadId} name=${name}`);
    try {
      await this.state.setTopicName?.(message.chat.id, threadId, name);
    } catch (error) {
      console.error(`Could not persist learned topic name: ${error.message}`);
    }
  }

  topicNameLookup(chatId) {
    const merged = new Map(this.topicNames);
    const learned = chatId === undefined ? undefined : this.learnedTopicNames.get(String(chatId));
    for (const [id, name] of learned ?? []) merged.set(id, name);
    return merged;
  }

  /**
   * Agent id/name mapped to this message's forum topic via TELEGRAM_TOPIC_AGENTS
   * (id match wins over name match). Undefined for DMs and unmapped topics.
   */
  topicAgentFor(message) {
    if (!this.topicAgents.length || !this.isGroupChat(message?.chat)) return undefined;
    const isForum = message.chat.is_forum === true || Number.isSafeInteger(message.message_thread_id);
    if (!isForum) return undefined;
    const topicId = effectiveForumTopicId(message);
    if (topicId === undefined) return undefined;
    const byId = this.topicAgents.find((route) => route.topicId === topicId);
    if (byId) return byId.agent;
    const name = resolveTelegramTopicName(message, this.topicNameLookup(message.chat.id));
    if (!name) return undefined;
    const wanted = normalize(name);
    return this.topicAgents.find((route) => route.topicName !== undefined
      && normalize(route.topicName) === wanted)?.agent;
  }

  /** Dispatcher queue key: topic-routed agents get their own per-chat queue. */
  queueKeyForUpdate(update) {
    const message = update?.message;
    const chatKey = String(message?.chat?.id ?? "unknown");
    const topicAgent = this.topicAgentFor(message);
    return topicAgent ? `${chatKey}:agent:${topicAgent}` : chatKey;
  }

  /**
   * DMs are never topic-filtered. Empty allowlist = all topics (safe default).
   * Forum General (missing thread) counts as id 1. Non-forum groups are not filtered.
   */
  isTopicAllowlisted(message) {
    if (!this.isGroupChat(message?.chat)) return true;
    if (!this.allowedTopicIds || this.allowedTopicIds.size === 0) return true;
    const isForum = message?.chat?.is_forum === true
      || Number.isSafeInteger(message?.message_thread_id);
    if (!isForum) return true;
    const topicId = effectiveForumTopicId(message);
    if (topicId === undefined) return true;
    return this.allowedTopicIds.has(topicId) || this.topicAgentFor(message) !== undefined;
  }

  deliveryOptionsFromMessage(message) {
    const options = {};
    if (Number.isSafeInteger(message?.message_thread_id)) {
      options.messageThreadId = message.message_thread_id;
    }
    return options;
  }

  async ensureBotUsername(options = {}) {
    if (this.botUsername && this.botId !== undefined) return this.botUsername;
    if (typeof this.telegram.getMe === "function") {
      const me = await this.telegram.getMe(options);
      if (typeof me?.username === "string" && me.username) {
        this.botUsername = me.username;
      }
      if (Number.isSafeInteger(me?.id)) {
        this.botId = me.id;
      }
    }
    return this.botUsername;
  }

  messagePlainText(message) {
    if (typeof message?.text === "string") return message.text;
    if (typeof message?.caption === "string") return message.caption;
    return "";
  }

  isBotMentioned(message, botUsername) {
    if (!botUsername || !message) return false;
    const username = botUsername.replace(/^@/, "");
    const text = this.messagePlainText(message);
    const entities = [
      ...(Array.isArray(message.entities) ? message.entities : []),
      ...(Array.isArray(message.caption_entities) ? message.caption_entities : []),
    ];
    for (const entity of entities) {
      if (entity?.type === "mention" && typeof entity.offset === "number" && typeof entity.length === "number") {
        const mention = text.slice(entity.offset, entity.offset + entity.length);
        if (mention.toLocaleLowerCase() === `@${username}`.toLocaleLowerCase()) return true;
      }
      if (entity?.type === "text_mention") {
        const mentioned = entity.user?.username;
        if (typeof mentioned === "string"
          && mentioned.toLocaleLowerCase() === username.toLocaleLowerCase()) {
          return true;
        }
        if (Number.isSafeInteger(entity.user?.id) && entity.user.id === this.botId) {
          return true;
        }
      }
    }
    return new RegExp(`@${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
  }

  /** True when the message replies to a message from this bot (id or username). */
  isReplyToThisBot(message, botUsername) {
    const replyFrom = message?.reply_to_message?.from;
    if (!replyFrom || replyFrom.is_bot !== true) return false;
    if (Number.isSafeInteger(this.botId) && replyFrom.id === this.botId) return true;
    const username = String(botUsername || this.botUsername || "").replace(/^@/, "");
    if (username && typeof replyFrom.username === "string"
      && replyFrom.username.toLocaleLowerCase() === username.toLocaleLowerCase()) {
      return true;
    }
    return false;
  }

  /** True when text/caption matches a TELEGRAM_GROUP_KEYWORDS entry (case-insensitive). */
  hasGroupKeyword(text) {
    if (typeof text !== "string" || !text.trim()) return false;
    const haystack = text.toLocaleLowerCase();
    for (const keyword of this.groupKeywords ?? []) {
      const needle = keyword.toLocaleLowerCase();
      // CJK / multi-word phrases: substring. Latin tokens: word-boundary-ish.
      if (/[^\x00-\x7f]/.test(keyword) || /\s/.test(keyword)) {
        if (haystack.includes(needle)) return true;
        continue;
      }
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(?:^|[^a-z0-9_])${escaped}(?:[^a-z0-9_]|$)`, "i").test(haystack)) {
        return true;
      }
    }
    return false;
  }

  /** Directly addressed: slash command, bot mention, or reply to this bot. */
  isDirectGroupAddress(message, botUsername) {
    const text = this.messagePlainText(message).trim();
    if (text.startsWith("/")) return true;
    if (this.isBotMentioned(message, botUsername)) return true;
    if (this.isReplyToThisBot(message, botUsername)) return true;
    return false;
  }

  /** Fast-path: mention, slash, reply-to-bot, or a configured group keyword. */
  isGroupFastPath(message, botUsername) {
    if (this.isDirectGroupAddress(message, botUsername)) return true;
    return this.hasGroupKeyword(this.messagePlainText(message).trim());
  }

  /**
   * Topics routed to a dedicated agent skip the group keyword filter: forward
   * every real text, photo (captionless too), document, video and voice note;
   * drop only pure noise (stickers, bare acks, service messages).
   */
  shouldHandleTopicAgentMessage(message, botUsername) {
    if (this.isDirectGroupAddress(message, botUsername)) return true;
    return !isGroupNoiseMessage(message);
  }

  shouldHandleGroupMessage(message, botUsername) {
    if (this.isGroupFastPath(message, botUsername)) return true;
    if (isGroupNoiseMessage(message)) return false;
    const text = this.messagePlainText(message).trim();
    // Soft-forward: photo/document/video/voice/audio/video_note (caption optional).
    if (message?.photo || message?.document || message?.video
      || message?.voice || message?.video_note || message?.audio) return true;
    // Soft-forward: meaningful non-noise text (length ≥ 2 after trim).
    if (text && !isGroupNoiseText(text) && text.length >= 2) return true;
    return false;
  }

  stripBotMention(text, botUsername) {
    if (!botUsername || typeof text !== "string") return text;
    const username = botUsername.replace(/^@/, "");
    const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text
      .replace(new RegExp(`@${escaped}\\b`, "gi"), "")
      .replace(/\s+/g, " ")
      .trim();
  }

  isAuthorized(message) {
    const chat = message?.chat;
    if (!chat) return false;
    if (chat.type === "private") {
      return this.allowedUserIds.has(message?.from?.id)
        && this.allowedChatIds.has(chat.id);
    }
    if (this.isGroupChat(chat)) {
      return this.allowedChatIds.has(chat.id);
    }
    return false;
  }

  isAuthorizedCallback(callback) {
    const chat = callback?.message?.chat;
    if (!chat) return false;
    if (chat.type === "private") {
      return this.allowedUserIds.has(callback?.from?.id)
        && this.allowedChatIds.has(chat.id);
    }
    if (this.isGroupChat(chat)) {
      return this.allowedChatIds.has(chat.id);
    }
    return false;
  }

  resolveAgent(chatId, agents, message) {
    const topicAgent = message ? this.topicAgentFor(message) : undefined;
    if (topicAgent) {
      return agents.find((agent) => agent.id === topicAgent)
        || agents.find((agent) => normalize(agent.name) === normalize(topicAgent));
    }
    const selectedId = this.state.getAgent(chatId);
    if (selectedId) {
      const selected = agents.find((agent) => agent.id === selectedId);
      if (selected) return selected;
      return undefined;
    }
    const wanted = String(this.defaultAgent || "").trim();
    return agents.find((agent) => agent.id === wanted)
      || agents.find((agent) => normalize(agent.name) === normalize(wanted));
  }

  isMirrorConfigured() {
    return this.mirrorChatId !== undefined && this.mirrorUserId !== undefined;
  }

  isMirrorController(message) {
    return this.isMirrorConfigured()
      && message?.chat?.id === this.mirrorChatId
      && message?.from?.id === this.mirrorUserId;
  }

  mirrorEnabled() {
    return this.state.isMirrorEnabled(this.isMirrorConfigured());
  }

  async getTranscriptEntries(agentId, options = {}) {
    try {
      return await this.grok.getTranscriptTail(agentId, 200, options);
    } catch (error) {
      if (!/HTTP 404$/.test(error.message)) throw error;
      return this.grok.getTranscript(agentId, options);
    }
  }

  async mirrorAgentBusy(agentId, options = {}) {
    if (options.agent?.isRunning === true || options.agent?.isComposingMessage === true) return true;
    return typeof this.grok.isAgentBusy === "function"
      ? this.grok.isAgentBusy(agentId, options)
      : false;
  }

  async ensureMirrorBaseline(agentId, options = {}) {
    if (!options.force && this.state.getMirrorCursor(agentId)) return false;
    let entries = await this.getTranscriptEntries(agentId, options);
    if (!entries.length && !options.force) {
      entries = await this.grok.getTranscript(agentId, options);
    }
    const newestId = newestTranscriptEntryId(entries);
    if (!options.force && !entries.length) return true;
    if (!options.force && await this.mirrorAgentBusy(agentId, options)) {
      if (!this.firstWatchSnapshots.has(agentId)) {
        this.firstWatchSnapshots.set(agentId, newestId ?? null);
      }
      return true;
    }
    const snapshot = this.firstWatchSnapshots.get(agentId);
    this.firstWatchSnapshots.delete(agentId);
    if (snapshot !== undefined) {
      await this.state.setMirrorCursor(agentId, snapshot);
      return false;
    }
    await this.state.setMirrorCursor(agentId, newestId);
    return true;
  }

  async handleMirrorCommand(message, argument, options = {}) {
    if (!this.isMirrorConfigured()) {
      await this.telegram.sendMessage(
        message.chat.id,
        "Desktop mirroring is not configured. Set both GROK_DESKTOP_MIRROR_CHAT_ID and GROK_DESKTOP_MIRROR_USER_ID in .env, then restart the bridge.",
        options,
      );
      return;
    }
    if (!this.isMirrorController(message)) {
      await this.telegram.sendMessage(
        message.chat.id,
        "Only the configured desktop-mirror user in the configured mirror chat can control mirroring.",
        options,
      );
      return;
    }
    const action = argument.toLocaleLowerCase();
    if (!action || action === "status") {
      await this.telegram.sendMessage(
        message.chat.id,
        `Desktop mirroring is ${this.mirrorEnabled() ? "on" : "off"}.`,
        options,
      );
      return;
    }
    if (action === "off") {
      await this.state.setMirrorEnabled(false);
      await this.telegram.sendMessage(message.chat.id, "Desktop mirroring is off.", options);
      return;
    }
    if (action === "on") {
      const agents = await this.grok.listAgents(options);
      const agent = this.resolveAgent(this.mirrorChatId, agents);
      if (!agent) {
        await this.telegram.sendMessage(
          message.chat.id,
          "Could not find the selected mirror agent. Use /agents and /use before enabling mirroring.",
          options,
        );
        return;
      }
      await this.ensureMirrorBaseline(agent.id, { ...options, force: true });
      await this.state.setMirrorEnabled(true);
      await this.telegram.sendMessage(message.chat.id, `Desktop mirroring is on for ${agent.name}.`, options);
      return;
    }
    await this.telegram.sendMessage(message.chat.id, "Use /mirror status, /mirror on, or /mirror off.", options);
  }

  /**
   * Media-bundling classification used by UpdateDispatcher. Returns undefined for
   * updates that must bypass bundling (callbacks, unauthorized, not allowlisted,
   * unknown sender). senderKey scopes bundles to queue + topic + sender:
   * - role "media": album item (media_group_id) or loose photo / image document
   * - role "text": plain non-command text that may attach to an open bundle
   * - role "other": everything else (voice, video, commands...) flushes first
   */
  classifyForBundling(update) {
    const message = update?.message;
    if (!message || !this.isAuthorized(message) || !this.isTopicAllowlisted(message)) return undefined;
    const senderId = message.sender_chat?.id ?? message.from?.id;
    if (senderId === undefined || senderId === null) return undefined;
    const topicId = effectiveForumTopicId(message) ?? "none";
    const senderKey = `${this.queueKeyForUpdate(update)}|topic=${topicId}|from=${senderId}`;
    const text = this.messagePlainText(message).trim();
    if (!text.startsWith("/")) {
      if (message.media_group_id
        && (message.photo || message.video || message.document || message.audio)) {
        return { senderKey, role: "media", album: true };
      }
      if (message.photo || isImageDocument(message.document)) {
        return { senderKey, role: "media", album: false };
      }
      if (typeof message.text === "string" && text && !hasTelegramMedia(message)) {
        return { senderKey, role: "text" };
      }
    }
    return { senderKey, role: "other" };
  }

  /**
   * Fold a bundle (same chat/topic/sender) into one representative message: the
   * first item's identity/reply/forward fields, the first media item's media
   * fields, and every item's text/caption (spoofed headers stripped per item).
   */
  combineBundledMessages(messages) {
    const first = messages[0];
    const combined = { ...first };
    delete combined.text;
    delete combined.entities;
    delete combined.caption;
    delete combined.caption_entities;
    const pieces = [];
    for (const item of messages) {
      const raw = typeof item?.text === "string" ? item.text
        : typeof item?.caption === "string" ? item.caption : "";
      const cleaned = stripTelegramContextHeaders(raw)?.trim();
      if (cleaned) pieces.push({ item, raw, cleaned });
    }
    if (pieces.length) {
      combined.caption = pieces.map((piece) => piece.cleaned).join("\n\n");
      if (pieces.length === 1 && pieces[0].cleaned === pieces[0].raw) {
        const entities = pieces[0].item.caption_entities ?? pieces[0].item.entities;
        if (Array.isArray(entities)) combined.caption_entities = entities;
      }
    }
    const replyToBot = messages.find((item) => item?.reply_to_message?.from?.is_bot === true);
    if (replyToBot) combined.reply_to_message = replyToBot.reply_to_message;
    combined.bundleMessageIds = messages.map((item) => item?.message_id);
    return combined;
  }

  async handleUpdate(update, options = {}) {
    const bundledMessages = Array.isArray(update?.bundledUpdates) && update.bundledUpdates.length > 1
      ? update.bundledUpdates.map((item) => item?.message).filter(Boolean)
      : undefined;
    const message = bundledMessages?.length > 1
      ? this.combineBundledMessages(bundledMessages)
      : update?.message;
    const isBundle = bundledMessages?.length > 1;
    const turnMessages = isBundle ? bundledMessages : [message];
    if (!this.isAuthorized(message)) {
      const chat = message?.chat;
      console.error(
        `Drop unauthorized update chat=${chat?.id ?? "none"} type=${chat?.type ?? "none"}`,
      );
      return;
    }
    for (const item of turnMessages) await this.learnTopicNameFromMessage(item);
    if (!this.isTopicAllowlisted(message)) {
      const topicId = effectiveForumTopicId(message);
      console.error(
        `Drop group topic not allowlisted chat=${message.chat.id} topic=${topicId ?? "none"}`,
      );
      return;
    }
    options = { ...options, ...this.deliveryOptionsFromMessage(message) };
    const topicAgent = this.topicAgentFor(message);
    if (this.isGroupChat(message.chat)) {
      const botUsername = await this.ensureBotUsername(options);
      const handle = topicAgent
        ? this.shouldHandleTopicAgentMessage(message, botUsername)
        : this.shouldHandleGroupMessage(message, botUsername);
      if (!handle) {
        // Log metadata only; message bodies stay out of bridge.log.
        const body = String(message.text ?? message.caption ?? "");
        const reason = topicAgent || isGroupNoiseMessage(message) || isGroupNoiseText(body)
          ? "Drop group noise"
          : "Drop group message (hybrid filter)";
        console.error(
          `${reason} chat=${message.chat.id} topic=${effectiveForumTopicId(message) ?? "none"} chars=${body.length}`,
        );
        return;
      }
    }
    const chatId = message.chat.id;
    const incomingAttachments = uniqueAttachmentNames(turnMessages.flatMap(messageAttachments));
    const messageText = typeof message.text === "string" ? message.text : message.caption;
    if ((!messageText || !messageText.trim()) && incomingAttachments.length === 0) {
      await this.telegram.sendMessage(chatId, "Send text, a photo, or a file attachment.", options);
      return;
    }

    const bundleLabel = isBundle ? formatBundleAttachmentLabel(turnMessages) : "";
    const bundleAllImages = bundleLabel.startsWith("[photos attached:");
    const attachmentPrompt = isBundle
      ? () => (topicAgent
        ? bundleLabel
        : `Examine the attached ${bundleAllImages ? "images" : "files"} and tell me what you find.`)
      : topicAgent ? topicAgentAttachmentPrompt : defaultAttachmentPrompt;
    let text = stripTelegramContextHeaders(messageText?.trim() || attachmentPrompt(message, this.voicePromptHint));
    // Bundles get the attachment-count label on its own line
    // (applied after group mention stripping so the newline survives).
    const withBundleLabel = (value) => (isBundle && value && !value.includes(bundleLabel)
      ? `${bundleLabel}\n${value}`
      : value);
    const reactAll = (emoji) => Promise.all(turnMessages.map((item) => this.telegram
      .setMessageReaction?.(chatId, item.message_id, emoji, options)?.catch?.(() => {})));
    let groupSoftForward = false;
    if (this.isGroupChat(message.chat) && !text.startsWith("/")) {
      const botUsername = await this.ensureBotUsername(options);
      groupSoftForward = topicAgent
        ? !this.isDirectGroupAddress(message, botUsername)
        : !this.isGroupFastPath(message, botUsername);
      text = this.stripBotMention(text, botUsername);
      if (!text && incomingAttachments.length === 0) {
        await this.telegram.sendMessage(
          chatId,
          "Here — mention me with a question, or try /help.",
          { ...options, replyToMessageId: message.message_id },
        );
        return;
      }
      if (!text) text = attachmentPrompt(message, this.voicePromptHint);
      text = withBundleLabel(text);
      if (groupSoftForward) {
        text = `${topicAgent ? GROUP_TOPIC_AGENT_HINT : this.groupHybridHint}\n\n${text}`;
      }
    }
    text = withBundleLabel(text);
    const [rawCommand, ...rawArguments] = text.split(/\s+/);
    const command = rawCommand.toLocaleLowerCase().split("@")[0];
    if (command === "/start" || command === "/help" || command === "/commands") {
      await this.telegram.sendMessage(chatId, HELP, options);
      return;
    }

    if (command === "/mirror") {
      await this.handleMirrorCommand(message, rawArguments.join(" ").trim(), options);
      return;
    }

    const agents = await this.grok.listAgents(options);
    if (command === "/agents") {
      const selected = this.resolveAgent(chatId, agents, message);
      const lines = agents.map((agent) => `${agent.id === selected?.id ? "*" : "-"} ${agent.name}`);
      await this.telegram.sendMessage(chatId, lines.length ? lines.join("\n") : "No Grok agents are available.", options);
      return;
    }

    if (command === "/use" && topicAgent) {
      await this.telegram.sendMessage(chatId, "This topic has a fixed agent (TELEGRAM_TOPIC_AGENTS); /use is disabled here.", options);
      return;
    }

    if (command === "/use") {
      const requested = rawArguments.join(" ").trim();
      const agent = agents.find((candidate) => normalize(candidate.name) === normalize(requested));
      if (!agent) {
        await this.telegram.sendMessage(chatId, "No exact agent-name match. Use /agents to see available names.", options);
        return;
      }
      if (this.isMirrorConfigured() && chatId === this.mirrorChatId) {
        await this.ensureMirrorBaseline(agent.id, options);
      }
      await this.state.setAgent(chatId, agent.id);
      await this.telegram.sendMessage(chatId, `Now using ${agent.name}.`, options);
      return;
    }

    const selectedId = this.state.getAgent(chatId);
    const agent = this.resolveAgent(chatId, agents, message);
    if (!agent && topicAgent) {
      // Never fall back to the default agent for a routed topic; stay quiet in the group.
      console.error(`Topic agent not found chat=${chatId} topic=${effectiveForumTopicId(message)} agent=${JSON.stringify(topicAgent)}`);
      return;
    }
    if (!agent) {
      const target = selectedId ? "selected agent" : `default agent “${this.defaultAgent}”`;
      await this.telegram.sendMessage(chatId, `Could not find the ${target}. Use /agents and /use.`, options);
      return;
    }
    if (command === "/status") {
      const activity = agent.isRunning || agent.isComposingMessage ? "working" : "idle";
      await this.telegram.sendMessage(chatId, `${agent.name} is ${activity}.`, options);
      return;
    }

    if (command === "/settings") {
      await this.telegram.sendMessage(
        chatId,
        "Chat Settings, General Settings, and Usage & Billing change the Grok desktop UI. Open Grok Bot on desktop for those actions.",
        options,
      );
      return;
    }

    const needsWorkflows = text.includes("@") || (rawCommand.startsWith("/") && command !== "/plugins");
    const workflows = needsWorkflows ? await this.grok.getAgentWorkflows(agent.id, options) : [];
    const { skills, routines } = splitWorkflows(workflows);
    if (command === "/skills") {
      const query = normalize(rawArguments.join(" "));
      const matches = query ? skills.filter((skill) => normalize(skill.name).includes(query)) : skills;
      const visible = matches.slice(0, SKILL_LIST_LIMIT);
      const lines = visible.map((skill) => `- ${skill.name}${/^[-a-z0-9_]+$/i.test(skill.name) ? ` (send /${skill.name})` : ""}`);
      const summary = matches.length > visible.length
        ? `\nShowing ${visible.length} of ${matches.length}. Narrow it with /skills <search>.`
        : "";
      await this.telegram.sendMessage(
        chatId,
        lines.length
          ? [`Skills for ${agent.name}:`, ...lines, summary, "Use /run <exact skill> [request]."].filter(Boolean).join("\n")
          : query ? `No skills match “${rawArguments.join(" ")}”.` : `${agent.name} has no enabled skills.`,
        options,
      );
      return;
    }

    if (command === "/routines") {
      const lines = routines.map((routine) => `- @${routine.name} - ${routineDescription(routine)}`);
      await this.telegram.sendMessage(
        chatId,
        lines.length ? [`Routines available to mention:`, ...lines].join("\n") : "No routines are available to mention.",
        options,
      );
      return;
    }

    if (command === "/plugins") {
      const servers = await this.grok.listMcpServers(options);
      const lines = servers.map((server) => `- ${server.serverIdentifier}: ${server.status ?? "unknown"}`);
      await this.telegram.sendMessage(
        chatId,
        lines.length
          ? ["Box plugin status:", ...lines, "", "Account-plugin @ references still require Grok Bot because its gateway does not expose their reference IDs."].join("\n")
          : "No box plugins are configured. Account plugins remain visible in Grok Bot on desktop.",
        options,
      );
      return;
    }

    if (command === "/mentions") {
      const mentionAgents = agents.filter((candidate) => candidate.id !== agent.id);
      const servers = await this.grok.listMcpServers(options);
      const lines = [
        "Agents:",
        ...(mentionAgents.length ? mentionAgents.map((candidate) => `- @${candidate.name}`) : ["- none"]),
        "",
        "Routines:",
        ...(routines.length ? routines.map((routine) => `- @${routine.name}`) : ["- none"]),
        "",
        "Box plugins:",
        ...(servers.length ? servers.map((server) => `- ${server.serverIdentifier}: ${server.status ?? "unknown"}`) : ["- none"]),
      ];
      await this.telegram.sendMessage(chatId, lines.join("\n"), options);
      return;
    }

    const argumentsText = text.slice(rawCommand.length).trim();
    let invokedSkill;
    let skillInvocationText = argumentsText;
    if (command === "/run") {
      invokedSkill = matchSkillInvocation(argumentsText, skills);
      if (!invokedSkill) {
        await this.telegram.sendMessage(chatId, "No exact skill-name match. Use /skills to see available names.", options);
        return;
      }
    } else if (rawCommand.startsWith("/")) {
      invokedSkill = skills.find((skill) => command === `/${normalize(skill.name)}`);
      if (!invokedSkill) {
        await this.telegram.sendMessage(chatId, "Unknown command. Use /help or /skills.", options);
        return;
      }
      skillInvocationText = `${invokedSkill.name}${argumentsText ? ` ${argumentsText}` : ""}`;
    }

    let references;
    if (invokedSkill) {
      text = workflowPrompt(invokedSkill, skillInvocationText);
      references = [{ start: 0, end: invokedSkill.name.length + 1, ...workflowReference(invokedSkill) }];
    } else if (text.includes("@")) {
      const candidates = [
        ...agents.filter((candidate) => candidate.id !== agent.id).map((candidate) => ({
          type: "mention",
          id: candidate.id,
          label: candidate.name,
        })),
        ...(agents.length >= 2 ? [{ type: "mention", id: "__everyone__", label: "everyone" }] : []),
        ...routines.map(workflowReference),
      ];
      references = findStructuredReferences(text, candidates);
    }
    const headerLines = [];
    const senderHeader = formatTelegramSenderHeader(message.from, {
      forwarded: isForwardedTelegramMessage(message),
    });
    if (senderHeader) headerLines.push(senderHeader);
    const chatHeader = formatTelegramChatHeader(message.chat);
    if (chatHeader) headerLines.push(chatHeader);
    const topicHeader = formatTelegramTopicHeader(message, this.topicNameLookup(chatId));
    if (topicHeader) headerLines.push(topicHeader);
    if (headerLines.length) {
      const promptPrefix = `${headerLines.join("\n")}\n\n`;
      text = `${promptPrefix}${text}`;
      references = references?.map((reference) => ({
        ...reference,
        start: reference.start + promptPrefix.length,
        end: reference.end + promptPrefix.length,
      }));
    }
    const richText = buildRichText(text, references ?? []);
    await this.telegram.sendChatAction?.(chatId, "typing", options).catch(() => {});
    await reactAll("👀");
    const attachmentPaths = [];
    const attachmentNames = [];
    for (const attachment of incomingAttachments) {
      const downloaded = await this.telegram.downloadFile(attachment.fileId, options);
      const filename = attachment.filename || downloaded.filename;
      attachmentPaths.push(await this.grok.uploadAttachment(agent.id, filename, downloaded.bytes, options));
      attachmentNames.push(filename);
    }
    const clientNonce = `telegram:${update.update_id}:${chatId}:${message.message_id ?? 0}${isBundle ? `:b${turnMessages.length}` : ""}`;
    if (isBundle) {
      console.error(`Media bundle turn chat=${chatId} topic=${effectiveForumTopicId(message) ?? "none"} agent=${agent.id} messages=${turnMessages.length} attachments=${incomingAttachments.length}`);
    }
    // One inbound Telegram update → one outbound reply. Re-dispatched update_ids
    // (poll ACK races) must not sendPrompt/deliver again after the turn retires.
    if (this.state.isPromptTurnRetired?.(agent.id, clientNonce)) {
      await reactAll("✅");
      return;
    }
    const existingContext = this.state.getPromptContext?.(agent.id, clientNonce);
    if (existingContext) {
      if (existingContext.awaitingCompletion) {
        await this.waitForOwnedReply(agent.id, clientNonce, {
          ...options,
          onApproval: (entry) => this.sendApproval(chatId, agent.id, entry, {
            ...options,
            approvalUserId: message.from.id,
            replyToMessageId: message.message_id,
          }),
        }, this.mirrorEnabled() && chatId === this.mirrorChatId);
      }
      await this.deliverPromptContextThroughOwner(agent, clientNonce, options);
      await reactAll("✅");
      return;
    }
    await this.grok.sendPrompt(agent.id, text, clientNonce, {
      ...options,
      attachmentPaths,
      attachmentNames,
      richText,
    });
    await this.state.setPromptContext(agent.id, clientNonce, {
      contextKey: clientNonce,
      clientNonce,
      origin: "telegram",
      chatId,
      replyToMessageId: message.message_id,
      messageThreadId: options.messageThreadId,
      awaitingCompletion: true,
    });
    await this.waitForOwnedReply(agent.id, clientNonce, {
      ...options,
      onApproval: (entry) => this.sendApproval(chatId, agent.id, entry, {
        ...options,
        approvalUserId: message.from.id,
        replyToMessageId: message.message_id,
      }),
    }, this.mirrorEnabled() && chatId === this.mirrorChatId);
    await this.deliverPromptContextThroughOwner(agent, clientNonce, options);
    await reactAll("✅");
  }

  async pollDesktopMirrorOnce(options = {}) {
    const agents = await this.grok.listAgents(options);
    const recoveryAgentIds = new Set();
    for (const boundaryAgentId of this.state.listPromptTurnBoundaryAgentIds?.() ?? []) {
      recoveryAgentIds.add(boundaryAgentId);
    }
    for (const contextAgentId of this.state.listPromptContextAgentIds?.() ?? []) {
      recoveryAgentIds.add(contextAgentId);
    }
    for (const [, widget] of this.listRoutineWidgets()) {
      if (widget.submissionIntent === true && widget.replyDelivered !== true && widget.agentId) {
        recoveryAgentIds.add(widget.agentId);
      }
    }
    if (!this.mirrorEnabled()) {
      for (const recoveryAgentId of recoveryAgentIds) {
        const recoveryAgent = agents.find((candidate) => candidate.id === recoveryAgentId);
        if (!recoveryAgent) continue;
        for (const context of this.state.listPromptContexts?.(recoveryAgentId) ?? []) {
          const contextKey = context.contextKey ?? context.clientNonce;
          await this.withAgentMirrorOwner(recoveryAgentId, () => this.deliverPromptContext(
            recoveryAgent,
            contextKey,
            options,
            undefined,
            this.isMirrorConfigured(),
          ));
        }
      }
      return;
    }
    const recoveryErrors = new Map();
    for (const recoveryAgentId of recoveryAgentIds) {
      const recoveryAgent = agents.find((candidate) => candidate.id === recoveryAgentId);
      if (!recoveryAgent) continue;
      try {
        await this.pollDesktopMirrorAgentOnce(recoveryAgent, options);
      } catch (error) {
        if (options.signal?.aborted || error.name === "AbortError") throw error;
        recoveryErrors.set(recoveryAgentId, error);
        console.error(`Desktop mirror recovery failed for ${recoveryAgentId}:`, error.message);
      }
    }
    const agent = this.resolveAgent(this.mirrorChatId, agents);
    if (!agent) throw new Error("Desktop mirror agent is unavailable");
    if (recoveryAgentIds.has(agent.id)) {
      if (recoveryErrors.has(agent.id)) throw recoveryErrors.get(agent.id);
      return;
    }
    await this.pollDesktopMirrorAgentOnce(agent, options);
  }

  async pollDesktopMirrorAgentOnce(agent, options = {}) {
    return this.withAgentMirrorOwner(agent.id, () => this.pollDesktopMirrorAgentOwned(agent, options));
  }

  async pollDesktopMirrorAgentOwned(agent, options = {}) {
    const baselineOptions = { ...options, agent };
    await this.reconcileRoutineWidgetSubmissions(agent.id, options);
    const promptContexts = this.state.listPromptContexts?.(agent.id) ?? [];
    if (!promptContexts.length && await this.ensureMirrorBaseline(agent.id, baselineOptions)) return;

    let entries = await this.getTranscriptEntries(agent.id, options);
    const cursor = this.state.getMirrorCursor(agent.id);
    let cursorIndex = !cursor || cursor.entryId === null
      ? -1
      : entries.findIndex((entry) => entry?.id === cursor.entryId);
    if (cursor?.entryId && cursorIndex < 0) {
      entries = await this.grok.getTranscript(agent.id, options);
      cursorIndex = entries.findIndex((entry) => entry?.id === cursor.entryId);
      if (cursorIndex < 0) {
        if (!promptContexts.length) {
          await this.ensureMirrorBaseline(agent.id, { ...baselineOptions, force: true });
          return;
        }
        cursorIndex = -1;
      }
    }
    for (const boundary of this.state.listPromptTurnBoundaries?.(agent.id) ?? []) {
      const boundaryIndex = entries.findIndex((entry) => entry?.id === boundary.entryId);
      if (boundaryIndex >= 0 && cursor && boundaryIndex <= cursorIndex) {
        await this.retirePromptTurn(agent.id, boundary.clientNonce, boundary.entryId);
      }
    }
    if (promptContexts.some((context) => !entries.some((entry) => isTopLevelPromptEntry(entry)
      && (entry?.id === context.promptEntryId || entry?.clientNonce === context.clientNonce)))) {
      entries = await this.grok.getTranscript(agent.id, options);
      cursorIndex = cursor?.entryId === null || !cursor
        ? -1
        : entries.findIndex((entry) => entry?.id === cursor?.entryId);
    }
    for (const context of promptContexts) {
      const contextKey = context.contextKey ?? context.clientNonce;
      const contextPromptIndex = entries.findIndex((entry) => isTopLevelPromptEntry(entry)
        && (entry?.id === context.promptEntryId || entry?.clientNonce === context.clientNonce));
      if (contextPromptIndex >= 0 && (!cursor || contextPromptIndex <= cursorIndex)) {
        await this.deliverPromptContext(agent, contextKey, options, undefined, Boolean(cursor));
        return;
      }
    }
    if (!this.state.getMirrorCursor(agent.id)) {
      for (const context of promptContexts) {
        await this.deliverPromptContext(
          agent,
          context.contextKey ?? context.clientNonce,
          options,
          undefined,
          false,
        );
      }
      return;
    }
    const unseen = entries.slice(cursorIndex + 1);
    if (!unseen.length) return;
    const promptIndex = unseen.findIndex((entry) => isTopLevelPromptEntry(entry)
      && typeof entry?.id === "string" && entry.id);
    const autonomousIndex = unseen.findIndex((entry) => entry?.kind === "send-message");
    if (autonomousIndex >= 0 && (promptIndex < 0 || autonomousIndex < promptIndex)) {
      if (await this.mirrorAgentBusy(agent.id, baselineOptions)) return;
      const turnEnd = promptIndex < 0 ? unseen.length : promptIndex;
      await this.mirrorAutonomousOutput(
        agent,
        unseen.slice(autonomousIndex, turnEnd).filter((entry) => entry?.kind === "send-message"),
        options,
      );
      return;
    }
    if (promptIndex < 0) return;
    await this.mirrorDesktopTurn(agent, unseen[promptIndex], options);
  }

  async mirrorAutonomousOutput(agent, entries, options = {}) {
    if (!entries.length) return;
    for (const entry of entries) {
      if (typeof entry?.id !== "string" || !entry.id) {
        throw new Error("Grok returned no transcript cursor for autonomous output");
      }
      const widget = telegramSafeRoutineWidget(entry);
      if (widget && this.isMirrorConfigured()) {
        await this.sendAutonomousRoutineWidget(agent, entry, widget, options);
      } else {
        const reply = this.grok.getReplyContent([entry]);
        const text = reply.text
          ? `⏰ Routine · ${agent.name}\n\n${reply.text}`
          : !(reply.attachments ?? []).length
            ? "Grok produced autonomous output that Telegram cannot render. Open Grok Bot to view it."
            : undefined;
        const deliveryKey = `autonomous:${agent.id}:${entry.id}`;
        await this.deliverTelegramParts({
          deliveryKey,
          chatId: this.mirrorChatId,
          agentId: agent.id,
          text,
          attachments: reply.attachments,
          options,
        });
        // Keep completed deliveryKey progress for idempotent re-entry.
      }
      await this.state.setMirrorCursor(agent.id, entry.id);
    }
  }

  async mirrorDesktopTurn(agent, promptEntry, options = {}) {
    const clientNonce = typeof promptEntry?.clientNonce === "string" ? promptEntry.clientNonce : undefined;
    const contextKey = clientNonce ?? promptEntry.id;
    const waitOptions = { ...options, promptEntryId: promptEntry.id };
    const promptContext = this.state.getPromptContext?.(agent.id, contextKey);
    if (promptContext) {
      await this.deliverPromptContext(agent, contextKey, options, undefined, true);
      return;
    }
    if (clientNonce?.startsWith("telegram:")) {
      const skippedReply = await this.waitForOwnedReply(agent.id, clientNonce, waitOptions, true);
      if (typeof skippedReply?.messageId === "string" && skippedReply.messageId) {
        await this.state.setMirrorCursor(agent.id, skippedReply.messageId);
        await this.retirePromptTurn(agent.id, clientNonce, skippedReply.messageId);
      }
      return;
    }

    const prompt = this.grok.getPromptContent(promptEntry) ?? {
      text: "",
      attachments: [],
      unavailableAttachmentCount: 0,
    };
    const attachmentNotice = prompt.unavailableAttachmentCount > 0
      ? `\n\n[${prompt.unavailableAttachmentCount} desktop attachment${prompt.unavailableAttachmentCount === 1 ? " is" : "s are"} unavailable through the gateway transcript.]`
      : "";
    const promptText = prompt.text || "[Desktop prompt text is unavailable through the gateway transcript.]";
    const mirroredPrompt = await this.telegram.sendMessage(
      this.mirrorChatId,
      `🖥️ Desktop · ${agent.name}\n\n${promptText}${attachmentNotice}`,
      options,
    );
    if (!Number.isSafeInteger(mirroredPrompt?.message_id)) {
      throw new Error("Telegram returned no message ID for the mirrored desktop prompt");
    }
    await this.state.setPromptContext(agent.id, contextKey, {
      contextKey,
      clientNonce,
      promptEntryId: promptEntry.id,
      origin: "desktop",
      chatId: this.mirrorChatId,
      replyToMessageId: mirroredPrompt.message_id,
      awaitingCompletion: true,
    });
    const replyOptions = { ...options, replyToMessageId: mirroredPrompt.message_id };
    for (const attachment of prompt.attachments ?? []) {
      try {
        const bytes = await this.readAttachmentWithRetry(agent.id, attachment.path, options);
        await this.telegram.sendAttachment(
          this.mirrorChatId,
          { ...attachment, bytes, caption: attachment.caption || "Desktop prompt attachment" },
          replyOptions,
        );
      } catch {
        await this.telegram.sendMessage(
          this.mirrorChatId,
          `File wasn't ready to send (${attachmentDisplayName(attachment)}).`,
          { ...replyOptions, inlineKeyboard: undefined },
        );
      }
    }
    const reply = await this.waitForOwnedReply(agent.id, clientNonce, {
      ...waitOptions,
      onApproval: (entry) => this.sendApproval(this.mirrorChatId, agent.id, entry, {
        ...options,
        approvalUserId: this.mirrorUserId,
        replyToMessageId: mirroredPrompt.message_id,
      }),
    }, true, contextKey);
    await this.deliverPromptContext(agent, contextKey, options, reply, true);
  }

  async runDesktopMirror(options = {}) {
    if (!this.isMirrorConfigured()) return;
    let consecutiveFailures = 0;
    while (!options.signal?.aborted) {
      try {
        await this.pollDesktopMirrorOnce(options);
        consecutiveFailures = 0;
      } catch (error) {
        if (options.signal?.aborted || error.name === "AbortError") break;
        consecutiveFailures += 1;
        console.error("Desktop mirror polling failed:", error.message);
      }
      const normalDelay = this.grok.pollIntervalMs ?? 1_000;
      const delayMs = consecutiveFailures
        ? Math.min(normalDelay * (2 ** (consecutiveFailures - 1)), 30_000)
        : normalDelay;
      try {
        await sleep(delayMs, undefined, { signal: options.signal });
      } catch (error) {
        if (options.signal?.aborted || error.name === "AbortError") break;
        throw error;
      }
    }
  }

  async waitForOwnedReply(agentId, clientNonce, options = {}, persistBoundary = false, contextKey = clientNonce) {
    const completedReplyMessageId = typeof contextKey === "string"
      ? this.state.getPromptTurnBoundary?.(agentId, contextKey)
      : undefined;
    let reply;
    try {
      reply = await this.grok.waitForReply(agentId, clientNonce, {
        ...options,
        ...(completedReplyMessageId ? { completedReplyMessageId } : {}),
      });
    } catch (error) {
      const context = this.state.getPromptContext?.(agentId, contextKey);
      if (context?.awaitingCompletion) {
        await this.state.setPromptContext(agentId, contextKey, {
          ...context,
          awaitingCompletion: false,
        });
      }
      throw error;
    }
    if (typeof contextKey === "string" && contextKey
      && typeof reply?.messageId === "string" && reply.messageId) {
      if (persistBoundary) {
        await this.state.setPromptTurnBoundary?.(agentId, contextKey, reply.messageId);
      }
      const context = this.state.getPromptContext?.(agentId, contextKey);
      if (context) {
        await this.state.setPromptContext(agentId, contextKey, {
          ...context,
          awaitingCompletion: false,
          completionEntryId: reply.messageId,
          completionReply: {
            messageId: reply.messageId,
            text: reply.text,
            attachments: reply.attachments ?? [],
            entries: reply.entries,
          },
        });
      }
    }
    return reply;
  }

  async retirePromptTurn(agentId, contextKey, entryId) {
    if (typeof contextKey !== "string" || !contextKey) return;
    if (this.state.retirePromptTurn) {
      await this.state.retirePromptTurn(agentId, contextKey, entryId);
    } else {
      await this.state.deletePromptTurnBoundary?.(agentId, contextKey);
    }
    await this.state.deletePromptContext?.(agentId, contextKey);
    const widgetToken = ROUTINE_WIDGET_NONCE.exec(contextKey)?.[1];
    const widget = widgetToken ? this.state.getApproval(widgetToken) : undefined;
    if (widget?.type === "routine-widget" && widget.agentId === agentId) {
      widget.replyDelivered = true;
      widget.resolving = false;
      await this.state.setApproval(widgetToken, widget);
    }
  }

  async deliverRecoveredPromptEntries(
    agent,
    promptEntry,
    context,
    options = {},
    advanceCursor = true,
    resolvedEntries,
  ) {
    let entries = resolvedEntries ?? await this.getTranscriptEntries(agent.id, options);
    if (context.awaitingCompletion) return 0;
    let promptIndex = entries.findIndex((entry) => entry?.id === promptEntry.id);
    if (promptIndex < 0) {
      entries = await this.grok.getTranscript(agent.id, options);
      promptIndex = entries.findIndex((entry) => entry?.id === promptEntry.id);
    }
    if (promptIndex < 0) return 0;
    const nextPromptOffset = entries.slice(promptIndex + 1).findIndex(isTopLevelPromptEntry);
    const turnEnd = nextPromptOffset < 0 ? entries.length : promptIndex + 1 + nextPromptOffset;
    const replyEntries = entries.slice(promptIndex + 1, turnEnd)
      .filter((entry) => entry?.kind === "send-message");
    const contextKey = context.contextKey ?? promptEntry.clientNonce ?? promptEntry.id;
    const telegramOrigin = isTelegramOriginContext(context, context.clientNonce ?? promptEntry.clientNonce ?? contextKey);
    let delivered = 0;
    let sawCompletionMarker = !context.completionEntryId;
    for (const entry of replyEntries) {
      if (typeof entry?.id !== "string" || !entry.id) {
        throw new Error("Grok returned no transcript cursor for a recovered prompt update");
      }
      const alreadyDelivered = context.deliveredEntryIds?.includes(entry.id);
      const reply = this.grok.getReplyContent([entry]);
      const provenReply = entry.id === context.completionEntryId;
      // Telegram-originated turns own every send-message in the turn for the chat.
      const deliverAsOwned = provenReply || telegramOrigin;
      const neutral = !deliverAsOwned;
      const silent = isSilentTelegramReply(reply.text, reply.attachments);
      const cleanedReplyText = typeof reply.text === "string"
        ? stripTranscriptPreamble(reply.text)
        : reply.text;
      const text = silent
        ? undefined
        : cleanedReplyText
          ? neutral ? `Grok update · ${agent.name}\n\n${cleanedReplyText}` : cleanedReplyText
          : !(reply.attachments ?? []).length
            ? "Grok produced an update that Telegram cannot render safely. Open Grok Bot to view it."
            : undefined;
      const deliveryKey = `prompt:${agent.id}:${promptEntry.id}:${entry.id}`;
      const canDeliver = deliverAsOwned || this.isMirrorConfigured();
      if (!alreadyDelivered && canDeliver) {
        await this.deliverTelegramParts({
          deliveryKey,
          chatId: deliverAsOwned ? context.chatId ?? this.mirrorChatId : this.mirrorChatId,
          agentId: agent.id,
          text,
          attachments: silent ? [] : reply.attachments,
          options: deliverAsOwned
            ? {
              ...options,
              ...(context.replyToMessageId ? { replyToMessageId: context.replyToMessageId } : {}),
              ...(Number.isSafeInteger(context.messageThreadId)
                ? { messageThreadId: context.messageThreadId }
                : {}),
            }
            : options,
        });
        context.deliveredEntryIds = [...(context.deliveredEntryIds ?? []), entry.id];
        await this.state.setPromptContext?.(agent.id, contextKey, context);
        // Keep completed deliveryKey progress for idempotent re-entry.
        delivered += 1;
      }
      if (advanceCursor && canDeliver) await this.state.setMirrorCursor(agent.id, entry.id);
      if (entry.id === context.completionEntryId) {
        sawCompletionMarker = true;
        if (!telegramOrigin) {
          await this.retirePromptTurn(agent.id, contextKey, entry.id);
          break;
        }
        // Telegram: keep delivering later siblings; retire once after the loop.
      }
    }
    if (telegramOrigin && sawCompletionMarker && replyEntries.length) {
      await this.retirePromptTurn(
        agent.id,
        contextKey,
        replyEntries.at(-1)?.id ?? context.completionEntryId ?? promptEntry.id,
      );
    } else if (advanceCursor && !context.completionEntryId && nextPromptOffset >= 0) {
      if (!replyEntries.length) await this.state.setMirrorCursor(agent.id, promptEntry.id);
      await this.retirePromptTurn(agent.id, contextKey, replyEntries.at(-1)?.id ?? promptEntry.id);
    }
    return delivered;
  }

  async withAgentMirrorOwner(agentId, operation) {
    const previous = this.agentMirrorQueues.get(agentId) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.agentMirrorQueues.set(agentId, current);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.agentMirrorQueues.get(agentId) === current) this.agentMirrorQueues.delete(agentId);
    }
  }

  async deliverPromptContextThroughOwner(agent, contextKey, options = {}) {
    return this.withAgentMirrorOwner(agent.id, async () => {
      if (!this.mirrorEnabled()) {
        return this.deliverPromptContext(
          agent,
          contextKey,
          options,
          undefined,
          this.isMirrorConfigured(),
        );
      }
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (!this.state.getPromptContext?.(agent.id, contextKey)) return;
        const before = this.state.getMirrorCursor(agent.id)?.entryId;
        await this.pollDesktopMirrorAgentOwned(agent, options);
        if (!this.state.getPromptContext?.(agent.id, contextKey)) return;
        if (this.state.getMirrorCursor(agent.id)?.entryId === before) {
          return this.deliverPromptContext(agent, contextKey, options, undefined, true);
        }
      }
    });
  }

  async deliverPromptContext(agent, contextKey, options = {}, liveReply, advanceCursor = true) {
    const context = this.state.getPromptContext?.(agent.id, contextKey);
    if (!context) return;
    const clientNonce = context.clientNonce ?? context.contextKey ?? contextKey;
    let entries = [];
    try {
      entries = await this.getTranscriptEntries(agent.id, options);
    } catch {
      entries = [];
    }
    let promptEntry = entries.find((entry) => isTopLevelPromptEntry(entry)
      && (entry?.id === context.promptEntryId || entry?.clientNonce === clientNonce));
    if (!promptEntry && typeof this.grok.getTranscript === "function") {
      try {
        entries = await this.grok.getTranscript(agent.id, options);
        promptEntry = entries.find((entry) => isTopLevelPromptEntry(entry)
          && (entry?.id === context.promptEntryId || entry?.clientNonce === clientNonce));
      } catch {
        entries = [];
      }
    }
    const replyResult = liveReply ?? context.completionReply;
    if (!promptEntry && replyResult?.messageId) {
      promptEntry = {
        id: context.promptEntryId ?? `prompt:${contextKey}`,
        kind: "message",
        clientNonce,
      };
      entries.push(promptEntry);
    }
    if (!promptEntry) return;
    if (!replyResult?.messageId
      && ROUTINE_WIDGET_NONCE.test(clientNonce ?? "")
      && !context.awaitingCompletion) {
      await this.waitForOwnedReply(agent.id, clientNonce, {
        ...options,
        promptEntryId: context.promptEntryId ?? promptEntry.id,
        onApproval: (entry) => this.sendApproval(context.chatId ?? this.mirrorChatId, agent.id, entry, {
          ...options,
          approvalUserId: this.mirrorUserId,
          replyToMessageId: context.replyToMessageId,
        }),
      }, advanceCursor && this.mirrorEnabled(), contextKey);
    }
    const completed = this.state.getPromptContext?.(agent.id, contextKey) ?? context;
    const completedReply = liveReply ?? completed.completionReply;
    if (completedReply?.messageId && !entries.some((entry) => entry?.id === completedReply.messageId)) {
      entries.push(...this.replyEntriesFromResult(completedReply));
    }
    await this.deliverRecoveredPromptEntries(
      agent,
      promptEntry,
      { ...completed, contextKey, clientNonce },
      options,
      advanceCursor,
      entries,
    );
  }

  replyEntriesFromResult(reply) {
    if (reply?.entries?.length) return reply.entries;
    if (!reply?.messageId) return [];
    return [{
      id: reply.messageId,
      kind: "send-message",
      message: {
        type: "text",
        content: reply.text ?? "",
        images: (reply.attachments ?? []).map((attachment) => ({
          url: attachment.path,
          alt: attachment.caption,
        })),
      },
    }];
  }

  async findTranscriptEntryByNonce(agentId, clientNonce, options = {}) {
    let entries = await this.getTranscriptEntries(agentId, options);
    let entry = entries.find((candidate) => candidate?.clientNonce === clientNonce);
    if (entry) return entry;
    entries = await this.grok.getTranscript(agentId, options);
    return entries.find((candidate) => candidate?.clientNonce === clientNonce);
  }

  async readAttachmentWithRetry(agentId, attachmentPath, options = {}) {
    const attempts = Number.isSafeInteger(this.attachmentReadAttempts) && this.attachmentReadAttempts > 0
      ? this.attachmentReadAttempts
      : ATTACHMENT_READ_ATTEMPTS;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.grok.readAttachment(agentId, attachmentPath, options);
      } catch (error) {
        lastError = error;
        if (!isRetryableAttachmentReadError(error) || attempt >= attempts) break;
        const backoffMs = typeof this.attachmentReadBackoffMs === "function"
          ? this.attachmentReadBackoffMs(attempt - 1)
          : defaultAttachmentReadBackoffMs(attempt - 1);
        await sleep(Math.max(0, backoffMs), undefined, { signal: options.signal });
      }
    }
    throw lastError;
  }

  async deliverTelegramParts({ deliveryKey, chatId, agentId, text, attachments = [], options = {} }) {
    let deliveryText = text;
    let deliveryAttachments = attachments ?? [];
    if (isSilentTelegramReply(deliveryText, deliveryAttachments)) {
      deliveryText = undefined;
      deliveryAttachments = [];
    }
    const parts = [
      ...(deliveryText ? [{ type: "text", text: deliveryText }] : []),
      ...deliveryAttachments.map((attachment) => ({ type: "attachment", attachment })),
    ];
    if (!parts.length) {
      if (this.state.completeDeliveryProgress) {
        await this.state.completeDeliveryProgress(deliveryKey, { nextPart: 0 });
      }
      return;
    }

    // Idempotent deliveryKey: a completed claim must never sendMessage again.
    // Claim synchronously before any await so a concurrent deliver cannot both send.
    let progress;
    if (typeof this.state.claimDeliveryProgress === "function") {
      const claim = this.state.claimDeliveryProgress(deliveryKey);
      if (claim.completed) return;
      progress = claim.progress;
      if (claim.isNewClaim) {
        await this.state.setDeliveryProgress?.(deliveryKey, progress);
      }
    } else {
      progress = this.state.getDeliveryProgress?.(deliveryKey);
      if (progress?.completed) return;
      if (!progress) {
        progress = { nextPart: 0, claimed: true, completed: false };
        await this.state.setDeliveryProgress?.(deliveryKey, progress);
      }
    }
    if (progress.nextPart >= parts.length) {
      progress.completed = true;
      if (this.state.completeDeliveryProgress) {
        await this.state.completeDeliveryProgress(deliveryKey, progress);
      } else {
        await this.state.setDeliveryProgress?.(deliveryKey, progress);
      }
      return;
    }

    for (let index = progress.nextPart; index < parts.length; index += 1) {
      const part = parts[index];
      if (part.type === "text") {
        const textChunks = this.telegram.splitMessage?.(part.text) ?? [part.text];
        for (let chunkIndex = progress.nextTextChunk ?? 0; chunkIndex < textChunks.length; chunkIndex += 1) {
          const sent = await this.telegram.sendMessage(chatId, textChunks[chunkIndex], {
            ...options,
            ...(chunkIndex === textChunks.length - 1 ? {} : { inlineKeyboard: undefined }),
          });
          if (!options.replyToMessageId && !Number.isSafeInteger(progress.rootMessageId)
            && Number.isSafeInteger(sent?.message_id)) {
            progress.rootMessageId = sent.message_id;
          }
          progress.nextTextChunk = chunkIndex + 1;
          await this.state.setDeliveryProgress?.(deliveryKey, progress);
        }
        delete progress.nextTextChunk;
      } else {
        const attachmentOptions = Number.isSafeInteger(progress.rootMessageId)
          ? { ...options, replyToMessageId: progress.rootMessageId }
          : options;
        try {
          const bytes = await this.readAttachmentWithRetry(agentId, part.attachment.path, options);
          await this.telegram.sendAttachment(chatId, { ...part.attachment, bytes }, attachmentOptions);
        } catch {
          // Retries exhausted: notify once, record failure, advance so we do not infinite-loop.
          const notice = `File wasn't ready to send (${attachmentDisplayName(part.attachment)}).`;
          await this.telegram.sendMessage(chatId, notice, {
            ...attachmentOptions,
            inlineKeyboard: undefined,
          });
          progress.attachmentUnavailable = true;
          progress.failedAttachmentParts = [...(progress.failedAttachmentParts ?? []), index];
        }
      }
      progress.nextPart = index + 1;
      await this.state.setDeliveryProgress?.(deliveryKey, progress);
    }

    // Retire the deliveryKey as completed *before* any second caller can re-send.
    // Completed covers full success OR after an explicit unavailable notice was recorded.
    // Do not delete progress — deletion was the double-delivery hole.
    progress.completed = true;
    if (this.state.completeDeliveryProgress) {
      await this.state.completeDeliveryProgress(deliveryKey, progress);
    } else {
      await this.state.setDeliveryProgress?.(deliveryKey, progress);
    }
  }

  listRoutineWidgets() {
    const entries = typeof this.state.listApprovals === "function"
      ? this.state.listApprovals()
      : Object.entries(this.state.pendingApprovals ?? {});
    return entries.filter(([, approval]) => approval?.type === "routine-widget");
  }

  findRoutineWidget(agentId, entryId) {
    return this.listRoutineWidgets().find(([, widget]) => (
      widget.agentId === agentId && widget.entryId === entryId
    ));
  }

  async withWidgetCallbackLock(token, operation) {
    const previous = this.widgetCallbackQueues.get(token) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.widgetCallbackQueues.set(token, current);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (this.widgetCallbackQueues.get(token) === current) this.widgetCallbackQueues.delete(token);
    }
  }

  routineWidgetBindingError(widget, callback, token, choiceIndex) {
    const choice = widget?.choices?.[choiceIndex];
    if (!widget || widget.type !== "routine-widget" || !widget.agentId || !widget.entryId
      || !choice || typeof choice.value !== "string" || !choice.value
      || widget.chatId !== this.mirrorChatId
      || widget.userId !== this.mirrorUserId
      || widget.chatId !== callback.message?.chat?.id
      || widget.userId !== callback.from?.id
      || widget.messageId !== callback.message?.message_id) {
      return "This option is not valid for this chat.";
    }
    if (widget.replyDelivered === true) {
      return "That widget choice was already used.";
    }
    if (widget.submissionIntent === true) {
      const expectedNonce = routineWidgetNonce(token, choiceIndex);
      if (widget.choiceIndex !== choiceIndex
        || widget.clientNonce !== expectedNonce
        || widget.selectedValue !== choice.value) {
        return "That widget choice was already used.";
      }
    } else if (widget.expiresAt <= Date.now()) {
      return "expired";
    }
    return undefined;
  }

  async sendAutonomousRoutineWidget(agent, entry, details, options = {}) {
    const cardText = `⏰ Routine · ${agent.name}\n\n${details.text}`;
    if (cardText.length > APPROVAL_TEXT_LIMIT) {
      await this.telegram.sendMessage(
        this.mirrorChatId,
        "Grok Bot needs an approval, secret, or rich interaction. Open Grok Bot on desktop to handle it safely.",
        options,
      );
      return;
    }
    const existing = this.findRoutineWidget(agent.id, entry.id);
    if (existing?.[1]?.messageId) return;
    const token = existing?.[0] ?? randomBytes(18).toString("base64url");
    const widget = existing?.[1] ?? {
      type: "routine-widget",
      agentId: agent.id,
      entryId: entry.id,
      choices: details.choices,
      chatId: this.mirrorChatId,
      userId: this.mirrorUserId,
      expiresAt: Date.now() + ROUTINE_WIDGET_TTL_MS,
    };
    if (!existing) await this.state.setApproval(token, widget);
    try {
      const sent = await this.telegram.sendMessage(this.mirrorChatId, cardText, {
        ...options,
        inlineKeyboard: details.choices.map((choice, index) => [{
          text: choice.label,
          callback_data: `gtw:${token}:${index.toString(36)}`,
        }]),
      });
      widget.messageId = sent?.message_id;
      await this.state.setApproval(token, widget);
    } catch (error) {
      if (!existing) await this.state.deleteApproval(token);
      throw error;
    }
  }

  async reconcileRoutineWidgetSubmissions(agentId, options = {}) {
    const pending = this.listRoutineWidgets().filter(([, widget]) => (
      widget.agentId === agentId
      && widget.submissionIntent === true
      && widget.replyDelivered !== true
      && typeof widget.clientNonce === "string"
      && widget.clientNonce
    ));
    if (!pending.length) return;
    let entries = await this.getTranscriptEntries(agentId, options);
    if (pending.some(([, widget]) => !entries.some((entry) => (
      isTopLevelPromptEntry(entry) && entry?.clientNonce === widget.clientNonce
    )))) {
      entries = await this.grok.getTranscript(agentId, options);
    }
    for (const [token, widget] of pending) {
      const promptEntry = entries.find((entry) => (
        isTopLevelPromptEntry(entry) && entry?.clientNonce === widget.clientNonce
      ));
      if (!promptEntry) continue;
      widget.submitted = true;
      widget.accepted = true;
      widget.resolving = false;
      await this.state.setApproval(token, widget);
      if (!this.state.getPromptContext?.(agentId, widget.clientNonce)) {
        await this.state.setPromptContext(agentId, widget.clientNonce, {
          contextKey: widget.clientNonce,
          clientNonce: widget.clientNonce,
          promptEntryId: promptEntry.id,
          origin: "telegram",
          chatId: widget.chatId,
          replyToMessageId: widget.messageId,
          awaitingCompletion: false,
        });
      }
    }
  }

  async deliverAcceptedWidgetChoice(token, widget, options = {}) {
    const agents = await this.grok.listAgents(options);
    const agent = agents.find((candidate) => candidate.id === widget.agentId)
      ?? { id: widget.agentId, name: "Grok" };
    const persistBoundary = this.mirrorEnabled();
    if (!this.state.getPromptContext?.(agent.id, widget.clientNonce)) {
      await this.state.setPromptContext(agent.id, widget.clientNonce, {
        contextKey: widget.clientNonce,
        clientNonce: widget.clientNonce,
        origin: "telegram",
        chatId: widget.chatId,
        replyToMessageId: widget.messageId,
        awaitingCompletion: true,
      });
    }
    await this.waitForOwnedReply(agent.id, widget.clientNonce, {
      ...options,
      onApproval: (entry) => this.sendApproval(widget.chatId, agent.id, entry, {
        ...options,
        approvalUserId: widget.userId,
        replyToMessageId: widget.messageId,
      }),
    }, persistBoundary);
    await this.deliverPromptContextThroughOwner(agent, widget.clientNonce, options);
    widget.replyDelivered = true;
    widget.resolving = false;
    await this.state.setApproval(token, widget);
  }

  async handleRoutineWidgetCallback(callback, token, choiceIndex, options = {}) {
    return this.withWidgetCallbackLock(token, async () => {
      const widget = this.state.getApproval(token);
      const bindingError = this.routineWidgetBindingError(widget, callback, token, choiceIndex);
      if (bindingError === "expired") {
        await this.state.deleteApproval(token);
        await this.telegram.editMessageReplyMarkup(widget.chatId, widget.messageId, [], options).catch(() => {});
        await this.telegram.answerCallbackQuery(
          callback.id,
          "This option expired. Open Grok Bot if you still need to choose.",
          options,
        );
        return;
      }
      if (bindingError) {
        await this.telegram.answerCallbackQuery(callback.id, bindingError, options);
        return;
      }
      if (widget.resolving) {
        await this.telegram.answerCallbackQuery(callback.id, "That choice is already being processed.", options);
        return;
      }

      const choice = widget.choices[choiceIndex];
      const clientNonce = routineWidgetNonce(token, choiceIndex);
      if (widget.submissionIntent === true) {
        const submittedEntry = await this.findTranscriptEntryByNonce(widget.agentId, clientNonce, options);
        if (!submittedEntry) {
          await this.telegram.answerCallbackQuery(
            callback.id,
            "Choice submission is still being reconciled. It will not be sent twice.",
            options,
          );
          return;
        }
        widget.submitted = true;
        widget.accepted = true;
        widget.resolving = true;
        await this.state.setApproval(token, widget);
        try {
          await this.telegram.editMessageReplyMarkup(widget.chatId, widget.messageId, [], options).catch(() => {});
          await this.telegram.answerCallbackQuery(callback.id, "Sent to Grok.", options).catch(() => {});
          await this.deliverAcceptedWidgetChoice(token, widget, options);
        } catch (error) {
          widget.resolving = false;
          await this.state.setApproval(token, widget);
          throw error;
        }
        return;
      }

      widget.resolving = true;
      widget.submissionIntent = true;
      widget.clientNonce = clientNonce;
      widget.choiceIndex = choiceIndex;
      widget.selectedValue = choice.value;
      await this.state.setApproval(token, widget);
      try {
        await this.grok.sendPrompt(widget.agentId, choice.value, clientNonce, options);
        widget.submitted = true;
        widget.accepted = true;
        await this.state.setApproval(token, widget);
        await this.telegram.editMessageReplyMarkup(widget.chatId, widget.messageId, [], options).catch(() => {});
        await this.telegram.answerCallbackQuery(callback.id, "Sent to Grok.", options).catch(() => {});
        await this.deliverAcceptedWidgetChoice(token, widget, options);
      } catch (error) {
        widget.resolving = false;
        await this.state.setApproval(token, widget);
        throw error;
      }
    });
  }

  async sendApproval(chatId, agentId, entry, options = {}) {
    const details = approvalDetails(entry);
    if (!details?.requestId || !entry?.id) return;
    const text = formatApproval(details);
    if (text.length > APPROVAL_TEXT_LIMIT) {
      await this.telegram.sendMessage(
        chatId,
        "This approval contains more detail than Telegram can display safely. Open Grok Bot to review the complete request. No mobile approval was offered.",
        options,
      );
      return;
    }

    const token = randomBytes(18).toString("base64url");
    const approval = {
      type: details.type,
      agentId,
      entryId: entry.id,
      requestId: details.requestId,
      chatId,
      userId: options.approvalUserId,
      expiresAt: Date.now() + APPROVAL_TTL_MS,
    };
    await this.state.setApproval(token, approval);
    try {
      const sent = await this.telegram.sendMessage(chatId, text, {
        ...options,
        inlineKeyboard: [[
          { text: "Approve once", callback_data: `gta:${token}:a` },
          { text: "Deny", callback_data: `gta:${token}:d` },
        ]],
      });
      approval.messageId = sent?.message_id;
      await this.state.setApproval(token, approval);
    } catch (error) {
      await this.state.deleteApproval(token);
      throw error;
    }
  }

  async handleCallbackQuery(update, options = {}) {
    const callback = update?.callback_query;
    if (callback?.message) {
      options = { ...options, ...this.deliveryOptionsFromMessage(callback.message) };
    }
    if (!this.isAuthorizedCallback(callback)) return;
    const widgetMatch = ROUTINE_WIDGET_CALLBACK.exec(callback.data ?? "");
    if (widgetMatch) {
      await this.handleRoutineWidgetCallback(
        callback,
        widgetMatch[1],
        Number.parseInt(widgetMatch[2], 36),
        options,
      );
      return;
    }
    const match = /^gta:([A-Za-z0-9_-]{24}):([ad])$/.exec(callback.data ?? "");
    if (!match) {
      await this.telegram.answerCallbackQuery(callback.id, "Unknown or invalid approval.", options);
      return;
    }
    const [, token, decision] = match;
    const approval = this.state.getApproval(token);
    const expectedMessageId = callback.message?.message_id;
    if (!approval
      || approval.chatId !== callback.message.chat.id
      || approval.userId !== callback.from.id
      || approval.messageId !== expectedMessageId) {
      await this.telegram.answerCallbackQuery(callback.id, "This approval is not valid for this chat.", options);
      return;
    }
    if (approval.expiresAt <= Date.now()) {
      await this.state.deleteApproval(token);
      await this.telegram.editMessageReplyMarkup(approval.chatId, approval.messageId, [], options).catch(() => {});
      await this.telegram.answerCallbackQuery(callback.id, "This approval expired. Retry the request.", options);
      return;
    }
    if (approval.resolving) {
      await this.telegram.answerCallbackQuery(callback.id, "That decision is already being processed.", options);
      return;
    }

    approval.resolving = true;
    await this.state.setApproval(token, approval);
    try {
      const pending = await this.grok.getPendingApproval(
        approval.agentId,
        approval.entryId,
        approval.requestId,
        options,
      );
      if (!pending || (approval.type === "auto-review" && pending.message.type !== "auto-review-approval")
        || (approval.type === "local-tool" && pending.message.type !== "local-tool-permission")) {
        await this.state.deleteApproval(token);
        await this.telegram.editMessageReplyMarkup(approval.chatId, approval.messageId, [], options).catch(() => {});
        await this.telegram.answerCallbackQuery(callback.id, "This request is no longer pending.", options);
        return;
      }
      const approved = decision === "a";
      if (approval.type === "auto-review") {
        await this.grok.resolveAutoReviewApproval(
          approval.agentId,
          approval.entryId,
          approval.requestId,
          approved,
          options,
        );
      } else {
        await this.grok.resolveLocalToolPermission(
          approval.agentId,
          approval.entryId,
          approval.requestId,
          approved,
          options,
        );
      }
      await this.state.deleteApproval(token);
      await this.telegram.editMessageReplyMarkup(approval.chatId, approval.messageId, [], options).catch(() => {});
      await this.telegram.answerCallbackQuery(callback.id, approved ? "Approved once." : "Denied.", options);
      await this.telegram.sendMessage(
        approval.chatId,
        approved ? "✅ Approved once. Grok is continuing." : "❌ Denied. Grok was not authorized to perform that action.",
        { ...options, replyToMessageId: approval.messageId },
      );
    } catch (error) {
      approval.resolving = false;
      await this.state.setApproval(token, approval);
      throw error;
    }
  }

  async handleCallbackError(update, options = {}) {
    const callback = update?.callback_query;
    if (!this.isAuthorizedCallback(callback)) return;
    const widgetMatch = ROUTINE_WIDGET_CALLBACK.exec(callback.data ?? "");
    const widget = widgetMatch ? this.state.getApproval(widgetMatch[1]) : undefined;
    const choiceWasSent = widget?.type === "routine-widget" && widget.submissionIntent === true;
    await this.telegram.answerCallbackQuery(
      callback.id,
      choiceWasSent
        ? "Choice sent. Reply delivery will retry automatically."
        : widgetMatch
          ? "Could not finish that choice. Check the chat before trying again."
          : "Could not apply that decision. The request remains unapproved.",
      options,
    ).catch(() => {});
  }


  async handleError(update, options = {}) {
    const message = update?.message;
    if (!this.isAuthorized(message)) return;
    options = { ...options, ...this.deliveryOptionsFromMessage(message) };
    const failedMessages = Array.isArray(update?.bundledUpdates) && update.bundledUpdates.length > 1
      ? update.bundledUpdates.map((item) => item?.message).filter(Boolean)
      : [message];
    for (const item of failedMessages) {
      await this.telegram.setMessageReaction?.(message.chat.id, item.message_id, "❌", options)?.catch?.(() => {});
    }
    await this.telegram.sendMessage(
      message.chat.id,
      "I couldn't finish that request. Please try again, or open Grok Bot if the request needs a desktop approval.",
      { ...options, replyToMessageId: message.message_id },
    ).catch((error) => {
      console.error("handleError sendMessage failed:", error.message);
    });
  }
}

export {
  HELP,
  GROUP_HYBRID_HINT,
  GROUP_TOPIC_AGENT_HINT,
  stripTelegramContextHeaders
};
