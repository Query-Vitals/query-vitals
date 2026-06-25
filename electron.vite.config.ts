import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

const alias = {
  '@main': resolve('src/main'),
  '@shared': resolve('src/shared'),
  '@renderer': resolve('src/renderer/src'),
};

export default defineConfig({
  main: { resolve: { alias } },
  preload: { resolve: { alias } },
  renderer: {
    resolve: { alias },
    plugins: [react()],
    root: 'src/renderer',
    // cast to any to satisfy electron-vite / vite type definitions
    build: ({ outDir: 'out/renderer' } as any),
  },
});
