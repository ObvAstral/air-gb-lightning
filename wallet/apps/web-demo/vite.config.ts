import { fileURLToPath } from 'node:url';
import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const demoPort = Number(process.env.AIRGB_DEMO_PORT ?? 5174);
const defaultApiPort = Number(process.env.AIRGB_API_PORT ?? 8801);
const allowedOrigin = `http://127.0.0.1:${Number(process.env.AIRGB_WEB_PORT ?? 5173)}`;

const nodePorts = [8789, ...Array.from({ length: 20 }, (_, idx) => 8801 + idx)];

const nodeProxyEntries: Record<string, ProxyOptions> = Object.fromEntries(
  nodePorts.map(port => [
    `/nodes/${port}`,
    {
      target: `http://127.0.0.1:${port}`,
      changeOrigin: true,
      rewrite: (path: string) => path.replace(new RegExp(`^/nodes/${port}`), ''),
      headers: {
        Origin: allowedOrigin,
        Host: `127.0.0.1:${port}`,
      },
    },
  ]),
);

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: demoPort,
    strictPort: true,
    fs: { allow: [repoRoot] },
    proxy: {
      ...nodeProxyEntries,
      '/qvac': {
        target: 'http://127.0.0.1:11434',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/qvac/, ''),
      },
      '/api': {
        target: `http://127.0.0.1:${defaultApiPort}`,
        changeOrigin: true,
        headers: {
          Origin: allowedOrigin,
          Host: `127.0.0.1:${defaultApiPort}`,
        },
      },
    },
  },
});
