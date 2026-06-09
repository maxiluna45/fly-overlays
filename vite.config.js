import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve, join } from 'path';
import { readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rendererDir = resolve(__dirname, 'src/renderer');

const htmlFiles = readdirSync(rendererDir)
  .filter((f) => f.endsWith('.html'))
  .map((f) => join(rendererDir, f));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: rendererDir,
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: htmlFiles,
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  resolve: {
    alias: {
      '@': rendererDir,
    },
  },
});
