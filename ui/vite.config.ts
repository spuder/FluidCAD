import { defineConfig } from 'vite';
import path from 'path';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  // Relative asset links, so the built page works under any path prefix
  // (a reverse proxy serving it at /p/<name>/) as well as at the root.
  base: './',
  plugins: [tailwindcss()],
  define: {
    // Relative, so the app works behind a path prefix (see src/icon-url.ts).
    __FLUIDCAD_ICON_BASE__: JSON.stringify('icons/'),
  },
  server: {
    port: 3200
  },
  build: {
    outDir: 'dist'
  }
});
