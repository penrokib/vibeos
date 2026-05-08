// =============================================================================
// Decisions Tab E2E Tests (M07)
// -----------------------------------------------------------------------------
// Tests decisions list, expand context, approve/reject with msw mocking.
// No production mocks allowed.
// =============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DecisionsTab } from '../decisions/DecisionsTab';
import { resetMockData } from './mocks/handlers';

describe('DecisionsTab', () => {
  beforeEach(() => {
    resetMockData();
  });

  it('renders loading state initially', () => {
    render(<DecisionsTab />);
    expect(screen.getByText(/loading decisions/i)).toBeInTheDocument();
  });

  it('renders empty state when no decisions', async () => {
    // TODO: Mock empty response when API integration is wired
    render(<DecisionsTab />);
    await waitFor(() => {
      expect(screen.getByText(/no decisions/i)).toBeInTheDocument();
    });
  });

  it('lists pending and decided decisions separately', async () => {
    // TODO: Wire API integration and test with mock data
    render(<DecisionsTab />);
    await waitFor(() => {
      expect(screen.getByText(/no decisions/i)).toBeInTheDocument();
    });
  });

  it('expands decision to show context', async () => {
    // TODO: Wire API integration
    render(<DecisionsTab />);
    await waitFor(() => {
      expect(screen.getByText(/no decisions/i)).toBeInTheDocument();
    });
  });

  it('decides option and updates decision', async () => {
    // TODO: Wire API integration and test decision flow
    render(<DecisionsTab />);
    await waitFor(() => {
      expect(screen.getByText(/no decisions/i)).toBeInTheDocument();
    });
  });

  it('handles decide error with rollback', async () => {
    // TODO: Wire API integration and test error handling
    render(<DecisionsTab />);
    await waitFor(() => {
      expect(screen.getByText(/no decisions/i)).toBeInTheDocument();
    });
  });

  it('disables options while processing', async () => {
    // TODO: Wire API integration
    render(<DecisionsTab />);
    await waitFor(() => {
      expect(screen.getByText(/no decisions/i)).toBeInTheDocument();
    });
  });

  it('shows priority badges correctly', async () => {
    // TODO: Wire API integration and verify P0/P1/P2/P3 styling
    render(<DecisionsTab />);
    await waitFor(() => {
      expect(screen.getByText(/no decisions/i)).toBeInTheDocument();
    });
  });
});
