// =============================================================================
// which-helper.ts — thin wrapper around `which` shell command
// -----------------------------------------------------------------------------
// Resolves a binary name to its absolute path, or returns null if not found.
// Used by VoiceChild to probe for whisper-cpp without writing to disk.
//
// The helper is kept in a separate file so tests can inject a mock `whichImpl`
// into VoiceChild without touching child_process.exec globally.
// =============================================================================

import { exec } from 'node:child_process';

/**
 * Resolve `cmd` to its absolute path on $PATH.
 * Returns null if the binary is not found or the check fails.
 *
 * If `cmd` is already an absolute path, return it directly without probing.
 */
export async function which(cmd: string): Promise<string | null> {
  // Absolute paths don't need probing.
  if (cmd.startsWith('/')) {
    return cmd;
  }

  return new Promise<string | null>((resolve) => {
    exec(`which ${shellEscape(cmd)}`, { timeout: 5_000 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const path = stdout.trim();
      resolve(path.length > 0 ? path : null);
    });
  });
}

/** Minimal shell escape — only allows alphanumeric + hyphen + underscore. */
function shellEscape(s: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) {
    throw new Error(`which: unsafe binary name: ${s}`);
  }
  return s;
}
