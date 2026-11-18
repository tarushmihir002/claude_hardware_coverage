import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: Vite serves the UI on 5173 and proxies /api to the Node backend on 8787.
// Prod (`npm start`): Vite builds to dist/ and the backend serves both.
const API_PORT = process.env.PORT || 8787;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: `http://localhost:${API_PORT}`, changeOrigin: true, ws: false },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
