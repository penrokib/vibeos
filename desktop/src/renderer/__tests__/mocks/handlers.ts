// =============================================================================
// MSW mock handlers for BFF API (M07)
// -----------------------------------------------------------------------------
// Mock REST API responses for e2e testing. No production mocks allowed.
// =============================================================================

import { http, HttpResponse } from 'msw';
import type { Decision, Draft } from '../../../shared/api-client';

const BFF_BASE_URL = 'https://app.rokibrain.com';

// Mock draft data
const mockDrafts: Draft[] = [
  {
    id: 'drf_01HX001',
    account_id: 'acc_whatsapp_001',
    contact_external_id: '+60123456789',
    body: 'Hi! I wanted to follow up on our previous conversation about the Saarland project.',
    persona_slug: 'ceo',
    created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 min ago
    approved_at: null,
    rejected_at: null,
    refused_reasons: null,
    similarity_score: 0.12,
  },
  {
    id: 'drf_01HX002',
    account_id: 'acc_whatsapp_001',
    contact_external_id: '+6567890123',
    body: 'Can we schedule a call this week to discuss the timeline?',
    persona_slug: 'cto',
    created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
    approved_at: null,
    rejected_at: null,
    refused_reasons: null,
    similarity_score: 0.68,
  },
];

// Mock decision data
const mockDecisions: Decision[] = [
  {
    id: 'dec_001',
    title: 'Approve Saarland T-12h launch',
    persona: 'ahn-cto',
    priority: 'P0',
    options: ['approve', 'reject', 'defer'],
    context: 'Team ready, all tests passing. Deployment window opens in 12h.',
    created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago
    decided_at: null,
    decided_option: null,
  },
  {
    id: 'dec_002',
    title: 'Review desktop app PR #47',
    persona: 'foundation',
    priority: 'P1',
    options: ['approve', 'request-changes', 'defer'],
    created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(), // 3h ago
    decided_at: null,
    decided_option: null,
  },
];

let drafts = [...mockDrafts];
let decisions = [...mockDecisions];

export const handlers = [
  // List pending drafts
  http.get(`${BFF_BASE_URL}/agency/drafts/pending`, () => {
    return HttpResponse.json(drafts);
  }),

  // Approve draft
  http.post(`${BFF_BASE_URL}/agency/drafts/:id/approve`, ({ params }) => {
    const { id } = params;
    drafts = drafts.filter((d) => d.id !== id);
    return HttpResponse.json({ success: true });
  }),

  // Reject draft
  http.post(`${BFF_BASE_URL}/agency/drafts/:id/reject`, ({ params }) => {
    const { id } = params;
    drafts = drafts.filter((d) => d.id !== id);
    return HttpResponse.json({ success: true });
  }),

  // List decisions
  http.get(`${BFF_BASE_URL}/decisions`, () => {
    return HttpResponse.json(decisions);
  }),

  // Update decision
  http.patch(`${BFF_BASE_URL}/decisions/:id`, async ({ params, request }) => {
    const { id } = params;
    const body = (await request.json()) as { decided_option: string };
    decisions = decisions.map((d) =>
      d.id === id
        ? {
            ...d,
            decided_at: new Date().toISOString(),
            decided_option: body.decided_option,
          }
        : d,
    );
    return HttpResponse.json({ success: true });
  }),
];

// Reset function for tests
export function resetMockData() {
  drafts = [...mockDrafts];
  decisions = [...mockDecisions];
}
