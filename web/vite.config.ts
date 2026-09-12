/**
 * Vite configuration.
 *
 * The dev server proxies `/api` and the Socket.IO endpoint to the API on :4000
 * so that, in development, the browser sees a **single origin**. That matters
 * for more than convenience: the refresh token lives in an HttpOnly cookie, and
 * a same-origin dev setup exercises the same cookie path the deployed app uses
 * without needing `SameSite=None; Secure` (which would require HTTPS locally).
 *
 * In production the SPA is on Vercel and the API is elsewhere, so the proxy is
 * absent and `VITE_API_URL` points at the real host — see `src/lib/api.ts`.
 */
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  // Only used by the dev proxy; the built bundle never reads this.
  const target = env.VITE_DEV_API_TARGET || 'http://127.0.0.1:4000';

  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': { target, changeOrigin: true },
        // `ws: true` is required — without it the upgrade request is proxied as
        // plain HTTP and the WebSocket handshake fails with a 400.
        '/socket.io': { target, ws: true, changeOrigin: true },
        '/health': { target, changeOrigin: true },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
      rollupOptions: {
        output: {
          // Keeps the vendor chunk cacheable across deploys of app code.
          manualChunks: {
            react: ['react', 'react-dom', 'react-router-dom'],
            socket: ['socket.io-client'],
          },
        },
      },
    },
  };
});
