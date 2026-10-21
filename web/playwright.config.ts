// End-to-end tests against the real JudgeFlow binary (API + embedded frontend).
//
// Prerequisites (run once, and again after changing the code):
//   1. cd web && npm run build       (the debug binary embeds web/dist from disk)
//   2. cargo build                   (at the repository root -> target/debug/judgeflow)
//      or point JUDGEFLOW_BIN at another prebuilt binary.
// Then: npm run e2e
//
// global-setup.ts starts the binary on a free port with a fresh temporary data directory
// and stops it afterwards, so every run starts at /firststart.
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'ru-RU',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
