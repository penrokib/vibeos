// =============================================================================
// rokibrain.app — screenshot capture (M10)
// -----------------------------------------------------------------------------
// Captures the primary display via desktopCapturer with graceful permission
// handling. NEVER auto-captures — only on explicit ⌘⇧S or renderer request.
// =============================================================================

import { desktopCapturer } from 'electron';
import type { CaptureScreenshotPayload } from '../shared/ipc-contracts';

/**
 * Captures the entire primary display as a PNG data URL.
 * Throws if desktopCapturer permission is denied or capture fails.
 */
export async function captureScreenshot(): Promise<CaptureScreenshotPayload> {
  try {
    // Request the primary display source. Per Electron docs, desktopCapturer
    // requires screen-recording permission on macOS. If denied, this throws.
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
    });

    if (sources.length === 0) {
      throw new Error('No screen sources available (permission denied or no display found).');
    }

    // Pick the primary display (id usually "screen:0:0").
    const primary = sources.find((s) => s.id.includes(':0:0')) ?? sources[0];
    if (!primary) {
      throw new Error('Primary display not found.');
    }

    const thumbnail = primary.thumbnail;
    const dataUrl = thumbnail.toDataURL();

    if (!dataUrl || dataUrl.length === 0) {
      throw new Error('Screenshot capture returned empty data URL.');
    }

    return { dataUrl };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[screenshot] capture failed:', msg);
    throw new Error(`Screenshot capture failed: ${msg}`);
  }
}
