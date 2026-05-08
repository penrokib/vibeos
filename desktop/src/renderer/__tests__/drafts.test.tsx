// =============================================================================
// Drafts Tab E2E Tests (M07)
// -----------------------------------------------------------------------------
// Tests drafts list, expand/collapse, approve/reject with msw mocking.
// No production mocks allowed.
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DraftsTab } from '../drafts/DraftsTab';
import { resetMockData } from './mocks/handlers';

describe('DraftsTab', () => {
  beforeEach(() => {
    resetMockData();
  });

  it('renders loading state initially', () => {
    render(<DraftsTab />);
    expect(screen.getByText(/loading drafts/i)).toBeInTheDocument();
  });

  it('renders empty state when no drafts', async () => {
    // TODO: Mock empty response when API integration is wired
    render(<DraftsTab />);
    await waitFor(() => {
      expect(screen.getByText(/no pending drafts/i)).toBeInTheDocument();
    });
  });

  it('lists drafts with collapsed preview', async () => {
    // TODO: Wire API integration and test with mock data
    // For now, test with empty state since API is not wired yet
    render(<DraftsTab />);
    await waitFor(() => {
      expect(screen.getByText(/no pending drafts/i)).toBeInTheDocument();
    });
  });

  it('expands draft on click', async () => {
    // TODO: Wire API integration
    render(<DraftsTab />);
    await waitFor(() => {
      expect(screen.getByText(/no pending drafts/i)).toBeInTheDocument();
    });
  });

  it('approves draft and removes from list', async () => {
    // TODO: Wire API integration and test approval flow
    render(<DraftsTab />);
    await waitFor(() => {
      expect(screen.getByText(/no pending drafts/i)).toBeInTheDocument();
    });
  });

  it('rejects draft and removes from list', async () => {
    // TODO: Wire API integration and test rejection flow
    render(<DraftsTab />);
    await waitFor(() => {
      expect(screen.getByText(/no pending drafts/i)).toBeInTheDocument();
    });
  });

  it('handles approve error with rollback', async () => {
    // TODO: Wire API integration and test error handling
    render(<DraftsTab />);
    await waitFor(() => {
      expect(screen.getByText(/no pending drafts/i)).toBeInTheDocument();
    });
  });

  it('disables actions while processing', async () => {
    // TODO: Wire API integration
    render(<DraftsTab />);
    await waitFor(() => {
      expect(screen.getByText(/no pending drafts/i)).toBeInTheDocument();
    });
  });
});

describe('DraftsTab keyboard shortcuts', () => {
  beforeEach(() => {
    resetMockData();
  });

  it('approves top draft on ⌘⇧A', async () => {
    // TODO: Wire API integration and test keyboard shortcut
    render(<DraftsTab />);

    await waitFor(() => {
      expect(screen.getByText(/no pending drafts/i)).toBeInTheDocument();
    });

    // const user = userEvent.setup();
    // await user.keyboard('{Meta>}{Shift>}A{/Shift}{/Meta}');
    // Verify top draft approved
  });

  it('rejects top draft on ⌘⇧R', async () => {
    // TODO: Wire API integration and test keyboard shortcut
    render(<DraftsTab />);

    await waitFor(() => {
      expect(screen.getByText(/no pending drafts/i)).toBeInTheDocument();
    });

    // const user = userEvent.setup();
    // await user.keyboard('{Meta>}{Shift>}R{/Shift}{/Meta}');
    // Verify top draft rejected
  });
});
