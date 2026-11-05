import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

const alias = {
  '@core': resolve(import.meta.dirname, 'src/core'),
  '@shared': resolve(import.meta.dirname, 'src/shared'),
  '@main': resolve(import.meta.dirname, 'src/main'),
  '@renderer': resolve(import.meta.dirname, 'src/renderer'),
};

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          // `carbon mcp`: the stdio MCP relay, run in node mode (docs/MCP.md).
          mcp: resolve(import.meta.dirname, 'src/main/agent/mcp.ts'),
        },
      },
    },
  },
  preload: {
    resolve: { alias },
    build: {
      outDir: 'out/preload',
      // The preload runs sandboxed, so it must be one self-contained CommonJS file.
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    resolve: { alias },
    plugins: [
      react(),
      {
        // React Refresh injects an inline module script in dev; allow it there only.
        name: 'carbon-dev-csp',
        apply: 'serve',
        transformIndexHtml: (html: string) =>
          html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
      },
    ],
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: { index: resolve(import.meta.dirname, 'src/renderer/index.html') } },
    },
  },
});
