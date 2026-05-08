/**
 * E2E config for `yarn workspace @vibeos/bff test:e2e -- mesh`.
 * Runs the supertest-driven specs in apps/bff/test/, separate from the
 * unit specs alongside src/ that the default `test` script picks up.
 */
/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["<rootDir>/test/**/*.e2e-spec.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.json" }],
  },
  testTimeout: 20_000,
};
