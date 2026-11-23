/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  // Each test file creates and drops its own Postgres database; give migrations time to apply.
  testTimeout: 60000,
  coverageReporters: ['text', 'json-summary'],
  // seed-cli.ts is a two-line process wrapper around ensureFiatClearingAccount (which is tested).
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts', '!src/seed-cli.ts'],
  coverageThreshold: { global: { branches: 85, functions: 95, lines: 90, statements: 90 } },
};
