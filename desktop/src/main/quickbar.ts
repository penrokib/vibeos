// =============================================================================
// rokibrain.app — quickbar BrowserWindow (M11)
// -----------------------------------------------------------------------------
// Manages the voice quickbar overlay window. Lazy-created on first ⌥-Space;
// hidden (not destroyed) on blur / Escape / post-transcript.
//
// Security hardwalls (identical to main window):
//   - contextIsolation: true
//   - nodeIntegration: false
//   - sandbox: true
//   - webSecurity: true
//
// Window characteristics:
//   - 600 × 120 px, centered on primary display
//   - Always-on-top, frameless, transparent background
//   - Loads quickbar.html (separate renderer entry from electron-vite)
//   - Re-shown on next ⌥-Space (never destroyed after first creation)
// =============================================================================

import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';

let quickbarWindow: BrowserWindow | null = null;

/**
 * Create the quickbar window (lazy — only called once).
 * Subsequent calls return the existing (possibly hidden) instance.
 */
function createQuickbarWindow(): BrowserWindow {
  const { workAreaSize, bounds } = screen.getPrimaryDisplay();
  const width = 600;
  const height = 120;
  const x = Math.round(bounds.x + (workAreaSize.width - width) / 2);
  const y = Math.round(bounds.y + workAreaSize.height * 0.25);

  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    // In dev mode, load the quickbar entry on a dedicated path.
    void win.loadURL(`${devUrl}/quickbar/index.html`);
  } else {
    void win.loadFile(join(__dirname, '../renderer/quickbar/index.html'));
  }

  // Hide (not close) on blur so re-show is instant.
  win.on('blur', () => {
    win.hide();
  });

  win.on('closed', () => {
    quickbarWindow = null;
  });

  return win;
}

/**
 * Toggle quickbar visibility — creates on first call, then show/hide.
 * Called from the global ⌥-Space hotkey handler in main/index.ts.
 */
export function toggleQuickbar(): void {
  if (!quickbarWindow) {
    quickbarWindow = createQuickbarWindow();
  }

  if (quickbarWindow.isVisible()) {
    quickbarWindow.hide();
  } else {
    // Re-center in case display geometry changed.
    const { workAreaSize, bounds } = screen.getPrimaryDisplay();
    const [w] = quickbarWindow.getSize();
    const x = Math.round(bounds.x + (workAreaSize.width - w) / 2);
    const y = Math.round(bounds.y + workAreaSize.height * 0.25);
    quickbarWindow.setPosition(x, y);
    quickbarWindow.show();
    quickbarWindow.focus();
  }
}

/**
 * Hide the quickbar (called after transcript is complete or Escape pressed).
 * No-op if not yet created or already hidden.
 */
export function hideQuickbar(): void {
  quickbarWindow?.hide();
}

/**
 * Returns the current quickbar window instance (or null if not yet created).
 * Exposed for IPC routing in main/index.ts.
 */
export function getQuickbarWindow(): BrowserWindow | null {
  return quickbarWindow;
}
