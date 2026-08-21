# dsh-plugin-telegram

Self-hosted Telegram front for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): pick a project, join a dsh session as a "chat", and run headless agents from Telegram. **No external services** — the bot talks directly to `api.telegram.org` with your own token; everything stays on your machine.

**Demo (19s):** a full loop — browse sessions, open a chat, run a task, watch live progress, then act on a PR.

https://github.com/citedy/dsh-telegram-bot/releases/download/assets-v1/tg_dsh_harness_demo.MP4

> Different by design from `dsh-imessage`-style bridges: no hosted middleman, no accounts on third-party services. You create your own bot in 2 minutes and own the whole pipeline.

## Features

- `/projects` — list connected projects (workspaces with `.env`)
- `/project <name>` — open a project; session rows are clickable buttons that open the chat directly
- `/chat N` — join a dsh session (`session.jsonl.zstd`) — a "chat" with the agent
- `/recent [N]` — last N sessions across all projects (default 5), each row opens the chat
- `/new` — start a new session in the selected project
- Any message inside a chat → task for the headless agent, with context of the last session messages
- Live progress — the running message is updated every ~8 s with the agent's latest output (`editMessageText`)
- `/prs` — open PRs of the project (reply to that message with `#5` → action buttons)
- `/pr N status|review|merge|close` — act on PR #N from the last `/prs` list (status = gh summary, review = agent code review, merge = squash merge, close)
- `/rm N` — delete a session with an inline confirmation button
- `/exit` — leave the chat
- Chat-id allowlist — commands are accepted only from whitelisted chats

## How it works

```
Telegram user ──long polling──▶ bot.mjs ──▶ agent.mjs ──▶ npx @deepseek-ai/dsh headless (in project dir)
                                   │
                                   ├──▶ sessions.mjs ──▶ session.jsonl.zstd (chat history context)
                                   ├──▶ gh CLI ──▶ /prs, /pr N status|review|merge|close
                                   └──▶ lib.mjs ──▶ api.telegram.org (send/edit messages, fake streaming)
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full interface diagram and flows.

## Install

**Quick way (npx wizard):**

```bash
npx dsh-plugin-telegram
```

The wizard asks for a bot token (create one via [@BotFather](https://t.me/BotFather)), detects your chat id, validates both against the Telegram API, writes the env file, and prints exact systemd commands for your machine.

**As a dsh plugin:**

```bash
dsh plugin --profile <name> add dsh-plugin-telegram
npx dsh-plugin-telegram   # run the setup wizard once
```

**Manual (from source):**

1. Create a bot via [@BotFather](https://t.me/BotFather), get a token.
2. Clone the repo somewhere (example: `/opt/dsh-telegram-bot`).
3. Copy `.env.example` to `/etc/dsh/dsh-tg-bot.env`, fill the token and `TG_ADMIN_CHAT_IDS` (your chat id; can be found via @userinfobot).
4. Run as a service (adjust `WorkingDirectory`/`User` in the unit to your install):

```bash
sudo cp deploy/dsh-tg-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-tg-bot
journalctl -u dsh-tg-bot -f
```

Without systemd: `NTY_BOT_TOKEN=... TG_ADMIN_CHAT_IDS=... node scripts/bot.mjs`

## Configuration

| Variable | Default | Description |
|---|---|---|
| `NTY_BOT_TOKEN` / `TELEGRAM_BOT_TOKEN` | — | bot token |
| `TG_ADMIN_CHAT_IDS` / `NTY_BOT_CHAT_ID` | — | allowed chat ids, comma separated |
| `DSH_SESSIONS_DIR` | `$DSH_HOME/sessions` (usually `~/.dsh/sessions`) | dsh sessions directory |
| `DSH_PROJECTS_DIR` | `~/.dsh/projects` | projects directory |
| `DSH_TG_CLI_BIN` | — (npx) | path to a pinned `dsh` binary; skip npx resolution |
| `DSH_TG_PROFILE` | `headless` | dsh profile the headless agent runs with |
| `DSH_TG_TIMEOUT_MIN` | `20` | headless run timeout, minutes |
| `DSH_TG_POLL_TIMEOUT_S` | `50` | getUpdates timeout |

## Requirements

- Node.js ≥ 20
- `zstd` CLI (to read `session.jsonl.zstd`)
- `@deepseek-ai/dsh` installed (launched via `npx -y`)
- `gh` CLI (for `/prs`, `/pr`)

## License

MIT