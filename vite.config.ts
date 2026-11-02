import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  server: {
    // Bound to all interfaces so the Arena live preview proxy can reach it.
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    // The preview is served from https://{port}-{sandbox}.e2b.app — accept any host.
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      // The embed page is the only HTML entry; everything else is library code.
      input: 'embed.html',
    },
  },
});
