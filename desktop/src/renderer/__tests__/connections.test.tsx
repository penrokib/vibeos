// =============================================================================
// Connections Tab — unit tests (cycle 7)
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ConnectionsTab } from '../connections/ConnectionsTab';
import type { ChildStatusSummary, SupervisorStatusPayload } from '../../shared/ipc-contracts';

const emptySnapshot: SupervisorStatusPayload = {
  wsPort: 0,
  uptime: 0,
  emergencyStopped: false,
  children: [],
};

const baseChild: ChildStatusSummary = {
  id: 'wap',
  platform: 'wa',
  state: 'running',
  restartCount: 0,
  recentCrashCount: 0,
  changedAt: new Date().toISOString(),
};

beforeEach(() => {
  // Reset to empty supervisor by default.
  (globalThis.window as any).rokibrain.daemon.getSupervisorStatus = vi.fn(
    async (): Promise<SupervisorStatusPayload> => emptySnapshot,
  );
  (globalThis.window as any).rokibrain.daemon.onSupervisorStatus = vi.fn(() => () => {});
  (globalThis.window as any).rokibrain.daemon.restartChild = vi.fn(async () => {});
});

describe('ConnectionsTab', () => {
  it('shows loading state initially', () => {
    // Keep the promise pending.
    (globalThis.window as any).rokibrain.daemon.getSupervisorStatus = vi.fn(
      (): Promise<SupervisorStatusPayload> => new Promise(() => {}),
    );
    render(<ConnectionsTab />);
    expect(screen.getByText(/loading connections/i)).toBeInTheDocument();
  });

  it('shows empty state when no children returned', async () => {
    render(<ConnectionsTab />);
    await waitFor(() => {
      expect(screen.getByText(/no accounts paired yet/i)).toBeInTheDocument();
    });
  });

  it('renders a child card with status and restart button', async () => {
    (globalThis.window as any).rokibrain.daemon.getSupervisorStatus = vi.fn(
      async (): Promise<SupervisorStatusPayload> => ({
        ...emptySnapshot,
        children: [baseChild],
      }),
    );
    render(<ConnectionsTab />);
    await waitFor(() => {
      expect(screen.getByText('wap')).toBeInTheDocument();
      expect(screen.getByText('WhatsApp')).toBeInTheDocument();
      expect(screen.getByText('connected')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /restart/i })).toBeInTheDocument();
    });
  });

  it('shows error banner when getSupervisorStatus throws', async () => {
    (globalThis.window as any).rokibrain.daemon.getSupervisorStatus = vi.fn(async () => {
      throw new Error('daemon offline');
    });
    render(<ConnectionsTab />);
    await waitFor(() => {
      expect(screen.getByText(/daemon offline/i)).toBeInTheDocument();
    });
  });

  it('opens add-account modal on "+ Add account" click', async () => {
    render(<ConnectionsTab />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /\+ add account/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('WhatsApp')).toBeInTheDocument();
    expect(screen.getByText('Telegram')).toBeInTheDocument();
  });

  it('navigates to stub platform pane and shows coming-soon text', async () => {
    render(<ConnectionsTab />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /\+ add account/i }));
    // Click WhatsApp in the modal list (first element with label).
    const waButtons = screen.getAllByText('WhatsApp');
    fireEvent.click(waButtons[0]);
    expect(screen.getByText(/pair flow coming in a future cycle/i)).toBeInTheDocument();
  });

  it('closes the modal on Cancel', async () => {
    render(<ConnectionsTab />);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /\+ add account/i }));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('calls restartChild with childId when Restart is clicked', async () => {
    (globalThis.window as any).rokibrain.daemon.getSupervisorStatus = vi.fn(
      async (): Promise<SupervisorStatusPayload> => ({
        ...emptySnapshot,
        children: [baseChild],
      }),
    );
    render(<ConnectionsTab />);
    await waitFor(() => expect(screen.getByRole('button', { name: /restart/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /restart/i }));
    await waitFor(() => {
      expect((globalThis.window as any).rokibrain.daemon.restartChild).toHaveBeenCalledWith({
        childId: 'wap',
      });
    });
  });
});
