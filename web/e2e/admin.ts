import { readFileSync, writeFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { totp } from './totp'

/** Remembers the organizer enrolled by the first spec (the server and its data are shared by all specs). */
export function saveAdmin(name: string, secret: string) {
  writeFileSync(process.env.E2E_ADMIN_FILE!, JSON.stringify({ name, secret }))
}

/** Signs the page's browser context in through the API as the organizer from the first spec. */
export async function loginAsAdmin(page: Page) {
  const { name, secret } = JSON.parse(readFileSync(process.env.E2E_ADMIN_FILE!, 'utf8')) as { name: string; secret: string }
  // The enrollment code used the current step; the next step is accepted (window ±1) and is not a replay.
  const res = await page.request.post('/api/auth/login', { data: { name, code: totp(secret, 1) } })
  if (!res.ok()) throw new Error(`organizer login failed: ${res.status()} ${await res.text()}`)
}
