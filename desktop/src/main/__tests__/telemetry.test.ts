// =============================================================================
// Telemetry — PII scrubbing unit tests (M16 / Cycle-29)
// =============================================================================
// Tests scrubbedText() and scrubError() independently of Electron runtime.
// The telemetry module imports `electron` (for app.getVersion / app.getLocale)
// — we mock it below so jest doesn't need a live Electron instance.
// =============================================================================

// Mock the 'electron' module — jest runs in Node, not Electron.
jest.mock('electron', () => ({
  app: {
    getVersion: () => '0.1.0-test',
    getLocale: () => 'en-US',
  },
}));

import { scrubbedText, scrubError } from '../telemetry';

// ---------------------------------------------------------------------------
// scrubbedText — individual pattern tests
// ---------------------------------------------------------------------------

describe('scrubbedText — email addresses', () => {
  it('redacts a plain email', () => {
    const result = scrubbedText('Error from roki@example.com during load');
    expect(result).not.toContain('roki@example.com');
    expect(result).toContain('[email-redacted]');
  });

  it('redacts multiple emails', () => {
    const result = scrubbedText('a@b.com and c@d.org');
    expect(result).not.toContain('a@b.com');
    expect(result).not.toContain('c@d.org');
  });

  it('leaves non-email content intact', () => {
    const result = scrubbedText('TypeError: Cannot read property length of undefined');
    expect(result).toBe('TypeError: Cannot read property length of undefined');
  });
});

describe('scrubbedText — phone numbers', () => {
  it('redacts international phone with +62 prefix', () => {
    const result = scrubbedText('contact +62123456789 failed');
    expect(result).not.toContain('+62123456789');
    expect(result).toContain('[phone-redacted]');
  });

  it('redacts phone with 00 prefix', () => {
    const result = scrubbedText('number 0049151234567890 was used');
    expect(result).not.toContain('0049151234567890');
    expect(result).toContain('[phone-redacted]');
  });
});

describe('scrubbedText — JWT tokens', () => {
  const fakeJwt =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
    'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IlJva2kiLCJpYXQiOjE1MTYyMzkwMjJ9.' +
    'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

  it('redacts a standard JWT', () => {
    const result = scrubbedText(`Bearer ${fakeJwt} was leaked`);
    expect(result).not.toContain(fakeJwt);
    expect(result).toContain('[jwt-redacted]');
  });

  it('redacts JWT before attempting email match (JWT contains dots)', () => {
    const result = scrubbedText(fakeJwt);
    // Must not leave partial JWT segments behind
    expect(result).not.toMatch(/eyJ[A-Za-z0-9_-]+/);
  });
});

describe('scrubbedText — combined PII', () => {
  it('scrubs all PII types in one string', () => {
    const fakeJwt =
      'eyJhbGciOiJIUzI1NiJ9.' +
      'eyJzdWIiOiIxMjMifQ.' +
      'SflKxwRJSMeKKF2QT4fwpMeJf36P';
    const input = `User roki@example.com with phone +62123456789 token ${fakeJwt} crashed`;
    const result = scrubbedText(input);
    expect(result).not.toContain('roki@example.com');
    expect(result).not.toContain('+62123456789');
    expect(result).not.toContain(fakeJwt);
    expect(result).toContain('[email-redacted]');
    expect(result).toContain('[phone-redacted]');
    expect(result).toContain('[jwt-redacted]');
  });
});

// ---------------------------------------------------------------------------
// scrubError — error object handling
// ---------------------------------------------------------------------------

describe('scrubError', () => {
  it('returns expected shape for an Error', () => {
    const err = new Error('roki@example.com caused a crash');
    const result = scrubError(err);
    expect(result.errorClass).toBe('Error');
    expect(result.message).not.toContain('roki@example.com');
    expect(result.message).toContain('[email-redacted]');
    expect(result.appVersion).toBe('0.1.0-test');
    expect(result.osName).toBeTruthy();
    expect(result.osVersion).toBeTruthy();
    expect(result.locale).toBe('en-US');
  });

  it('scrubs PII in the stack trace', () => {
    const err = new Error('oops +62123456789');
    // Manually inject PII into stack
    if (err.stack) {
      err.stack = err.stack + '\n    contact +62123456789 at index.ts:42';
    }
    const result = scrubError(err);
    expect(result.stack).not.toContain('+62123456789');
    expect(result.stack).toContain('[phone-redacted]');
  });

  it('handles non-Error thrown values gracefully', () => {
    const result = scrubError('plain string error');
    expect(result.errorClass).toBe('UnknownError');
    expect(result.message).toBe('plain string error');
    expect(result.stack).toBe('');
  });

  it('handles null gracefully', () => {
    const result = scrubError(null);
    expect(result.errorClass).toBe('UnknownError');
    expect(result.message).toBe('null');
  });
});
