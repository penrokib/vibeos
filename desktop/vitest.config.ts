// =============================================================================
// Vitest config for desktop app (M07)
// =============================================================================

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['./src/renderer/__tests__/setup.ts'],
  },
});
