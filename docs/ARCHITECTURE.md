# Architecture

## Overview

`dsh-telegram-bot` is a stateless Node.js process that bridges a Telegram bot to [DeepSeek Harness](https://github.com/deepseek-ai/dsh). The user picks a project, joins a dsh session as a "chat", and sends tasks as plain messages. Each message is run as a **headless** dsh agent in the project's main checkout; the session context is injected into the prompt because the headless profile has no `--resume`.

## Interface diagram

```
 Telegram user (chat 123456789 …)
        │  HTTPS + long polling getUpdates (no webhook, one process)
        ▼
 ┌────────────────────────────────────────────────────────────────┐
 │ scripts/bot.mjs — router                                       │
 │  · /commands, chat-id allowlist (TG_ADMIN_CHAT_IDS)            │
 │  · reply keyboards mapped to commands (BUTTON_CMDS)            │
 │  · inline callbacks: open:<token>, rm:<token> (short registry  │
 │    tokens → {slug,id}; Telegram caps callback_data at 64 B),   │
 │    pr:<n>:<action>, pr:prs                                     │
 │  · reply-to-<prs-message> context → PR action buttons          │
 │  · live progress: editMessageText every ~8 s (fake streaming)  │
 └───────┬───────────────┬───────────────┬───────────────┬────────┘
         │               │               │               │
         ▼               ▼               ▼               ▼
 ┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌──────────────────┐
 │ sessions.mjs  │ │  agent.mjs    │ │   lib.mjs     │ │  gh CLI (exe)    │
 │ filesystem    │ │  dsh headless │ │ Telegram API  │ │ GitHub REST via  │
 │ reader        │ │  subprocess   │ │ wrapper       │ │ git discovery    │
 └───────┬───────┘ └───────┬───────┘ └───────┬───────┘ └────────┬─────────┘
         ▼                 ▼                 ▼                   ▼
 DSH_SESSIONS_DIR/     npx -y @deepseek-ai/  api.telegram.org/   project git repo
 <slug>/session-*/     dsh --profile         bot<token>/<method> (gh pr list/view/
 session.jsonl.zstd    headless <prompt>     (JSON over HTTPS)   merge/close/diff)
 (zstd -dc)            in project dir                            │
         │                 │                                     │
         └────┬────────────┴─────────────────────────────────────┘
              ▼
 DSH_PROJECTS_DIR/<project>  — .env (keys), git checkout (cwd for agent + gh)
```

External interfaces:

| Interface | Kind | Used by |
|---|---|---|
| `api.telegram.org/bot<token>/…` | HTTPS JSON (long polling) | `lib.mjs` → bot.mjs |
| `DSH_SESSIONS_DIR/**/session-*/session.jsonl.zstd` | filesystem (zstd) | `sessions.mjs` |
| `DSH_PROJECTS_DIR/<project>/.env` | filesystem | `agent.mjs` (env for subprocess) |
| `npx -y @deepseek-ai/dsh --profile headless <prompt>` | subprocess (project cwd) | `agent.mjs` |
| `gh pr …` (list/view/merge/close/diff/checks) | subprocess (project cwd) | bot.mjs |

## Data model

- **Project** — a directory in `DSH_PROJECTS_DIR` containing a `.env` (a "main checkout").
- **Session** — a dsh session: `session.jsonl.zstd` under `DSH_SESSIONS_DIR/<workspace-slug>/session-<uuid>/`.
  - `workspace-slug` is dsh's internal slug, e.g. `--home-user-.dsh-projects-my-app--`.
  - The project path is read from the first `"type":"session"` record's `cwd`, not decoded from the slug.
  - `title`, `firstPrompt`, `lastAssistant`, `lastActivity`, `seqs` are read from the last JSONL records (memory + headless result). Titles are often absent — the bot displays `title || firstPrompt || lastAssistant` as the row label.

## Flows

### `/projects`
Lists directories with `.env` in `DSH_PROJECTS_DIR`. Selecting a project resets `sessionId`.

### `/project <name>` and session list
Lists the latest sessions of the project. Each session row has an inline button (`open:<token>`) — tapping it opens that chat directly (the token resolves to `{slug, id}` via an in-memory registry, because `slug:id` doesn't fit Telegram's 64-byte `callback_data` limit). Sessions without a title fall back to the first prompt or last assistant text, so rows are rarely "(untitled)".

### `/recent [N]`
Fast cross-project view: scans session dirs by file mtime (no full decompression until the top N candidates are known) and lists the latest N sessions (default 5, max 20) across all workspaces. Each row is a clickable inline button that opens the chat and switches the project from the session's `cwd`.

### `/chat N`
Maps `N` (1-based) to the `N`-th most recent session across all matching slugs, then delegates to `enterChat()`. The same path is used by the `open:` callback.

### plain message (inside a chat)
1. If `sessionId` is set, read the last session messages and build:
   `Continue this session: <context>\n\n# User task\n<message>`
2. Send "running…" ack (returns `message_id`).
3. `runAgent()`: `npx -y @deepseek-ai/dsh --profile headless <prompt>` in the project dir, timeout default 20 min (`timeoutMin` param), process group killed on timeout.
4. While running, `onProgress` pushes stdout tails every ~8 s; the bot edits the ack message with the latest output (fake streaming — Telegram has no real streaming API).
5. On finish, the ack is edited to `✅/❌ Done/Failed · ⏱ N min` and the final answer is sent as a new message.

The polling loop does not await handlers, so `/exit`, `/prs`, `/recent` and callbacks stay responsive while an agent is running. One task at a time per chat — a `busy` flag rejects new tasks until the current run finishes.

### `/prs`
`gh pr list --state open` in the project dir (requires the `gh` CLI). The result message id and PR list are kept in per-chat state. If there are no open PRs, falls back to `gh pr list --state all --limit 10` with state badges (🟣 merged · 🚫 closed · 🟢 open), so `/pr` actions still work on recent PRs.

### `/pr N status|review|merge|close`
Acts on PR #N from the last `/prs` list:
- `status` — `gh pr view` JSON (state, mergeable, review decision, CI check rollup) rendered as a summary;
- `review` — headless agent task: inspect via `gh pr view/diff/checks`, produce a concise review with a verdict;
- `merge` — `gh pr merge --squash --delete-branch=false`, but only after confirming `mergeable == MERGEABLE`;
- `close` — `gh pr close`.

Replies to the `/prs` message are context-aware: replying `#5` shows inline action buttons (status/review/merge/close), `#5 merge` runs the action directly. Anything else is treated as a normal task.

### `/rm N`
Maps `N` the same way `/chat N` does, then sends an inline confirmation button (`rm:<token>` callback, same token registry as `open:`). On confirm, `deleteSession()` removes the session directory. Session ids are validated against `^session-[0-9a-f-]+$` and resolved paths must stay inside `DSH_SESSIONS_DIR` (no path escape). If the deleted session was the active chat, `sessionId` is reset. Tokens live in memory only — after a bot restart, stale buttons answer "reference expired".

## Security notes

- Commands are accepted only from chats in `TG_ADMIN_CHAT_IDS`; other chats are ignored and logged.
- Bot token is read from environment only (`NTY_BOT_TOKEN` / `TELEGRAM_BOT_TOKEN`); never hardcoded.
- The service runs as a dedicated user (`User=dsh`) and reads a root-owned, 0600 env file.
- No webhook — long polling with `getUpdates`, one process at a time (a second poller would get HTTP 409).
- Session deletion validates the session id format and resolves the path inside `DSH_SESSIONS_DIR` (no path escape).
- User text is HTML-escaped before sending (`parse_mode=HTML`) to avoid broken entities; do not wrap literal `<...>` in messages.