#!/usr/bin/env node
// agent — драйвер headless dsh-агента: запуск задачи в проекте с контекстом
// сессии, таймаут, убийство process group, возврат финального ответа.

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { loadEnvFile, dshProjectsDir } from './lib.mjs'

const DEFAULT_TIMEOUT_MIN = 20
const DSH_PROFILE = () => process.env.DSH_TG_PROFILE || 'headless'
const DSH_BIN = () => process.env.DSH_TG_CLI_BIN || ''

export function projectEnv(project) {
  const dir = join(dshProjectsDir(), project)
  const envFile = join(dir, '.env')
  if (!existsSync(envFile)) return null
  return { dir, envFile, env: loadEnvFile(envFile) }
}

export function ensureProjectReady(project) {
  const p = projectEnv(project)
  if (!p) return { ok: false, reason: `missing ${join(dshProjectsDir(), project, '.env')}` }
  if (!p.env.DEEPSEEK_API_KEY && !process.env.DEEPSEEK_API_KEY) return { ok: false, reason: 'no DEEPSEEK_API_KEY' }
  return { ok: true, ...p }
}

export function runAgent({ project, prompt, timeoutMin, env = {}, onProgress }) {
  const ready = ensureProjectReady(project)
  if (!ready.ok) return { ok: false, reason: ready.reason }
  const cwd = ready.dir
  const timeout = (timeoutMin || Number(process.env.DSH_TG_TIMEOUT_MIN) || DEFAULT_TIMEOUT_MIN) * 60_000

  const childEnv = {
    ...process.env,
    ...ready.env,
    ...env,
  }

  const started = Date.now()
  let out = ''
  let err = ''
  let lastProgress = ''

  const child = DSH_BIN()
    ? spawn(DSH_BIN(), ['--profile', DSH_PROFILE(), prompt], { cwd, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('npx', ['-y', '@deepseek-ai/dsh', '--profile', DSH_PROFILE(), prompt], { cwd, env: childEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })

  child.stdout.on('data', (d) => {
    out += d
    lastProgress = out
  })
  child.stderr.on('data', (d) => {
    err += d
    lastProgress = out
  })

  const ticker = setInterval(() => {
    if (!onProgress || !lastProgress) return
    onProgress({ elapsedMs: Date.now() - started, tail: lastProgress })
  }, 8000)

  const stop = () => {
    clearInterval(ticker)
    if (onProgress && lastProgress) onProgress({ elapsedMs: Date.now() - started, tail: lastProgress, final: true })
  }

  return new Promise((resolve) => {
    const killer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* noop */ }
      stop()
      resolve({ ok: false, timedOut: true, out, err, ms: Date.now() - started, code: null })
    }, timeout)

    child.on('error', (e) => {
      clearTimeout(killer)
      stop()
      resolve({ ok: false, reason: String(e), out, err, ms: Date.now() - started, code: null })
    })

    child.on('close', (code) => {
      clearTimeout(killer)
      stop()
      resolve({ ok: code === 0, code, out, err, ms: Date.now() - started, timedOut: false })
    })
  })
}

export function extractAnswer(run) {
  if (!run.ok && !run.out) {
    return `❌ agent failed (code ${run.code ?? '—'})${run.reason ? `: ${run.reason}` : ''}${run.err ? `\nstderr: ${run.err.slice(-800)}` : ''}`
  }
  if (run.timedOut) return `⏱ session exceeded the limit (${Math.round(run.ms / 60000)} min), result truncated.\n\n${run.out.slice(-1200)}`
  return run.out.slice(-4000)
}

export function statsLine(run) {
  const min = (run.ms / 60000).toFixed(1)
  return `⏱ ${min} min${run.timedOut ? ' (timeout)' : ''}`
}