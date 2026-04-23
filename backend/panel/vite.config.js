import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * Panel Vite config (plan §2.1 / final deferred item).
 *
 * The panel is a vanilla (no framework) ES-module single-page app.
 * Vite's default multi-page handling works because index.html already
 * uses `<script type="module" src="./src/...">` imports.
 *
 * Dev: `npm run dev` (port 5174) proxies WebSocket + HTTP to the
 * backend on :8080 so the live panel talks to a real engine.
 * Prod: `npm run build` emits to ./dist/, which the backend serves
 * via express.static in preference to the source tree.
 */
export default defineConfig({
  root: __dirname,
  base: './',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: { index: resolve(__dirname, 'index.html') },
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/healthz': 'http://localhost:8080',
      '/api': 'http://localhost:8080',
      '^/(?!src/|@vite/|@id/|node_modules/|@fs/).*\\.(png|ico|webmanifest|svg)$':
        'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true, rewrite: (p) => p.replace(/^\/ws/, '') },
    },
  },
});
