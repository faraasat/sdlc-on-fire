import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The board's build (P3-UI-01).
 *
 * Output goes to `dist/` and is served by the daemon in production, from the
 * same origin and the same port as the API and the WebSocket. That is not a
 * packaging convenience: same-origin means the loopback guard covers the whole
 * surface, and there is no second place where a CORS rule could be relaxed.
 *
 * In development Vite serves on its own port and proxies `/api` and `/ws` to
 * the daemon, so the app's own code never learns two base URLs — the one it
 * would then get wrong in production.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Vite's own DNS-rebinding guard. The daemon has its own (server/guard.ts);
    // this closes the same hole on the dev server, which is a real target too.
    strictPort: false,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4600', changeOrigin: false },
      '/ws': { target: 'ws://127.0.0.1:4600', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
