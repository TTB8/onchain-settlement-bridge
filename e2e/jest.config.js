/**
 * The end-to-end suite and the unit tests of the local scripts (`../scripts`). Run in band: the
 * e2e files each spawn an anvil and deploy with `forge script`, which writes one fixed pending
 * record in contracts/deployments, so two files must never deploy at the same time.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  // The workspace packages and both apps are consumed from source (nothing is built).
  moduleNameMapper: {
    '^@bridge/engine/env$': '<rootDir>/../packages/engine/src/env',
    '^@bridge/(domain|db|chain|engine)$': '<rootDir>/../packages/$1/src',
  },
  // Each e2e file creates a database, starts anvil and deploys with forge: minutes, not seconds.
  testTimeout: 180000,
};
