import { defineConfig } from 'vite';
import path from 'path';
import tailwindcss from '@tailwindcss/vite';

/**
 * Library build of the read-only viewer core (`fluidcad/viewer-ui`). Emits a
 * single self-contained ESM module (three.js bundled — a viewing host must
 * not end up with a second three instance) plus one CSS asset with the
 * Tailwind/DaisyUI layers the panels' class names resolve against.
 */
export default defineConfig({
  root: path.resolve(import.meta.dirname),
  plugins: [tailwindcss()],
  define: {
    // Absolute: library hosts may mount the viewer at deep paths, where a
    // relative base would resolve wrongly (see src/icon-url.ts).
    __FLUIDCAD_ICON_BASE__: JSON.stringify('/icons/'),
  },
  build: {
    outDir: 'dist-lib',
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: path.resolve(import.meta.dirname, 'src/viewer-ui.ts'),
      formats: ['es'],
      fileName: () => 'viewer-ui.js',
      cssFileName: 'viewer-ui',
    },
  },
});
