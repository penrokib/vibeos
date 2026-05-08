import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// electron-vite config — main / preload / renderer triad.
// Renderer is React 19 + Tailwind 4. Main + preload are externalized Node bundles.

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      // Multi-entry: main + daemon. Daemon is forked by main via
      // utilityProcess.fork(<__dirname>/daemon.js), so it sits next to index.js
      // in out/main/. (Co-locating keeps dev/prod paths identical.)
      lib: {
        entry: {
          index: resolve(__dirname, 'src/main/index.ts'),
          daemon: resolve(__dirname, 'src/daemon/index.ts'),
          'vibeos-mcp': resolve(__dirname, 'src/daemon/mcp/vibeos-mcp-shim.ts'),
        },
        formats: ['cjs'],
      },
      rollupOptions: {
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
        },
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      lib: {
        entry: resolve(__dirname, 'src/preload/index.ts'),
        formats: ['cjs'],
      },
      rollupOptions: {
        output: { entryFileNames: 'index.js' },
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        // Two renderer entries: main app + voice quickbar overlay.
        // Main: out/renderer/index.html
        // Quickbar: out/renderer/quickbar/index.html
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          quickbar: resolve(__dirname, 'src/renderer/quickbar/index.html'),
        },
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer'),
      },
    },
    server: { port: 5173 },
  },
});
