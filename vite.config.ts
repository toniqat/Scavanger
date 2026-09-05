import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    open: false,
    // Dev relay: the browser talks to same-origin /ws and Vite forwards it to the Node relay (npm run server).
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true, changeOrigin: true },
    },
  },
});
