declare module '*.svg?raw' {
  const content: string;
  export default content;
}

/** Vite compiles a `?worker` import into a Worker constructor. */
declare module '*?worker' {
  const workerConstructor: new (options?: { name?: string }) => Worker;
  export default workerConstructor;
}

/** Monaco reads its worker factory off the global. */
interface Window {
  MonacoEnvironment?: {
    getWorker(workerId: string, label: string): Worker;
  };
}

/** The build-mode flags Vite defines on `import.meta.env`. */
interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Base URL of the icon PNGs, set per build through Vite's `define` (see
 * `icon-url.ts`). Undefined when source runs without a Vite build config.
 */
declare const __FLUIDCAD_ICON_BASE__: string | undefined;
