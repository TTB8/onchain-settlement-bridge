/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  // The workspace packages are consumed from source (none of them is built in dev or CI).
  moduleNameMapper: { '^@bridge/(domain|db|chain)$': '<rootDir>/../$1/src' },
  // Each test file creates and drops its own Postgres database; give migrations time to apply.
  testTimeout: 60000,
  coverageReporters: ['text', 'json-summary'],
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts'],
  coverageThreshold: { global: { branches: 85, functions: 95, lines: 90, statements: 90 } },
};
