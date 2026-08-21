#!/usr/bin/env node
// setup — интерактивный визард первой настройки dsh-plugin-telegram.
// Спрашивает токен бота и chat id, проверяет их через Telegram API,
// пишет .env и (опционально) systemd-юнит. Идемпотентен.

import { createInterface } from 'node:readline'
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function ask(rl, q) {
  return new Promise((res) => rl.question(q, res))
}

async function api(token, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  return j
}

async function main() {
  console.log('dsh-plugin-telegram setup\n')

  const rl = createInterface({ input: process.stdin, output: process.stdout })

  // 1. bot token
  let token = process.env.NTY_BOT_TOKEN || ''
  if (!token) token = await ask(rl, '1/3 Bot token from @BotFather: ')
  token = token.trim()

  const me = await api(token, 'getMe', {})
  if (!me.ok) {
    console.error(`Token check failed: ${me.description || 'unknown error'}`)
    rl.close()
    process.exit(1)
  }
  console.log(`   ✓ @${me.result.username}`)

  // 2. chat id — отправляем боту сообщение, юзер форвардит/пишет, читаем updates
  let chatId = process.env.TG_ADMIN_CHAT_IDS || ''
  if (!chatId) {
    console.log('\n2/3 Write /start to your bot in Telegram, then press Enter here…')
    await ask(rl, '')
    const upd = await api(token, 'getUpdates', { limit: 50 })
    const ids = [...new Set((upd.result || [])
      .map((u) => u.message?.chat)
      .filter((c) => c && (c.type === 'private'))
      .map((c) => String(c.id)))]
    if (ids.length === 1) {
      chatId = ids[0]
      console.log(`   ✓ chat id: ${chatId} (${upd.result.find((u) => u.message?.chat.id === Number(chatId)).message.chat.first_name || ''})`)
    } else if (ids.length > 1) {
      chatId = (await ask(rl, `   Several chats found [${ids.join(', ')}] — enter the right one: `)).trim()
    } else {
      chatId = (await ask(rl, '   Could not detect — enter your chat id manually (@userinfobot): ')).trim()
    }
  } else {
    console.log('2/3 TG_ADMIN_CHAT_IDS is set — skipping chat detection')
  }

  // 3. env file
  const envDefault = '/etc/dsh/dsh-tg-bot.env'
  const envPath = (await ask(rl, `\n3/3 Where to write the env file? [${envDefault}] `)).trim()
  const envTarget = envPath || envDefault

  const envContent = `NTY_BOT_TOKEN=${token}
TG_ADMIN_CHAT_IDS=${chatId}
#DSH_SESSIONS_DIR=
#DSH_PROJECTS_DIR=
#DSH_TG_PROFILE=headless
#DSH_TG_POLL_TIMEOUT_S=50
`
  try {
    mkdirSync(dirname(envTarget), { recursive: true })
    if (existsSync(envTarget)) {
      const cur = readFileSync(envTarget, 'utf8')
      if (cur.includes(token)) {
        console.log(`   ✓ ${envTarget} already up to date`)
      } else {
        writeFileSync(envTarget + '.new', envContent)
        console.log(`   ⚠ ${envTarget} exists — new version written to ${envTarget}.new`)
      }
    } else {
      writeFileSync(envTarget, envContent)
      console.log(`   ✓ ${envTarget}`)
    }
  } catch (e) {
    console.log(`   ⚠ cannot write ${envTarget} (${e.code || e.message}) — printing instead:\n`)
    console.log(envContent)
  }

  rl.close()

  // systemd unit hint
  const unitSrc = join(pkgRoot, 'deploy', 'dsh-tg-bot.service')
  const installDir = process.cwd()
  console.log(`
Done. To run:

  systemd (recommended):
    sudo cp ${unitSrc} /etc/systemd/system/
    # edit the unit: WorkingDirectory=${installDir}, EnvironmentFile=${envTarget}
    sudo systemctl daemon-reload && sudo systemctl enable --now dsh-tg-bot

  or foreground:
    set -a; . ${envTarget}; set +a; node ${join(pkgRoot, 'scripts', 'bot.mjs')}
`)
}

main().catch((e) => { console.error(e.message); process.exit(1) })
