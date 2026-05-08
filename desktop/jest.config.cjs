/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src/daemon'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  collectCoverage: false,
  collectCoverageFrom: [
    'src/daemon/**/*.ts',
    '!src/daemon/**/*.d.ts',
    '!src/daemon/index.ts',
  ],
  coverageThreshold: {
    'src/daemon/': {
      statements: 70,
      branches: 60,
      functions: 70,
      lines: 70,
    },
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          module: 'commonjs',
          target: 'ES2022',
          esModuleInterop: true,
          isolatedModules: true,
          strict: true,
          skipLibCheck: true,
          types: ['node', 'jest'],
        },
        diagnostics: false,
      },
    ],
  },
};
