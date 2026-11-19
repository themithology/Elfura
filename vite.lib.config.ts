import { defineConfig } from 'vite';

/** Library build: one ES bundle + css, for npm/CDN consumption. */
export default defineConfig({
  build: {
    outDir: 'dist/lib',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    lib: {
      entry: 'src/index.ts',
      name: 'Elfura',
      formats: ['es'],
      fileName: () => 'elfura.js',
    },
    rollupOptions: {
      // Keep the engine adapters external so hosts can dedupe hls.js/dash.js.
      external: ['hls.js', 'dashjs'],
    },
  },
});
