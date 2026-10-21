#!/usr/bin/env node
// Reproducible load test: starts the release binary on a fresh data dir, bootstraps the owner through
// first-start, creates an event (30 teams x 6 criteria x 40 judges), starts judging and simulates
//   - 40 judges sending score batches (PUT /api/judge/scores, 1-6 items) every ~1 s,
//   - 200 public viewers polling GET /api/public/events/:id every 2 s (SSE refetch storm),
//   - 1 admin polling matrix + results every 2 s,
// then prints p50/p95/p99 per endpoint, error count and server RSS (before/peak/after).
// Node script (not a Rust example): Node 22+ has global fetch and node:crypto for TOTP, matching
// web/e2e, and the server under test runs as a separate process exactly as in production.
// Env: JUDGEFLOW_BIN (default target/release/judgeflow), LOADTEST_SECONDS (60), LOADTEST_JUDGES (40),
//      LOADTEST_VIEWERS (200).
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const BIN = resolve(process.env.JUDGEFLOW_BIN ?? 'target/release/judgeflow')
const SECONDS = Number(process.env.LOADTEST_SECONDS ?? 60)
const JUDGES = Number(process.env.LOADTEST_JUDGES ?? 40)
const VIEWERS = Number(process.env.LOADTEST_VIEWERS ?? 200)
const TEAMS = 30
const CRITERIA = 6
const P95_TARGET_MS = 150
const RSS_TARGET_MIB = 100

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
function totp(secret, stepOffset = 0) {
  let bits = ''
  for (const ch of secret.replace(/=+$/, '').toUpperCase()) bits += ALPHABET.indexOf(ch).toString(2).padStart(5, '0')
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)))
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + stepOffset))
  const h = createHmac('sha1', key).update(msg).digest()
  const o = h[h.length - 1] & 0xf
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer()
    s.once('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => res(port))
    })
  })
}

const rssMiB = (pid) => Number(/VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) / 1024

const samples = new Map() // endpoint -> latencies in ms
let errors = 0
const errorSamples = []

async function timed(name, url, init) {
  const t0 = performance.now()
  try {
    const res = await fetch(url, init)
    await res.arrayBuffer()
    if (!res.ok) throw new Error(`${res.status}`)
  } catch (e) {
    errors++
    if (errorSamples.length < 5) errorSamples.push(`${name}: ${e.message}`)
  } finally {
    const list = samples.get(name) ?? []
    list.push(performance.now() - t0)
    samples.set(name, list)
  }
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'judgeflow-load-'))
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const child = spawn(BIN, ['serve', '--addr', `127.0.0.1:${port}`, '--data-dir', dataDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (c) => (log += c))
  child.stderr.on('data', (c) => (log += c))
  let exited = false
  child.once('exit', () => (exited = true))
  const stop = () => {
    if (!exited) child.kill('SIGTERM')
    rmSync(dataDir, { recursive: true, force: true })
  }
  process.once('SIGINT', () => (stop(), process.exit(130)))

  try {
    // Wait for the setup password (logged on the line after "enter this setup password").
    let password
    for (let i = 0; i < 300 && !password; i++) {
      if (exited) throw new Error(`server exited early\n${log}`)
      const lines = log.replace(/\u001b\[[0-9;]*m/g, '').split('\n')
      const at = lines.findIndex((l) => l.includes('enter this setup password'))
      if (at >= 0 && lines[at + 1] && log.includes('listening')) password = lines[at + 1].split(/\s+/).pop()
      else await sleep(100)
    }
    if (!password) throw new Error(`timed out waiting for the server\n${log}`)

    const call = async (method, path, { body, cookie, bearer } = {}) => {
      const headers = {}
      if (body !== undefined) headers['content-type'] = 'application/json'
      if (cookie) headers.cookie = cookie
      if (bearer) headers.authorization = `Bearer ${bearer}`
      const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
      if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`)
      return res
    }

    const begin = await (await call('POST', '/api/setup/first-start/begin', { body: { setup_password: password, name: 'loadtest' } })).json()
    const done = await call('POST', '/api/setup/first-start/complete', {
      body: { enrollment_token: begin.enrollment_token, code: totp(begin.secret) },
    })
    const cookie = done.headers.get('set-cookie').split(';')[0]

    const event = (await (await call('POST', '/api/events', { body: { title: 'Load test' }, cookie })).json()).event
    const eid = event.id
    await call('PATCH', `/api/events/${eid}`, { body: { visibility: 'live_full' }, cookie })
    const teams = await (
      await call('POST', `/api/events/${eid}/teams/bulk`, {
        body: { teams: Array.from({ length: TEAMS }, (_, i) => ({ name: `Team ${i + 1}` })) },
        cookie,
      })
    ).json()
    const criteria = await (
      await call('POST', `/api/events/${eid}/criteria/bulk`, {
        body: { criteria: Array.from({ length: CRITERIA }, (_, i) => ({ name: `Criterion ${i + 1}`, max_x100: 1000, step_x100: 100, weight: 1 })) },
        cookie,
      })
    ).json()
    const judges = await (
      await call('POST', `/api/events/${eid}/judges`, {
        body: { names: Array.from({ length: JUDGES }, (_, i) => `Judge ${i + 1}`) },
        cookie,
      })
    ).json()
    await call('POST', `/api/events/${eid}/transition`, { body: { to: 'judging' }, cookie })
    const tokens = judges.map((j) => j.link.split('/').pop())

    const rssBefore = rssMiB(child.pid)
    let rssPeak = rssBefore
    const rssTimer = setInterval(() => (rssPeak = Math.max(rssPeak, rssMiB(child.pid))), 250)

    const deadline = Date.now() + SECONDS * 1000
    const loop = async (everyMs, jitterMs, fn) => {
      await sleep(Math.random() * everyMs) // spread the clients over one period
      while (Date.now() < deadline) {
        const started = Date.now()
        await fn()
        await sleep(Math.max(0, everyMs + (Math.random() * 2 - 1) * jitterMs - (Date.now() - started)))
      }
    }

    const judgeLoop = (token) =>
      loop(1000, 300, () => {
        const count = 1 + Math.floor(Math.random() * 6)
        const items = Array.from({ length: count }, () => ({
          team_id: teams[Math.floor(Math.random() * teams.length)].id,
          criterion_id: criteria[Math.floor(Math.random() * criteria.length)].id,
          value_x100: 100 * Math.floor(Math.random() * 11),
          note: null,
          edited_at: Date.now(),
        }))
        return timed('PUT /api/judge/scores', `${base}/api/judge/scores`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ items }),
        })
      })
    const viewerLoop = () => loop(2000, 0, () => timed('GET /api/public/events/:id', `${base}/api/public/events/${eid}`))
    const adminLoop = () =>
      loop(2000, 0, async () => {
        await timed('GET /api/events/:id/matrix', `${base}/api/events/${eid}/matrix`, { headers: { cookie } })
        await timed('GET /api/events/:id/results', `${base}/api/events/${eid}/results?mode=provisional`, { headers: { cookie } })
      })

    console.log(`load: ${JUDGES} judges, ${VIEWERS} viewers, 1 admin, ${TEAMS} teams x ${CRITERIA} criteria, ${SECONDS}s`)
    await Promise.all([...tokens.map(judgeLoop), ...Array.from({ length: VIEWERS }, viewerLoop), adminLoop()])
    clearInterval(rssTimer)
    const rssAfter = rssMiB(child.pid)
    rssPeak = Math.max(rssPeak, rssAfter)

    const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
    let worstP95 = 0
    console.log('\nendpoint'.padEnd(34) + 'n'.padStart(7) + 'p50'.padStart(9) + 'p95'.padStart(9) + 'p99'.padStart(9) + '  (ms)')
    for (const [name, list] of [...samples].sort()) {
      const s = [...list].sort((a, b) => a - b)
      worstP95 = Math.max(worstP95, pct(s, 95))
      console.log(
        name.padEnd(33) + String(s.length).padStart(7) + [50, 95, 99].map((p) => pct(s, p).toFixed(1).padStart(9)).join(''),
      )
    }
    console.log(`\nerrors: ${errors}${errorSamples.length ? `  (${errorSamples.join('; ')})` : ''}`)
    console.log(`server RSS MiB: before ${rssBefore.toFixed(1)}  peak ${rssPeak.toFixed(1)}  after ${rssAfter.toFixed(1)}`)
    const ok = errors === 0 && worstP95 < P95_TARGET_MS && rssPeak < RSS_TARGET_MIB
    console.log(`targets (p95 < ${P95_TARGET_MS} ms, RSS < ${RSS_TARGET_MIB} MiB, 0 errors): ${ok ? 'MET' : 'MISSED'}`)
    process.exitCode = ok ? 0 : 1
  } finally {
    stop()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
