import { defineConfig } from 'vite';
import { buildHash } from './tools/lib/buildHash.mjs';

export default defineConfig({
  base: './',
  server: {
    port: 5180,
  },
  preview: {
    port: 4180,
  },
  define: {
    __BUILD_HASH__: JSON.stringify(buildHash(import.meta.dirname)),
  },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three/')) return 'three';
          if (id.includes('node_modules/firebase/') || id.includes('node_modules/@firebase/')) {
            return 'firebase';
          }
          return undefined;
        },
      },
    },
  },
});
