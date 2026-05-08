// =============================================================================
// Test setup with msw (M07)
// =============================================================================

import '@testing-library/jest-dom';
import { setupServer } from 'msw/node';
import { handlers } from './mocks/handlers';
import { beforeAll, afterEach, afterAll } from 'vitest';

// Setup msw server
export const server = setupServer(...handlers);

// Start server before all tests
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));

// Reset handlers after each test
afterEach(() => server.resetHandlers());

// Clean up after all tests
afterAll(() => server.close());

// Mock window.rokibrain (provided by Electron contextBridge).
// IMPORTANT: assign directly on the existing window object — never replace it with
// a spread plain-object, which loses prototype methods like addEventListener().
(globalThis.window as any).rokibrain = {
  daemon: {
    onStatus: () => () => {},
    getWsPort: async () => ({ port: 0 }),
  },
  tabs: {
    switch: async () => {},
    onSwitch: () => () => {},
  },
  pause: {
    toggle: async () => ({ paused: false }),
    onToggle: () => () => {},
  },
  voice: {
    toggle: async () => ({ listening: false }),
    onToggle: () => () => {},
  },
  app: {
    quit: () => {},
    version: '0.1.0-test',
    platform: 'darwin',
  },
};
