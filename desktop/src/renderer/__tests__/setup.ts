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
    // M02 supervisor methods
    getSupervisorStatus: async () => ({
      wsPort: 0,
      uptime: 0,
      emergencyStopped: false,
      children: [],
    }),
    onSupervisorStatus: () => () => {},
    restartChild: async () => {},
    emergencyStop: async () => {},
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
  cockpit: {
    listPanes: async () => ({ panes: [] }),
    openPane: async () => ({ success: true }),
    input: async () => {},
    closePane: async () => {},
    onOutput: () => () => {},
  },
  secrets: {
    get: async (_key: string) => null,
    set: async (_key: string, _value: string) => {},
    delete: async (_key: string) => {},
    list: async () => [],
  },
  auth: {
    status: async () => ({
      state: 'unenrolled',
      endpoint: 'https://app.rokibrain.com',
    }),
    enroll: async () => {},
    logout: async () => {},
    onStatusChange: () => () => {},
  },
  bugs: {
    capture: async () => ({ dataUrl: '' }),
    submit: async () => ({ success: true }),
    list: async () => ({ bugs: [], total: 0 }),
  },
  mesh: {
    accounts: async () => ({ accounts: [] }),
    chats: async () => ({ chats: [] }),
    messages: async () => ({ messages: [] }),
  },
  prs: {
    list: async () => ({ prs: [] }),
    merge: async () => ({ success: false, message: 'stub' }),
    openShell: async () => {},
  },
  app: {
    quit: () => {},
    version: '0.1.0-test',
    platform: 'darwin',
    openExternal: async (_url: string) => {},
  },
};
