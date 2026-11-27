import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  use: { baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:4173', viewport: { width: 1440, height: 900 } },
});
