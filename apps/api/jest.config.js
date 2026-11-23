/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  // The workspace packages are consumed from source (none of them is built in dev or CI).
  moduleNameMapper: {
    '^@bridge/engine/env$': '<rootDir>/../../packages/engine/src/env',
    '^@bridge/(domain|db|chain|engine)$': '<rootDir>/../../packages/$1/src',
  },
  // HTTP tests create and drop their own Postgres database per file; give migrations time.
  testTimeout: 60000,
  coverageReporters: ['text', 'json-summary'],
  // main.ts only reads process.env and calls the bootstrap that the tests exercise directly.
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts'],
  coverageThreshold: { global: { branches: 85, functions: 95, lines: 90, statements: 90 } },
};
