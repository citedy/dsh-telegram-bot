#!/usr/bin/env node
// lib — общие утилиты dsh-plugin-telegram: Telegram Bot API, env, сессии.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'

export const HOME = process.env.HOME || '/root'

export function loadEnvFile(file) {
  if (!existsSync(file)) return {}
  const out = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    else if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

export function botToken() {
  return process.env.NTY_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || ''
}

export function adminChatIds() {
  const raw = process.env.TG_ADMIN_CHAT_IDS || process.env.NTY_BOT_CHAT_ID || ''
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

export function dshSessionsDir() {
  if (process.env.DSH_SESSIONS_DIR) return process.env.DSH_SESSIONS_DIR
  const dshHome = process.env.DSH_HOME || join(HOME, '.dsh')
  return join(dshHome, 'sessions')
}

export function dshProjectsDir() {
  return process.env.DSH_PROJECTS_DIR || join(HOME, '.dsh', 'projects')
}

const TG = 'https://api.telegram.org'

export async function tgCall(method, payload) {
  const token = botToken()
  if (!token) throw new Error('NTY_BOT_TOKEN not set')
  const res = await fetch(`${TG}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json().catch(() => ({}))
  if (!data.ok) throw new Error(`telegram ${method}: ${data.description || res.status}`)
  return data.result
}

export async function sendMessage(chatId, text, opts = {}) {
  return tgCall('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...opts,
  })
}

export async function editMessageText(chatId, messageId, text, opts = {}) {
  return tgCall('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...opts,
  })
}

export function inlineKeyboard(rows) {
  return { reply_markup: { inline_keyboard: rows } }
}

export async function getUpdates(offset, timeout = 50) {
  return tgCall('getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] })
}

export function decompress(file) {
  const r = spawnSync('zstd', ['-dc', file], { encoding: 'utf8', timeout: 30_000 })
  if (r.status !== 0) return null
  return r.stdout
}

export function sessionCwd(raw) {
  for (const line of (raw || '').split('\n')) {
    if (!line.trim()) continue
    let d
    try { d = JSON.parse(line) } catch { continue }
    if (d.type === 'session' && d.cwd) return d.cwd
  }
  return null
}

export function parseSession(file) {
  const raw = decompress(file)
  if (!raw) return null
  const lines = raw.split('\n')
  const rec = { title: '', cwd: '', firstPrompt: '', lastAssistant: '', lastActivity: null, tools: new Set(), size: raw.length, seqs: 0, messages: [] }
  let firstUser = null
  for (const line of lines) {
    if (!line.trim()) continue
    let d
    try { d = JSON.parse(line) } catch { continue }
    rec.seqs++
    if (d.time) rec.lastActivity = new Date(d.time)
    const t = d.type
    if (t === 'session' && d.cwd) {
      rec.cwd = String(d.cwd)
    } else if (t === 'session/title' && d.data?.source?.kind === 'provider' && d.data?.title) {
      rec.title = String(d.data.title)
    } else if (t === 'user/message' && d.data?.content) {
      const text = d.data.content
        .filter((c) => c.type === 'text' && !c.text?.startsWith('<system-reminder>') && !c.text?.startsWith('Current runtime context'))
        .map((c) => c.text ?? '')
        .join(' ')
        .trim()
      if (text) {
        rec.lastAssistant = ''
        if (firstUser === null) firstUser = text
        rec.messages.push({ role: 'user', text })
      }
    } else if (t === 'tool/call' && d.data?.name) {
      rec.tools.add(String(d.data.name))
    } else if (t === 'assistant/message' && d.data?.message?.content) {
      const texts = d.data.message.content.filter((c) => c.type === 'text' && c.text).map((c) => c.text.trim())
      if (texts.length) {
        rec.lastAssistant = texts[texts.length - 1].slice(0, 600)
        rec.messages.push({ role: 'assistant', text: texts[texts.length - 1] })
      }
    }
  }
  rec.firstPrompt = (firstUser ?? '').slice(0, 300)
  if (rec.messages.length > 40) rec.messages = rec.messages.slice(-40)
  return rec
}

export function listSessionDirs(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('session-'))
    .map((e) => e.name)
}

export function prettyDate(d) {
  if (!d) return '—'
  return d.toISOString().replace('T', ' ').slice(0, 16)
}

export function esc(s = '') {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}