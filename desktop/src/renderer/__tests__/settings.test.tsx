// =============================================================================
// Settings — Sponsor surface + Telemetry opt-in tests (M16 / Cycle-29)
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Settings } from '../settings/Settings';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRokibrain(overrides: Partial<typeof window.rokibrain> = {}): typeof window.rokibrain {
  return {
    ...window.rokibrain,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Sponsor section
// ---------------------------------------------------------------------------

describe('Settings — Sponsor section', () => {
  it('renders the "Support vibeOS" heading', async () => {
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText(/support vibeos/i)).toBeInTheDocument();
    });
  });

  it('renders all 3 sponsor buttons', async () => {
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /open github sponsors/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /open patreon/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /open open collective/i })).toBeInTheDocument();
    });
  });

  it('clicking GitHub Sponsors calls openExternal with correct URL', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    (globalThis.window as any).rokibrain = buildRokibrain({
      app: { ...window.rokibrain.app, openExternal },
    });

    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /open github sponsors/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /open github sponsors/i }));

    await waitFor(() => {
      expect(openExternal).toHaveBeenCalledWith('https://github.com/sponsors/penrokib');
    });
  });

  it('clicking Patreon calls openExternal with correct URL', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    (globalThis.window as any).rokibrain = buildRokibrain({
      app: { ...window.rokibrain.app, openExternal },
    });

    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /open patreon/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /open patreon/i }));

    await waitFor(() => {
      expect(openExternal).toHaveBeenCalledWith('https://patreon.com/penrokib');
    });
  });

  it('clicking Open Collective calls openExternal with correct URL', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    (globalThis.window as any).rokibrain = buildRokibrain({
      app: { ...window.rokibrain.app, openExternal },
    });

    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /open open collective/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /open open collective/i }));

    await waitFor(() => {
      expect(openExternal).toHaveBeenCalledWith('https://opencollective.com/vibeos');
    });
  });
});

// ---------------------------------------------------------------------------
// Telemetry section
// ---------------------------------------------------------------------------

describe('Settings — Telemetry opt-in', () => {
  beforeEach(() => {
    // Reset to default mock (telemetry_enabled = null → false)
    (globalThis.window as any).rokibrain = buildRokibrain();
  });

  it('renders the "Anonymous crash reports" heading', async () => {
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText(/anonymous crash reports/i)).toBeInTheDocument();
    });
  });

  it('toggle switch defaults to OFF when secret is absent', async () => {
    // Default mock returns null for any secret key → telemetry is false.
    render(<Settings />);
    await waitFor(() => {
      const toggle = screen.getByRole('switch', { name: /toggle anonymous crash reports/i });
      expect(toggle).toHaveAttribute('aria-checked', 'false');
    });
  });

  it('toggle switch shows ON when secret is "true"', async () => {
    (globalThis.window as any).rokibrain = buildRokibrain({
      secrets: {
        ...window.rokibrain.secrets,
        get: async (key: string) => (key === 'telemetry_enabled' ? 'true' : null),
      },
    });

    render(<Settings />);
    await waitFor(() => {
      const toggle = screen.getByRole('switch', { name: /toggle anonymous crash reports/i });
      expect(toggle).toHaveAttribute('aria-checked', 'true');
    });
  });

  it('toggling from OFF to ON calls secrets.set', async () => {
    const secretsSet = vi.fn().mockResolvedValue(undefined);
    (globalThis.window as any).rokibrain = buildRokibrain({
      secrets: {
        ...window.rokibrain.secrets,
        get: async (_key: string) => null,
        set: secretsSet,
      },
    });

    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: /toggle anonymous crash reports/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('switch', { name: /toggle anonymous crash reports/i }));

    await waitFor(() => {
      expect(secretsSet).toHaveBeenCalledWith('telemetry_enabled', 'true');
    });
  });

  it('toggling from ON to OFF calls secrets.delete', async () => {
    const secretsDelete = vi.fn().mockResolvedValue(undefined);
    (globalThis.window as any).rokibrain = buildRokibrain({
      secrets: {
        ...window.rokibrain.secrets,
        get: async (key: string) => (key === 'telemetry_enabled' ? 'true' : null),
        delete: secretsDelete,
      },
    });

    render(<Settings />);
    await waitFor(() => {
      const toggle = screen.getByRole('switch', { name: /toggle anonymous crash reports/i });
      expect(toggle).toHaveAttribute('aria-checked', 'true');
    });

    fireEvent.click(screen.getByRole('switch', { name: /toggle anonymous crash reports/i }));

    await waitFor(() => {
      expect(secretsDelete).toHaveBeenCalledWith('telemetry_enabled');
    });
  });

  it('"What we collect" button opens the detail modal', async () => {
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText(/what we collect →/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/what we collect →/i));

    expect(screen.getByRole('dialog', { name: /telemetry details/i })).toBeInTheDocument();
  });

  it('telemetry modal lists collect + never-collect bullets', async () => {
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText(/what we collect →/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/what we collect →/i));

    // Check collect bullets (modal has "Stack trace (file:line)" as its own list item)
    const stackTraceItems = screen.getAllByText(/stack trace/i);
    expect(stackTraceItems.length).toBeGreaterThanOrEqual(1);
    // The modal bullet text is an exact li item
    expect(screen.getByText('Stack trace (file:line)')).toBeInTheDocument();
    expect(screen.getByText('App version')).toBeInTheDocument();
    // Never-collect bullets
    expect(screen.getByText(/ip address \(trimmed before send\)/i)).toBeInTheDocument();
    expect(screen.getByText(/messages or conversation content/i)).toBeInTheDocument();
  });

  it('clicking Close button dismisses the modal', async () => {
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByText(/what we collect →/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/what we collect →/i));

    const dialog = screen.getByRole('dialog', { name: /telemetry details/i });
    expect(dialog).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(screen.queryByRole('dialog', { name: /telemetry details/i })).not.toBeInTheDocument();
  });
});
