const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    headless: true
  },
  // Sem webServer — Maestro sobe o servidor antes dos testes E2E
});
