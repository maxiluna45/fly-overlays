import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve, join } from 'path';
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rendererDir = resolve(__dirname, 'src/renderer');
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));

const htmlFiles = readdirSync(rendererDir)
  .filter((f) => f.endsWith('.html'))
  .map((f) => join(rendererDir, f));

// Copia los assets de `public/` a `dist/` para que `base: './'` los sirva relativo.
const publicDir = resolve(__dirname, 'public');

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: rendererDir,
  base: './',
  define: {
    APP_VERSION: JSON.stringify(pkg.version),
  },
  publicDir: resolve(rendererDir, 'public'),
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
