import { defineConfig } from 'vite';
import path from 'path';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  // Relative asset links, so the built page works under any path prefix
  // (a reverse proxy serving it at /p/<name>/) as well as at the root.
  base: './',
  plugins: [tailwindcss()],
  server: {
    port: 3200
  },
  build: {
    outDir: 'dist'
  }
});
