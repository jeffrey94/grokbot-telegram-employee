# grokbot-telegram-employee

Put a [Grok Bot](https://grok.com) agent behind a Telegram bot so your whole team can use it from Telegram. The bridge runs on the Grok Bot remote computer, polls Telegram over outbound HTTPS, and talks to the local Sand gateway on loopback only. Only the chats you allowlist can reach the agent. Nobody on Telegram can change the agent's setup: the bot has no command to edit `.env`, agent instructions, skills, or permissions, and approvals from Telegram are one-time only.

This is a fork of [SSBrouhard/grokbot-telegram-bridge](https://github.com/SSBrouhard/grokbot-telegram-bridge), released under the MIT license. Thanks to the original author for a careful, security-first bridge. The upstream copyright notice is kept unchanged in [LICENSE](LICENSE).

Unofficial project. Not affiliated with, endorsed by, or supported by xAI, Grok, or Telegram.

## What's different from upstream

- Groups and forum topics. The bot can live in an allowlisted group or forum supergroup and replies inside the topic the message came from.
- One assistant per topic. `TELEGRAM_TOPIC_AGENTS` routes each forum topic to its own Grok agent, matched by topic id first and then by topic name.
- Photo bundling. An album, or a quick burst of photos plus the text sent right after, becomes one agent turn instead of one turn per photo.
- Configurable group filtering. `TELEGRAM_GROUP_KEYWORDS` and `TELEGRAM_GROUP_HINT` decide which group messages wake the default agent and what it is told about them.
- Sender headers. Every prompt starts with who sent it, which chat it came from, and which topic, so the agent knows who is asking.
- Voice hint. `TELEGRAM_VOICE_PROMPT_HINT` adds your own instruction to voice-note and audio prompts.

## Quick start

You need a Grok Bot remote computer where the desktop agent and the local gateway already work. The bridge does not run Grok for you.

1. Create the bot. Open [@BotFather](https://t.me/BotFather) in Telegram, send `/newbot`, and follow the prompts. Copy the token it gives you. Never paste this token into any chat.

2. Clone this fork onto the Grok computer's persistent volume. The control script expects `/home/box/grokbot-telegram-bridge`; if you install elsewhere, export `BRIDGE_HOME=<your path>` before every control-script command.

   ```sh
   git clone https://github.com/jeffrey94/grokbot-telegram-employee.git /home/box/grokbot-telegram-bridge
   cd /home/box/grokbot-telegram-bridge
   cp .env.example .env
   chmod 600 .env
   chmod 600 /home/box/sand-data/gateway.json
   ```

   There is no `npm install`. The bridge needs Node.js 20.6 or newer and has no registry dependencies.

3. Fill in `.env`. Set `TELEGRAM_BOT_TOKEN` to the BotFather token. Leave `GROK_GATEWAY_URL` on loopback. Keep `GROK_GATEWAY_TOKEN_FILE` pointing at `gateway.json`, which must be mode `600` (Grok Bot writes it as `644`; the bridge refuses to read it until you tighten it, and it may be recreated after a Grok computer update). Leave `TELEGRAM_ALLOWED_USER_IDS` and `TELEGRAM_ALLOWED_CHAT_IDS` for the next step.

4. Find your ids. Send `/start` to your bot from your own Telegram account, then run:

   ```sh
   npm run discover-ids
   ```

   It prints lines like `user=123456789 chat=123456789 type=private` and never prints message text. Put the `user=` number in `TELEGRAM_ALLOWED_USER_IDS` and the `chat=` number in `TELEGRAM_ALLOWED_CHAT_IDS`. In a one-to-one chat with the bot they are usually the same number, but both variables are required. Run this helper only while the bridge is stopped; it consumes pending updates.

5. Start the bridge.

   ```sh
   ./deploy/bridge-control.sh start
   ./deploy/bridge-control.sh status
   ```

   `start` refuses to run if `.env` is missing or not mode `600`. Logs go to `bridge.log` in the project directory.

6. Test it. From your allowed account, send `/help` to the bot. You should get the command list. Then send a plain message such as `ping`. The bot reacts with eyes while it works and a check mark when the reply is delivered.

To keep the bridge alive across Grok computer sleeps, see [Operations](#operations).

## Configuration reference

All values are read from `.env` at startup. Restart the bridge after changing them. `deploy/bridge-control.sh start` clears any inherited copies of these variables from the environment first, so `.env` always wins.

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | none | Bot token from BotFather. Sent only to `api.telegram.org`. |
| `TELEGRAM_ALLOWED_USER_IDS` | yes | none | Comma-separated numeric Telegram user ids allowed to use the bot in private chats. |
| `TELEGRAM_ALLOWED_CHAT_IDS` | yes | none | Comma-separated numeric chat ids. A private chat needs its id here and the sender's id in the user list. A group or supergroup id (negative, for example `-1001234567890`) admits every member of that group. |
| `GROK_GATEWAY_URL` | yes | none | Local Sand gateway URL, for example `http://127.0.0.1:1340`. The host must be `127.0.0.1`, `localhost`, or `::1`; anything else fails startup. |
| `GROK_GATEWAY_TOKEN_FILE` | one of the two | none | Path to Grok Bot's `gateway.json`. Must be a regular file with no group or other permissions. The bridge reads the `gatewayToken` (or `token`) field in memory. |
| `GROK_GATEWAY_TOKEN` | one of the two | none | The gateway token itself. Used instead of the file when set. |
| `GROK_DEFAULT_AGENT` | no | `Chief of Staff` | Agent name or agent id that receives prompts when no other agent is selected or routed. |
| `BRIDGE_STATE_PATH` | no | `bridge-state.json` in the working directory | State file. Created with mode `600`. An existing file must already be mode `600` and a regular file. |
| `GROK_REPLY_TIMEOUT_MS` | no | `600000` | How long to wait for an agent reply before giving up (10 minutes). |
| `GROK_POLL_INTERVAL_MS` | no | `1000` | How often the bridge checks the gateway for reply progress. |
| `GROK_DESKTOP_MIRROR_CHAT_ID` | no | unset | Chat that receives mirrored desktop activity. Must be set together with the user id below and must already be in `TELEGRAM_ALLOWED_CHAT_IDS`. |
| `GROK_DESKTOP_MIRROR_USER_ID` | no | unset | User who may control mirroring. Must be set together with the chat id above and must already be in `TELEGRAM_ALLOWED_USER_IDS`. |
| `TELEGRAM_ALLOWED_TOPIC_IDS` | no | all topics | Comma-separated forum topic ids the bot listens to. `1` is the General topic. Topics mapped in `TELEGRAM_TOPIC_AGENTS` are always admitted. Private chats and non-forum groups are never topic-filtered. |
| `TELEGRAM_TOPIC_NAMES` | no | none | JSON object of topic id to display name, for example `{"111":"Sales"}`. Used in the `[telegram-topic]` header and for name-based routing. Names learned from Telegram are merged on top. |
| `TELEGRAM_TOPIC_AGENTS` | no | none | Comma-separated `<topicIdOrName>=<agentIdOrName>` pairs. Numeric keys are topic ids and win over name keys; name keys match case-insensitively. See [Groups and topics](#groups-and-topics). |
| `TELEGRAM_GROUP_KEYWORDS` | no | none | Comma-separated, case-insensitive keywords. A group message containing one is forwarded to the default agent like a mention. Single Latin words match on word boundaries; phrases and non-Latin text match as substrings. |
| `TELEGRAM_GROUP_HINT` | no | built-in hint | Replaces the instruction prepended to other group messages in unmapped topics. The `[telegram-group-hybrid]` tag is added automatically. Tell the agent to answer exactly `NO_TELEGRAM_REPLY` when it should stay silent. |
| `TELEGRAM_VOICE_PROMPT_HINT` | no | none | Extra text appended to the built-in voice-note and audio prompt, for example which local transcription tool the agent may use. |
| `TELEGRAM_MEDIA_BUNDLING` | no | `on` | Set to `off` (or `false`, `no`, `0`) to send every photo as its own turn. |
| `TELEGRAM_BUNDLE_ALBUM_DEBOUNCE_MS` | no | `1800` | An album closes this long after its last item arrives. |
| `TELEGRAM_BUNDLE_BURST_WINDOW_MS` | no | `3000` | Loose photos from the same sender in the same topic close this long after the last one. A text message from that sender inside the window becomes the bundle's caption. |
| `TELEGRAM_BUNDLE_MAX_WAIT_MS` | no | `8000` | Hard cap measured from the first item. |
| `TELEGRAM_BUNDLE_MAX_ITEMS` | no | `10` | A bundle closes as soon as it holds this many items. Telegram albums hold at most 10. |

The control script also reads `BRIDGE_HOME` (default `/home/box/grokbot-telegram-bridge`) to find `.env`, `bridge.pid`, and `bridge.log`.

## Groups and topics

### Add the bot to a group

1. Add the bot to your group or forum supergroup. For the bot to see ordinary messages, not only commands and mentions, either make it a group admin or turn off privacy mode in BotFather with `/setprivacy`.
2. Stop the bridge, send any message in the group, and run `npm run discover-ids`. It prints the group's negative `chat=` id, for example `-1001234567890`.
3. Add that id to `TELEGRAM_ALLOWED_CHAT_IDS`. Once a group is allowlisted, every member of it can talk to the bot, so only add groups you control.
4. Restart the bridge. The startup log shows how many chats, topics, keywords, and topic routes were loaded.

### How group messages are handled

In an allowlisted group, the bot always answers slash commands, messages that mention it, and replies to its own messages. If `TELEGRAM_GROUP_KEYWORDS` is set, messages containing a keyword are treated the same way.

Other real messages (text of two or more characters, photos, files, voice notes, videos) are soft-forwarded to the default agent with a short hint that says to reply only when appropriate and otherwise answer exactly `NO_TELEGRAM_REPLY`. The bridge turns that reply into silence. Plain chatter such as `ok`, `thanks`, single emoji, stickers, and join or leave notices is dropped before it reaches Grok.

Agents that serve groups should be told, in their own instructions inside Grok Bot, that a reply of exactly `NO_TELEGRAM_REPLY`, `[NO_TELEGRAM_REPLY]`, or `⟦noreply⟧` means "say nothing in Telegram".

### Give each topic its own agent

In a forum supergroup, map topics to agents with `TELEGRAM_TOPIC_AGENTS`:

```sh
TELEGRAM_TOPIC_AGENTS="111=Sales Assistant,222=00000000-0000-0000-0000-000000000000"
```

- Map by numeric topic id. Ids survive renames; names do not. A topic's id is the number shown in the `[telegram-topic] id=...` header the agent receives, or in the log line `topic learned chat=-1001234567890 id=111 name=...`.
- Name keys also work (`Sales=Sales Assistant`) and are matched case-insensitively. Names come from `TELEGRAM_TOPIC_NAMES` or are learned from Telegram's topic-created and topic-renamed notices and saved in the state file.
- A routed topic skips the keyword filter: every real text, photo, file, video, and voice note goes to its agent. Only noise is dropped. Messages that do not address the bot directly carry a `[telegram-group]` hint telling the agent to reply only when it is part of its job.
- Each routed topic has its own queue, so a slow agent in one topic does not block another.
- `/use` is disabled inside a routed topic.
- If the mapped agent cannot be found in Grok Bot, the bridge logs the miss and stays quiet. It never falls back to the default agent for a routed topic.

### Set up the mapping before people post

Messages in topics that are not mapped are not routed anywhere special:

- If `TELEGRAM_ALLOWED_TOPIC_IDS` is unset, an unmapped topic is handled by the default agent (or the agent selected with `/use` for that group) through the group filter described above.
- If `TELEGRAM_ALLOWED_TOPIC_IDS` is set, unmapped topics that are not in that list are dropped with a log line and no reply.

So add the mapping first, restart, and only then invite people to post. Otherwise early messages either land on the default agent or vanish.

Keep it simple: one job per topic and one agent per topic. In a group, `/use` changes the agent for every unmapped topic in that whole group, not just the topic where you typed it. If you want different assistants for different topics, use `TELEGRAM_TOPIC_AGENTS` rather than `/use`.

### Photo bundling

With `TELEGRAM_MEDIA_BUNDLING` on (the default), photos are grouped into one agent turn:

- An album closes 1.8 seconds after its last photo.
- Loose photos from the same sender in the same topic are grouped while they keep arriving within 3 seconds of each other. A text message from that sender inside the window becomes the caption.
- Every bundle closes at most 8 seconds after the first photo, or as soon as it holds 10 items.
- The agent receives all images in one prompt with a `[photos attached: N]` label (or a typed count when the bundle mixes files and photos). Voice notes, video notes, and commands are never bundled; they flush any open bundle first. Videos and audio join a bundle only as part of an album.

## How memory works

The bridge and the Telegram bot store no conversation memory. The state file (`BRIDGE_STATE_PATH`) holds only bookkeeping: the Telegram update offset, which agent each chat selected with `/use`, learned topic names, desktop-mirror cursors, pending approval buttons, and delivery progress. Telegram message text is never written to it or to `bridge.log`.

Each message is sent as a new prompt to one Grok Bot agent, and that agent's conversation lives in Grok Bot. Two topics routed to two different agents do not see each other's messages, and the bridge never copies context between agents. If you want an agent to remember something long-term, put it in that agent's files, instructions, or skills inside Grok Bot rather than in Telegram chat.

## Telegram commands

| Command | What it does |
| --- | --- |
| `/help`, `/start`, `/commands` | Show the in-chat help text |
| `/agents` | List Grok agents; `*` marks the one this chat uses |
| `/use <exact name>` | Select an agent for this chat (disabled in routed topics) |
| `/status` | Show the agent and whether it is working or idle |
| `/mirror status`, `/mirror on`, `/mirror off` | Inspect or control desktop mirroring; only the configured mirror user in the configured mirror chat may use these |
| `/skills [search]` | List up to 20 matching live skills |
| `/run <exact skill> [request]` | Run a live skill |
| `/<skill-name> [request]` | Run a single-token skill directly |
| `/routines` | List routines that can be used as `@` references |
| `/mentions` | List available agent and routine references plus box plugin status |
| `/plugins` | Show box plugin connection status |
| `/settings` | Explain that Grok settings actions stay desktop-only |

Any other text, photo, voice note, video, or file is sent as a prompt. Captions on attachments are used as the prompt when present. Exact `@Agent Name` and `@Routine Name` text becomes the same structured reference Grok Bot's composer uses. Attachments are capped at 20 MB in both directions by the public Bot API.

Approval requests from Grok are relayed as one-time **Approve once** and **Deny** buttons that expire after 10 minutes. Secrets, captchas, rich widgets, and persistent permissions are refused; open Grok Bot on desktop for those.

## Desktop mirroring

Optional. Set both `GROK_DESKTOP_MIRROR_CHAT_ID` and `GROK_DESKTOP_MIRROR_USER_ID` to mirror desktop-originated prompts, completed replies, and autonomous routine output into one Telegram chat. Both ids must already be in their allowlists, or startup fails. Omit both to disable the watcher. `/mirror on|off` persists the setting from the configured identity only. Telegram-safe routine choice cards appear as one-time inline buttons in the mirror chat and expire after 12 hours.

## Security notes

- Keep `.env` at mode `600`. The control script refuses to start otherwise. Keep `gateway.json` and the state file at mode `600` too; the bridge refuses them when group or other permissions are set, or when they are symlinks.
- Never paste the bot token, the gateway token, or any password into a Telegram chat. Neither token is written to logs.
- Allowlist only your own chats. A private chat needs both the user id and the chat id. A group id admits every member of that group, so only add groups whose membership you control.
- Sender identity reaches the agent in a `[telegram-from]` header. Lines at the start of a message that imitate the bridge's headers are stripped, so users cannot pretend to be someone else, but the agent still decides what each sender may ask for.
- `GROK_GATEWAY_URL` must be loopback. The gateway token is sent only there, and redirects are refused.
- No inbound ports, webhooks, or tunnels. Telegram is reached by outbound long polling only.
- Turn on Telegram two-step verification and a device passcode for every account on the allowlist.

See [SECURITY.md](SECURITY.md) for the full contract and how to report a vulnerability.

## Operations

### Keep it running

The Grok computer has no service manager. A background process can stop when the computer hibernates or is recreated. Add a Grok routine that runs this after wake, or on a short interval:

```sh
/home/box/grokbot-telegram-bridge/deploy/bridge-control.sh ensure
```

`ensure` starts the bridge only if it is not already running. The other commands are `start`, `stop`, `restart`, and `status`.

### Update

```sh
./deploy/bridge-control.sh stop
git pull
./deploy/bridge-control.sh start
```

Keep `.env` and `bridge-state.json`; they are ignored by git.

### Uninstall

Run `stop`, delete the project directory (including `.env` and `bridge-state.json`), remove any Grok routine that calls `ensure`, and revoke the bot token in BotFather.

### Troubleshooting

| Symptom | What to check |
| --- | --- |
| `Missing .../.env` or `must have mode 600` | `.env` must exist in `BRIDGE_HOME` and be mode `600` |
| Gateway token or state file rejected | `chmod 600` the file; it must be a regular file, not a symlink |
| `GROK_GATEWAY_URL must use a loopback host` | Use `127.0.0.1`, `localhost`, or `::1` only |
| Bot never replies in a private chat | Both `TELEGRAM_ALLOWED_USER_IDS` and `TELEGRAM_ALLOWED_CHAT_IDS` must contain your ids |
| Bot never replies in a group | The group's negative id must be in `TELEGRAM_ALLOWED_CHAT_IDS`; channels are ignored |
| Bot ignores ordinary group messages | Turn off BotFather privacy mode or make the bot an admin; check `TELEGRAM_ALLOWED_TOPIC_IDS`; short acknowledgements and emoji are dropped by design |
| Group replies are too chatty or too quiet | Tune `TELEGRAM_GROUP_KEYWORDS` and `TELEGRAM_GROUP_HINT`, or route the topic to a dedicated agent with `TELEGRAM_TOPIC_AGENTS` |
| Routed topic is silent | Check `bridge.log` for `Topic agent not found`; the agent name or id in `TELEGRAM_TOPIC_AGENTS` must match an agent in Grok Bot |
| `discover-ids` prints nothing | Send `/start` (or a group message) first, then run it again while the bridge is stopped |
| Process dies after idle time | The Grok computer hibernated; call `ensure` from a routine |
| Approval button does nothing | It expired (10 minutes), was already used, or the Grok request is no longer pending |
| Attachment rejected | The public Bot API limit is 20 MB in and out |
| Reply says to open Grok Bot | The gateway returned a secret prompt, captcha, rich widget, or other desktop-only interaction |

Logs are in `bridge.log` next to the process. They contain operational errors, chat ids, topic ids, learned topic names, and the topic-to-agent map, but never message bodies or tokens. If `bridge-state.json` is malformed, the bridge renames it with a `.corrupt-<timestamp>` suffix and starts clean.

## Limitations

- Private chats, allowlisted groups, and forum topics only. No channels or inline mode.
- Group access is per chat, not per member.
- No streaming or edit-as-it-types; the reply arrives when the agent finishes.
- Delivery is at-least-once. A crash can redeliver an update, and a reply can repeat if Telegram accepted it just before the process died.
- Chat Settings, General Settings, and Usage & Billing stay in the Grok desktop UI.
- Grok Bot, its gateway, and Telegram can change without notice.

## Testing

```sh
npm test
npm run check
```

Both run with Node.js alone. There are no dependencies to install.

## License

MIT. See [LICENSE](LICENSE). This fork keeps the original copyright notice of the grokbot-telegram-bridge contributors; fork changes are released under the same license.
