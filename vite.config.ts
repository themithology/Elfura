import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const backendPort = env.SERVER_PORT || env.PORT || '8787';

  return {
    root: '.',
    plugins: [
      {
        name: 'elfura-embed-spa-routes',
        configureServer(server) {
          server.middlewares.use((req, _res, next) => {
            const url = req.url?.split('?')[0] ?? '';
            if (
              url === '/' ||
              url === '/embed' ||
              /^(?:\/embed)?\/(?:movie|tv)\//.test(url)
            ) {
              const qs = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
              req.url = `/embed.html${qs}`;
            }
            next();
          });
        },
      },
    ],
    server: {
      // Bound to all interfaces so the Arena live preview proxy can reach it.
      host: '0.0.0.0',
      port: 5173,
      strictPort: false,
      // The preview is served from https://{port}-{sandbox}.e2b.app — accept any host.
      allowedHosts: true,
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${backendPort}`,
          changeOrigin: false,
        },
      },
    },
    build: {
      target: 'es2022',
      outDir: 'dist',
      sourcemap: false,
      rollupOptions: {
        // The embed page is the only HTML entry; everything else is library code.
        input: 'embed.html',
      },
    },
  };
});
