import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.AIRGB_WEB_PORT ?? 5173),
    strictPort: true,
    fs: { allow: [repoRoot] },
    proxy: { '/api': `http://127.0.0.1:${Number(process.env.AIRGB_API_PORT ?? 8801)}` },
  },
});
