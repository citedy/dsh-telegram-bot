#!/usr/bin/env node
// sessions — менеджер сессий/воркспейсов dsh: список проектов, сессий,
// последние сообщения для контекста.

import { existsSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'
import { dshSessionsDir, dshProjectsDir, parseSession, listSessionDirs, decompress, sessionCwd } from './lib.mjs'

export function listProjects() {
  const dir = dshProjectsDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, '.env')))
    .map((e) => e.name)
    .sort()
}

export function projectSlugToPath(slug) {
  const dir = dshSessionsDir()
  const full = join(dir, slug)
  if (!existsSync(full)) return null
  const sess = listSessionDirs(full)[0]
  if (!sess) return null
  const raw = decompress(join(full, sess, 'session.jsonl.zstd'))
  return sessionCwd(raw)
}

export function listWorkspaceSlugs() {
  const dir = dshSessionsDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
}

export function listSessions(workspaceSlug, limit = 12) {
  const dir = join(dshSessionsDir(), workspaceSlug)
  if (!existsSync(dir)) return []
  const out = []
  for (const s of listSessionDirs(dir)) {
    const f = join(dir, s, 'session.jsonl.zstd')
    if (!existsSync(f)) continue
    const rec = parseSession(f)
    if (!rec) continue
    const mtime = statSync(f).mtime
    out.push({ id: s, slug: workspaceSlug, cwd: rec.cwd || '', title: rec.title, firstPrompt: rec.firstPrompt, lastAssistant: rec.lastAssistant, lastActivity: rec.lastActivity || mtime, messages: rec.messages, seqs: rec.seqs })
  }
  out.sort((a, b) => b.lastActivity - a.lastActivity)
  return out.slice(0, limit)
}

export function getSession(workspaceSlug, sessionId) {
  const f = join(dshSessionsDir(), workspaceSlug, sessionId, 'session.jsonl.zstd')
  if (!existsSync(f)) return null
  const rec = parseSession(f)
  if (!rec) return null
  const mtime = statSync(f).mtime
  return { id: sessionId, slug: workspaceSlug, cwd: rec.cwd || '', title: rec.title, firstPrompt: rec.firstPrompt, lastAssistant: rec.lastAssistant, lastActivity: rec.lastActivity || mtime, messages: rec.messages, seqs: rec.seqs }
}

export function listRecentSessions(limit = 5) {
  const root = dshSessionsDir()
  if (!existsSync(root)) return []
  const cands = []
  for (const slug of listWorkspaceSlugs()) {
    const dir = join(root, slug)
    for (const s of listSessionDirs(dir)) {
      const f = join(dir, s, 'session.jsonl.zstd')
      if (!existsSync(f)) continue
      let mtime
      try { mtime = statSync(f).mtime.getTime() } catch { continue }
      cands.push({ slug, id: s, mtime })
    }
  }
  cands.sort((a, b) => b.mtime - a.mtime)
  const out = []
  for (const cand of cands) {
    const f = join(root, cand.slug, cand.id, 'session.jsonl.zstd')
    const rec = parseSession(f)
    if (!rec) continue
    const project = rec.cwd ? basename(rec.cwd) : projectSlugToPath(cand.slug)
    out.push({ id: cand.id, slug: cand.slug, cwd: rec.cwd || '', project, title: rec.title, firstPrompt: rec.firstPrompt, lastAssistant: rec.lastAssistant, lastActivity: rec.lastActivity || new Date(cand.mtime), messages: rec.messages, seqs: rec.seqs })
    if (out.length >= limit) break
  }
  return out
}

export function sessionContext(ws, sessionId) {
  const f = join(dshSessionsDir(), ws, sessionId, 'session.jsonl.zstd')
  if (!existsSync(f)) return ''
  const rec = parseSession(f)
  if (!rec || !rec.messages.length) return ''
  const blocks = rec.messages.map((m) => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.text.slice(0, 2000)}`).join('\n')
  return `\n\n# Текущий контекст сессии (последние сообщения)\n${blocks}`
}

export function deleteSession(slug, sessionId) {
  const root = resolve(dshSessionsDir())
  if (!/^session-[0-9a-f-]+$/i.test(sessionId)) throw new Error('invalid session id')
  const full = resolve(join(root, slug, sessionId))
  if (!full.startsWith(root + '/')) throw new Error('path escape')
  if (!existsSync(full)) return false
  rmSync(full, { recursive: true, force: true })
  return true
}

export function projectBasename(cwd) {
  if (!cwd) return ''
  const parts = cwd.split('/')
  return parts[parts.length - 1] || ''
}