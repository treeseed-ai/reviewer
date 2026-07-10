import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  root: 'src/ui',
  publicDir: false,
  build: {
    outDir: '../../dist/ui',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@treeseed/reviewer': resolve(__dirname, 'src/index.ts'),
      '@treeseed/reviewer/': `${resolve(__dirname, 'src')}/`,
    },
  },
});
