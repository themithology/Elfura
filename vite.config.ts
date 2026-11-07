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
            const qs = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
            if (url === '/' || url === '/docs' || url === '/demo' || url === '/status') {
              req.url = `/landing.html${qs}`;
            } else if (url === '/dl' || url.startsWith('/dl/')) {
              req.url = `/download.html${qs}`;
            } else if (url === '/embed' || /^(?:\/embed)?\/(?:movie|tv)\//.test(url)) {
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
        '/dl/api': { target: `http://127.0.0.1:${backendPort}`, changeOrigin: false },
        '/dl/go': { target: `http://127.0.0.1:${backendPort}`, changeOrigin: false },
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
        // Public landing site + the isolated embeddable player document.
        input: {
          landing: 'landing.html',
          embed: 'embed.html',
          download: 'download.html',
        },
      },
    },
  };
});
