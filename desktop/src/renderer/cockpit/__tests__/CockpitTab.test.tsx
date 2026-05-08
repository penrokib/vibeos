// =============================================================================
// CockpitTab unit tests (M06a)
// -----------------------------------------------------------------------------
// Mounts CockpitTab with mocked window.rokibrain.cockpit.* and asserts:
//   1. Header text renders
//   2. The echo placeholder pane row renders in the rail
//   3. The "+ New pane" button is disabled with the correct tooltip
//
// xterm.js is mocked — DOM in happy-dom cannot drive a real canvas terminal.
// IPC is mocked via window.rokibrain (set up in __tests__/setup.ts + overridden here).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { CockpitTab } from '../CockpitTab';

// ---------------------------------------------------------------------------
// Mock xterm + xterm-addon-fit — no canvas in happy-dom
// vi.mock factories must not reference top-level vi.fn() — use plain fns.
// ---------------------------------------------------------------------------
vi.mock('xterm', () => ({
  Terminal: class MockTerminal {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    writeln() {}
    write() {}
    onData() {}
    dispose() {}
  },
}));

vi.mock('xterm-addon-fit', () => ({
  FitAddon: class MockFitAddon {
    fit() {}
  },
}));

// ---------------------------------------------------------------------------
// Mock window.rokibrain.cockpit.* (supplements the global mock in setup.ts)
// ---------------------------------------------------------------------------
const mockListPanes = vi.fn().mockResolvedValue({
  panes: [
    {
      id: 'echo',
      label: 'Echo (placeholder — bridge-mac coming in cycle 9)',
    },
  ],
});
const mockOpenPane = vi.fn().mockResolvedValue({ success: true });
const mockInput = vi.fn().mockResolvedValue(undefined);
const mockClosePane = vi.fn().mockResolvedValue(undefined);
const mockOnOutput = vi.fn().mockReturnValue(() => {});

beforeEach(() => {
  vi.clearAllMocks();

  // Restore window event listener methods if setup.ts stripped them.
  // (The global mock in setup.ts spreads window but happy-dom may not preserve these.)
  if (typeof (globalThis.window as Window & typeof globalThis).addEventListener !== 'function') {
    (globalThis.window as Window & typeof globalThis).addEventListener = vi.fn();
    (globalThis.window as Window & typeof globalThis).removeEventListener = vi.fn();
  }

  // Attach cockpit API to the global window.rokibrain mock.
  (globalThis.window as typeof window).rokibrain = {
    ...(globalThis.window as typeof window).rokibrain,
    cockpit: {
      listPanes: mockListPanes,
      openPane: mockOpenPane,
      input: mockInput,
      closePane: mockClosePane,
      onOutput: mockOnOutput,
    },
  };
});

describe('CockpitTab', () => {
  it('renders the cockpit header', async () => {
    render(<CockpitTab />);
    expect(screen.getByText('Cockpit (terminal mirror)')).toBeInTheDocument();
  });

  it('renders the echo placeholder pane in the left rail', async () => {
    await act(async () => {
      render(<CockpitTab />);
    });
    expect(
      screen.getByText('Echo (placeholder — bridge-mac coming in cycle 9)'),
    ).toBeInTheDocument();
  });

  it('renders "+ New pane" button as disabled', () => {
    render(<CockpitTab />);
    const btn = screen.getByRole('button', { name: /\+ New pane/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'available after cycle 9');
  });

  it('calls listPanes on mount', async () => {
    await act(async () => {
      render(<CockpitTab />);
    });
    expect(mockListPanes).toHaveBeenCalledOnce();
  });

  it('subscribes to cockpit output on mount', () => {
    render(<CockpitTab />);
    expect(mockOnOutput).toHaveBeenCalled();
  });

  it('renders cycle 9 deferral note in the subtitle', () => {
    render(<CockpitTab />);
    expect(screen.getByText(/bridge-mac PTY wires in cycle 9/i)).toBeInTheDocument();
  });
});
