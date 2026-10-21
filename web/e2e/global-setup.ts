import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g
const STARTUP_TIMEOUT_MS = 30_000

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolvePort(port))
    })
  })
}

/** The setup password is logged on the line after "enter this setup password:". */
function parseSetupPassword(log: string): string | null {
  const lines = log.replace(ANSI, '').split('\n')
  const at = lines.findIndex((l) => l.includes('enter this setup password'))
  const next = at >= 0 ? lines[at + 1] : undefined
  return next ? (next.split(/\s+/).pop() ?? null) : null
}

export default async function globalSetup() {
  const bin = resolve(process.env.JUDGEFLOW_BIN ?? '../target/debug/judgeflow')
  const dataDir = mkdtempSync(join(tmpdir(), 'judgeflow-e2e-'))
  const port = await freePort()
  const baseURL = `http://127.0.0.1:${port}`

  const child: ChildProcess = spawn(bin, ['serve', '--addr', `127.0.0.1:${port}`, '--data-dir', dataDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout?.on('data', (chunk: Buffer) => (log += chunk.toString()))
  child.stderr?.on('data', (chunk: Buffer) => (log += chunk.toString()))
  const spawnError = new Promise<never>((_, reject) => child.once('error', (e) => reject(new Error(`cannot start ${bin}: ${e.message}`))))
  const earlyExit = new Promise<never>((_, reject) =>
    child.once('exit', (code) => reject(new Error(`${bin} exited early (code ${code})\n${log}`))),
  )

  const ready = (async () => {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    while (Date.now() < deadline) {
      const password = parseSetupPassword(log)
      if (password && log.includes('listening')) return password
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`timed out waiting for the server to start\n${log}`)
  })()

  const stop = () => {
    child.removeAllListeners('exit')
    child.kill('SIGTERM')
    rmSync(dataDir, { recursive: true, force: true })
  }

  try {
    process.env.E2E_SETUP_PASSWORD = await Promise.race([ready, spawnError, earlyExit])
  } catch (e) {
    stop()
    throw e
  }
  process.env.E2E_BASE_URL = baseURL
  // Specs share one server; the first spec stores the organizer's TOTP secret here for the next ones.
  process.env.E2E_ADMIN_FILE = join(dataDir, 'e2e-admin.json')
  return stop
}
