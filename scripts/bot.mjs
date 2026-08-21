#!/usr/bin/env node
// dsh-tg-bot — Telegram-фронт для DeepSeek Harness headless-агентов.
// Long polling getUpdates, allowlist по chat_id, reply-клавиатура меню,
// «чаты» = сессии dsh (session.jsonl.zstd) в выбранном проекте.
//
// Env:
//   NTY_BOT_TOKEN / TELEGRAM_BOT_TOKEN   токен бота
//   TG_ADMIN_CHAT_IDS (или NTY_BOT_CHAT_ID)  разрешённые чаты через запятую
//   DSH_SESSIONS_DIR   каталог сессий (по умолчанию ~/.dsh/sessions)
//   DSH_PROJECTS_DIR   каталог проектов-воркспейсов (по умолчанию ~/.dsh/projects)
//   DSH_TG_POLL_TIMEOUT_S  таймаут getUpdates (по умолчанию 50)

import { getUpdates, sendMessage, editMessageText, inlineKeyboard, tgCall, adminChatIds, botToken, esc, prettyDate } from './lib.mjs'
import { listProjects, listSessions, listRecentSessions, getSession, listWorkspaceSlugs, sessionContext, deleteSession } from './sessions.mjs'
import { runAgent, extractAnswer, statsLine, ensureProjectReady } from './agent.mjs'

const POLL_TIMEOUT = Number(process.env.DSH_TG_POLL_TIMEOUT_S || 50)

const state = new Map()

const cbRegistry = new Map()
let cbSeq = 0
function cbToken(slug, id) {
  const t = (cbSeq++).toString(36)
  cbRegistry.set(t, { slug, id })
  return t
}

function allowed(chatId) {
  return adminChatIds().includes(String(chatId))
}

function ctx(chatId) {
  if (!state.has(chatId)) state.set(chatId, { project: null, sessionId: null, sessionTitle: null, prs: null })
  return state.get(chatId)
}

function keyboard(rows) {
  return { reply_markup: { keyboard: rows.map((r) => r.map((t) => ({ text: t }))), resize_keyboard: true, one_time_keyboard: false } }
}

function removeKeyboard() {
  return { reply_markup: { remove_keyboard: true } }
}

const MENU_ROWS = [['📁 Projects', '❓ Help'], ['🕘 Recent']]

const BUTTON_CMDS = {
  '📁 Projects': '/projects',
  '❓ Help': '/help',
  '✨ New session': '/new',
  '🕘 Recent': '/recent',
}

function projectName(cwd) {
  return cwd ? cwd.split('/').filter(Boolean).pop() || cwd : ''
}

function shortLabel(s, max = 60) {
  const t = s.title || s.firstPrompt || s.lastAssistant || '(untitled)'
  const clean = String(t).replace(/\s+/g, ' ').trim()
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean
}

async function send(chatId, text, opts = {}) {
  return sendMessage(chatId, text, opts)
}

async function help(chatId) {
  await send(chatId,
    '<b>dsh-tg-bot</b> — control DeepSeek Harness agents from Telegram\n\n' +
    '📁 /projects — list projects\n' +
    '💬 /chat N — join session N of the selected project\n' +
    '🕘 /recent [N] — last N sessions across all projects (tap to open)\n' +
    '✨ /new — start a new session in the selected project\n' +
    '📋 /prs — open PRs of the project\n' +
    '🔀 /pr N status|review|merge|close — act on PR #N from the last /prs list\n' +
    '(tip: reply to the PR list message with #N to get action buttons)\n' +
    '🗑 /rm N — delete session N (with confirmation)\n' +
    '🚪 /exit — leave the chat\n\n' +
    'Inside a chat, any message is a task for the agent (with session context).')
}

async function cmdProjects(chatId) {
  const projects = listProjects()
  if (!projects.length) {
    await send(chatId, 'No projects found (no dirs with .env in DSH_PROJECTS_DIR).')
    return
  }
  const c = ctx(chatId)
  c.project = null
  c.sessionId = null
  const text = `<b>Projects (${projects.length}):</b>\n\n` + projects.map((p, i) => `${i + 1}. ${esc(p)}`).join('\n') +
    '\n\nEnter /project + name or tap a button.'
  const rows = projects.map((p) => [`/project ${p}`])
  await send(chatId, text, keyboard([...rows, ['❓ Help']]))
}

async function cmdProject(chatId, arg) {
  const projects = listProjects()
  if (!arg || !projects.includes(arg)) {
    await send(chatId, `Project "${esc(arg || '')}" not found. Available: ${projects.map((p) => esc(p)).join(', ')}`)
    return
  }
  const c = ctx(chatId)
  c.project = arg
  c.sessionId = null
  await send(chatId, `Project <b>${esc(arg)}</b>. Loading sessions…`)
  const slugs = listWorkspaceSlugs().filter((s) => s.includes(arg.replace(/\//g, '-')) || s.includes(arg))
  let sessions = []
  for (const slug of slugs) sessions = sessions.concat(listSessions(slug, 15))
  if (!sessions.length) {
    await send(chatId, 'No sessions found. /new to create one.', keyboard([['✨ New session', '📋 /prs'], ['🕘 Recent', '📁 Projects'], ['❓ Help']]))
    return
  }
  const lines = sessions.map((s, i) =>
    `${i + 1}. ${esc(shortLabel(s))}\n   [${esc(projectName(s.cwd) || arg)}] 🕐 ${prettyDate(s.lastActivity)} · ${s.seqs} records`)
  const text = `<b>Chat sessions for ${esc(arg)}</b> (latest ${sessions.length}):\n\n${lines.join('\n')}\n\nTap a line to open it, or enter /chat N. /new for a new session.`
  const rows = sessions.map((s) => [{ text: `▶️ ${shortLabel(s, 45)}`, callback_data: `open:${cbToken(s.slug, s.id)}` }])
  await send(chatId, text, inlineKeyboard(rows))
}

async function enterChat(chatId, s, n) {
  const c = ctx(chatId)
  const proj = projectName(s.cwd) || c.project
  if (proj) c.project = proj
  c.sessionId = s.id
  c.sessionTitle = s.title
  const note = shortLabel(s) !== '(untitled)' ? `\n\n📄 <b>${esc(shortLabel(s))}</b>` : ''
  const last = s.lastAssistant ? `\n\nLast reply: ${esc(s.lastAssistant.slice(0, 200))}` : ''
  const idx = n ? ` #${n}` : ''
  await send(chatId,
    `💬 Entering chat${idx} (${esc(proj || c.project)})${note}${last}\n\n` +
    `Type a message — it goes to the agent with session context. /exit to leave.`,
    keyboard([['🚪 /exit', '📋 /prs'], ['🕘 Recent', '📁 Projects'], ['❓ Help']]))
}

async function cmdChat(chatId, arg) {
  const c = ctx(chatId)
  if (!c.project) {
    await send(chatId, 'Pick a project first: /projects')
    return
  }
  const n = Number(arg)
  if (!Number.isInteger(n) || n < 1) {
    await send(chatId, 'Usage: /chat + number')
    return
  }
  const slugs = listWorkspaceSlugs().filter((s) => s.includes(c.project.replace(/\//g, '-')) || s.includes(c.project))
  let sessions = []
  for (const slug of slugs) sessions = sessions.concat(listSessions(slug, 15))
  const s = sessions[n - 1]
  if (!s) {
    await send(chatId, `No session #${n} (total ${sessions.length}).`)
    return
  }
  await enterChat(chatId, s, n)
}

async function cmdRecent(chatId, arg) {
  const n = Math.min(Math.max(Number(arg) || 5, 1), 20)
  const recents = listRecentSessions(n)
  if (!recents.length) {
    await send(chatId, 'No sessions found across projects.')
    return
  }
  const lines = recents.map((s, i) =>
    `${i + 1}. [${esc(s.project || '?')}] ${esc(shortLabel(s))}\n   🕐 ${prettyDate(s.lastActivity)} · ${s.seqs} records`)
  const text = `<b>Recent sessions across all projects (${recents.length}):</b>\n\n${lines.join('\n')}\n\nTap a line to open it.`
  const rows = recents.map((s) => [{ text: `▶️ [${s.project || '?'}] ${shortLabel(s, 40)}`, callback_data: `open:${cbToken(s.slug, s.id)}` }])
  await send(chatId, text, inlineKeyboard(rows))
}

async function cmdNew(chatId) {
  const c = ctx(chatId)
  if (!c.project) {
    await send(chatId, 'Pick a project first: /projects')
    return
  }
  c.sessionId = null
  c.sessionTitle = null
  await send(chatId,
    `✨ New session in <b>${esc(c.project)}</b>. Type a task — I'll run the headless agent in the project's main checkout.`,
    keyboard([['🚪 /exit', '📋 /prs'], ['🕘 Recent', '📁 Projects'], ['❓ Help']]))
}

async function cmdPrs(chatId) {
  const c = ctx(chatId)
  if (!c.project) {
    await send(chatId, 'Pick a project first: /projects')
    return
  }
  const ready = ensureProjectReady(c.project)
  if (!ready.ok) {
    await send(chatId, `Project not ready: ${ready.reason}`)
    return
  }
  const { spawnSync } = await import('node:child_process')
  const r = spawnSync('gh', ['pr', 'list', '--state', 'open', '--limit', '20', '--json', 'number,title,headRefName,url'], { cwd: ready.dir, encoding: 'utf8', timeout: 30_000 })
  if (r.status !== 0) {
    await send(chatId, `gh pr list failed (${r.status ?? 'timeout'}): ${(r.stderr || r.stdout || '').slice(-300)}`)
    return
  }
  let prs = []
  try { prs = JSON.parse(r.stdout) } catch { /* noop */ }
  if (!prs.length) {
    const all = spawnSync('gh', ['pr', 'list', '--state', 'all', '--limit', '10', '--json', 'number,title,headRefName,url,state'], { cwd: ready.dir, encoding: 'utf8', timeout: 30_000 })
    let recent = []
    if (all.status === 0) { try { recent = JSON.parse(all.stdout) } catch { /* noop */ } }
    if (!recent.length) {
      await send(chatId, `No PRs found in <b>${esc(c.project)}</b>.`)
      return
    }
    const badge = { MERGED: '🟣', CLOSED: '🚫', OPEN: '🟢' }
    const text = `<b>No open PRs in ${esc(c.project)}</b> — recent (🟣 merged · 🚫 closed · 🟢 open):\n\n` +
      recent.map((p) => `${badge[p.state] || '▪'} #${p.number} ${esc(p.title)} (${esc(p.headRefName)})`).join('\n') +
      '\n\nReply to this message with a PR number for action buttons, or run /pr N status|review|merge|close.'
    const sent = await send(chatId, text)
    c.prs = { msgId: sent.message_id, list: recent }
    return
  }
  const text = `<b>Open PRs in ${esc(c.project)} (${prs.length}):</b>\n\n` + prs.map((p) => `#${p.number} ${esc(p.title)} (${esc(p.headRefName)})`).join('\n') +
    '\n\nReply to this message with a PR number (e.g. <code>#5</code>) for action buttons, or run /pr N status|review|merge|close.'
  const sent = await send(chatId, text)
  c.prs = { msgId: sent.message_id, list: prs }
}

async function cmdRm(chatId, arg) {
  const c = ctx(chatId)
  if (!c.project) {
    await send(chatId, 'Pick a project first: /projects')
    return
  }
  const n = Number(arg)
  if (!Number.isInteger(n) || n < 1) {
    await send(chatId, 'Usage: /rm + number')
    return
  }
  const slugs = listWorkspaceSlugs().filter((s) => s.includes(c.project.replace(/\//g, '-')) || s.includes(c.project))
  let sessions = []
  for (const slug of slugs) sessions = sessions.concat(listSessions(slug, 30))
  const s = sessions[n - 1]
  if (!s) {
    await send(chatId, `No session #${n} (total ${sessions.length}).`)
    return
  }
  const note = shortLabel(s) !== '(untitled)' ? `\n📄 <b>${esc(shortLabel(s))}</b>` : ''
  const last = s.lastAssistant ? `\n${esc(s.lastAssistant.slice(0, 200))}` : ''
  await send(chatId,
    `🗑 Delete session #${n}?${note}${last}\n\n` +
    `🕐 ${prettyDate(s.lastActivity)} · ${s.seqs} records\n\n` +
    `This cannot be undone.`,
    inlineKeyboard([[{ text: '🗑 Yes, delete', callback_data: `rm:${cbToken(s.slug, s.id)}` }], [{ text: 'Cancel', callback_data: 'rm:cancel' }]]))
}

async function prActionMenu(chatId, n) {
  const c = ctx(chatId)
  const pr = (c.prs?.list || []).find((p) => p.number === n)
  if (!pr) {
    await send(chatId, `PR #${n} not in the latest list. Run /prs first, or check the number.`)
    return
  }
  await send(chatId,
    `PR #${n} <b>${esc(pr.title)}</b> (${esc(pr.headRefName)})\n\nPick an action:`,
    inlineKeyboard([
      [{ text: '🔍 Status', callback_data: `pr:${n}:status` }, { text: '👀 Review', callback_data: `pr:${n}:review` }],
      [{ text: '🔀 Merge', callback_data: `pr:${n}:merge` }, { text: '🚫 Close', callback_data: `pr:${n}:close` }],
      [{ text: '📋 /prs', callback_data: 'pr:prs' }, { text: 'Cancel', callback_data: 'pr:cancel' }],
    ]))
}

async function prAction(chatId, n, action) {
  const c = ctx(chatId)
  if (!c.project) {
    await send(chatId, 'Pick a project first: /projects')
    return
  }
  const ready = ensureProjectReady(c.project)
  if (!ready.ok) {
    await send(chatId, `Project not ready: ${ready.reason}`)
    return
  }
  const pr = (c.prs?.list || []).find((p) => p.number === n)
  if (!pr) {
    await send(chatId, `PR #${n} not in the latest list. Run /prs first, or check the number.`)
    return
  }
  const { spawnSync } = await import('node:child_process')
  const gh = (args) => spawnSync('gh', args, { cwd: ready.dir, encoding: 'utf8', timeout: 30_000 })

  switch (action) {
    case 'status': {
      const r = gh(['pr', 'view', String(n), '--json', 'number,title,state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefName,url,additions,deletions'])
      if (r.status !== 0) {
        await send(chatId, `gh pr view failed (${r.status ?? 'timeout'}): ${(r.stderr || r.stdout || '').slice(-300)}`)
        return
      }
      let v
      try { v = JSON.parse(r.stdout) } catch {
        await send(chatId, 'Failed to parse gh output.')
        return
      }
      const checks = v.statusCheckRollup || []
      const pass = checks.filter((x) => x.conclusion === 'SUCCESS').length
      const fail = checks.filter((x) => ['FAILURE', 'ERROR', 'CANCELED'].includes(x.conclusion)).length
      const pend = checks.filter((x) => !x.conclusion).length
      const review = v.reviewDecision ? esc(String(v.reviewDecision)) : 'none'
      const mergeable = esc(String(v.mergeable)) + (v.mergeStateStatus ? ` (${esc(String(v.mergeStateStatus))})` : '')
      await send(chatId,
        `#${v.number} <b>${esc(v.title)}</b>\n` +
        `State: <b>${esc(String(v.state))}</b>${v.isDraft ? ' (draft)' : ''} · branch ${esc(v.headRefName)}\n` +
        `Mergeable: <b>${mergeable}</b>\n` +
        `Review: <b>${review}</b> · Checks: ✅ ${pass} · ❌ ${fail} · ⏳ ${pend}\n` +
        `±${v.additions ?? '?'}/${v.deletions ?? '?'} lines\n${esc(v.url || '')}`)
      break
    }
    case 'merge': {
      const v = gh(['pr', 'view', String(n), '--json', 'mergeable,title'])
      let mergeable = 'UNKNOWN'
      if (v.status === 0) { try { mergeable = JSON.parse(v.stdout).mergeable || 'UNKNOWN' } catch { /* noop */ } }
      if (mergeable !== 'MERGEABLE') {
        await send(chatId, `PR #${n} is not mergeable (<b>${esc(mergeable)}</b>). Status: /pr ${n} status`)
        return
      }
      const r = gh(['pr', 'merge', String(n), '--squash', '--delete-branch=false'])
      if (r.status !== 0) {
        await send(chatId, `Merge failed (${r.status ?? 'timeout'}): ${(r.stderr || r.stdout || '').slice(-300)}`)
        return
      }
      await send(chatId, `✅ Merged #${n} (squash).`)
      break
    }
    case 'close': {
      const r = gh(['pr', 'close', String(n)])
      if (r.status !== 0) {
        await send(chatId, `Close failed (${r.status ?? 'timeout'}): ${(r.stderr || r.stdout || '').slice(-300)}`)
        return
      }
      await send(chatId, `🚫 Closed #${n}.`)
      break
    }
    case 'review': {
      const prompt =
        `You are reviewing GitHub pull request #${pr.number} "${pr.title}" (branch ${pr.headRefName}) in this repository.\n\n` +
        `Inspect it with:\n1. gh pr view ${pr.number}\n2. gh pr diff ${pr.number}\n3. gh pr checks ${pr.number}\n\n` +
        `Produce a concise review:\n- What the PR does (1–2 sentences)\n- Issues: file:line, severity, why (max 5)\n- Brief positive notes\n- Verdict: approve / request changes / comment\n\n` +
        `Keep it under 600 words.`
      await runAgentTask(chatId, prompt, { label: `👀 Reviewing PR #${pr.number}` })
      break
    }
    default:
      await send(chatId, 'Unknown action. Use: status, review, merge, close.')
  }
}

async function handleCallback(cq) {
  const chatId = String(cq.message.chat.id)
  try { await tgCall('answerCallbackQuery', { callback_query_id: cq.id }) } catch { /* noop */ }
  if (!allowed(chatId)) return
  const data = cq.data || ''
  const msgId = cq.message.message_id
  if (data.startsWith('open:')) {
    const ref = cbRegistry.get(data.slice(5))
    if (!ref) {
      try { await editMessageText(chatId, msgId, 'Session reference expired — resend the list.') } catch { /* noop */ }
      return
    }
    const { slug, id } = ref
    const s = getSession(slug, id)
    if (!s) {
      try { await editMessageText(chatId, msgId, 'Session not found (deleted?).') } catch { /* noop */ }
      return
    }
    try { await editMessageText(chatId, msgId, '💬 Opening…') } catch { /* noop */ }
    await enterChat(chatId, s, null)
    return
  }
  if (data.startsWith('pr:')) {
    const [, ns, action] = data.split(':')
    if (ns === 'cancel') {
      try { await editMessageText(chatId, msgId, 'Cancelled.') } catch { /* noop */ }
      return
    }
    if (ns === 'prs') {
      await cmdPrs(chatId)
      return
    }
    const n = Number(ns)
    if (!Number.isInteger(n) || n < 1 || !action) {
      try { await editMessageText(chatId, msgId, 'Bad PR reference.') } catch { /* noop */ }
      return
    }
    try { await editMessageText(chatId, msgId, `▶️ ${esc(action)} on PR #${n}…`) } catch { /* noop */ }
    await prAction(chatId, n, action)
    return
  }
  if (!data.startsWith('rm:')) return
  if (data === 'rm:cancel') {
    try { await editMessageText(chatId, msgId, 'Cancelled.') } catch { /* noop */ }
    return
  }
  const ref = cbRegistry.get(data.slice(3))
  if (!ref) {
    try { await editMessageText(chatId, msgId, 'Session reference expired — resend the list.') } catch { /* noop */ }
    return
  }
  const { slug, id } = ref
  let deleted = false
  try {
    deleted = deleteSession(slug, id)
    await editMessageText(chatId, msgId, deleted ? '🗑 Session deleted.' : 'Session not found (already gone?).')
  } catch (e) {
    await editMessageText(chatId, msgId, `❌ Delete failed: ${esc(String(e))}`)
    return
  }
  const c = ctx(chatId)
  if (deleted && c.sessionId === id) { c.sessionId = null; c.sessionTitle = null }
}

async function runAgentTask(chatId, prompt, opts = {}) {
  const c = ctx(chatId)
  if (c.busy) {
    await send(chatId, '⏳ One task at a time — wait for the current run or /exit first.')
    return
  }
  c.busy = true
  try {
    const status = await send(chatId, `⚙️ ${opts.label || 'Running headless agent'} in <b>${esc(c.project)}</b>… this may take a few minutes.`)
    const progress = { tail: '', elapsedMs: 0 }
    let prevTail = ''
    const updater = setInterval(async () => {
      if (!progress.tail || progress.tail === prevTail) return
      prevTail = progress.tail
      const tail = progress.tail.split('\n').filter((l) => l.trim()).slice(-2).map((l) => esc(l.slice(0, 300))).join('\n')
      try {
        await editMessageText(chatId, status.message_id,
          `⚙️ Running in <b>${esc(c.project)}</b>… ⏱ ${(progress.elapsedMs / 60000).toFixed(1)} min\n\n<code>${tail}</code>`)
      } catch { /* ignore stale edits */ }
    }, 8000)
    const run = await runAgent({
      project: c.project,
      prompt,
      onProgress: (p) => { progress.tail = p.tail; progress.elapsedMs = p.elapsedMs },
    })
    clearInterval(updater)
    const answer = extractAnswer(run)
    try { await editMessageText(chatId, status.message_id, `${run.ok ? '✅' : '❌'} ${run.ok ? 'Done' : 'Failed'} · ${statsLine(run)}`) } catch { /* noop */ }
    await send(chatId, answer)
  } finally {
    c.busy = false
  }
}

async function runPrompt(chatId, text) {
  const c = ctx(chatId)
  if (!c.project) {
    await send(chatId, 'No project selected. /projects → /project + name')
    return
  }
  const ready = ensureProjectReady(c.project)
  if (!ready.ok) {
    await send(chatId, `Project not ready: ${ready.reason}`)
    return
  }
  let prompt = text
  if (c.sessionId) {
    const slugs = listWorkspaceSlugs().filter((s) => s.includes(c.project.replace(/\//g, '-')) || s.includes(c.project))
    for (const slug of slugs) {
      const ctxText = sessionContext(slug, c.sessionId)
      if (ctxText) { prompt = `Continue this session: ${ctxText}\n\n# User task\n${text}`; break }
    }
  }
  await runAgentTask(chatId, prompt, { label: 'Running headless agent' })
}

async function handleMessage(msg) {
  const chatId = String(msg.chat.id)
  if (!allowed(chatId)) {
    console.log(`ignored message from chat ${chatId}`)
    return
  }
  const text0 = (msg.text || '').trim()
  if (!text0) return
  const text = BUTTON_CMDS[text0] || text0

  const c = ctx(chatId)
  const reply = msg.reply_to_message
  const prReply = reply && c.prs && reply.message_id === c.prs.msgId
  const prRef = text.match(/^#?(\d+)(?:\s+([a-z]+))?$/i)
  if (prReply && prRef) {
    const n = Number(prRef[1])
    if (prRef[2]) { await prAction(chatId, n, prRef[2].toLowerCase()); return }
    await prActionMenu(chatId, n)
    return
  }

  if (text.startsWith('/')) {
    const [cmd, ...rest] = text.split(/\s+/)
    const arg = rest.join(' ')
    switch (cmd) {
      case '/start':
      case '/menu':
        await send(chatId, '<b>dsh-tg-bot</b> — Telegram front for DeepSeek Harness.\n\nPick a project — then write tasks to the agent inside the "chat".', keyboard(MENU_ROWS))
        break
      case '/help':
        await help(chatId)
        break
      case '/projects':
        await cmdProjects(chatId)
        break
      case '/project':
        await cmdProject(chatId, arg)
        break
      case '/chat':
        await cmdChat(chatId, arg)
        break
      case '/recent':
        await cmdRecent(chatId, arg)
        break
      case '/new':
        await cmdNew(chatId)
        break
      case '/prs':
        await cmdPrs(chatId)
        break
      case '/pr': {
        if (!arg) {
          await send(chatId, 'Usage: /pr + number + action (status, review, merge, close). See /prs for the list.')
          break
        }
        const m = arg.match(/^#?(\d+)(?:\s+([a-z]+))?$/i)
        if (!m) {
          await send(chatId, 'Usage: /pr + number + action (status, review, merge, close).')
          break
        }
        const n = Number(m[1])
        if (m[2]) { await prAction(chatId, n, m[2].toLowerCase()); break }
        await prActionMenu(chatId, n)
        break
      }
      case '/rm':
        await cmdRm(chatId, arg)
        break
      case '/exit':
        state.set(chatId, { project: null, sessionId: null, sessionTitle: null })
        await send(chatId, '🚪 Left chat. /projects to pick a project.', keyboard(MENU_ROWS))
        break
      default:
        await send(chatId, 'Unknown command. /help for the list.')
    }
    return
  }

  await runPrompt(chatId, text)
}

async function main() {
  if (!botToken()) {
    console.error('NTY_BOT_TOKEN not set')
    process.exit(1)
  }
  console.log(`dsh-tg-bot: polling start (admins: ${adminChatIds().join(', ') || '(none — commands ignored)'})`)
  let offset = 0
  for (;;) {
    try {
      const updates = await getUpdates(offset, POLL_TIMEOUT)
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1)
        if (u.message) void handleMessage(u.message).catch((e) => console.error(`handleMessage: ${e.message}`))
        else if (u.callback_query) void handleCallback(u.callback_query).catch((e) => console.error(`handleCallback: ${e.message}`))
      }
    } catch (e) {
      console.error(`poll error: ${e.message}`)
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
}

main()