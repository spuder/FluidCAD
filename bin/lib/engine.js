import { fork } from 'child_process';
import { existsSync } from 'fs';
import { resolve, dirname, isAbsolute, join } from 'path';
import { fileURLToPath } from 'url';
import { createFileWatcher, findFluidFiles, isFluidScriptFile } from '../watcher.js';
import { readWorkspaceEditorState } from '../../server/dist/routes/workspace-state.js';

/**
 * Starting one engine (`server/dist/index.js`) for one workspace — shared by
 * `fluidcad serve` and `fluidcad hub`.
 *
 * Readiness comes from the engine's IPC handshake (`ready`, then
 * `init-complete`), never from its log text, the same way the desktop app
 * starts engines (`shell/src/engine/process.ts`).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
export const serverEntry = resolve(__dirname, '..', '..', 'server', 'dist', 'index.js');

/**
 * The model to render first. A workspace that has been opened before names it
 * — reopening should land on what the user was last looking at, not on
 * whatever sorts first — and a fresh one falls back to the first model
 * (part or assembly) at the top level. The page restores the rest of the tab
 * strip itself.
 */
export function pickOpeningFile(workspacePath) {
  const { activeTab } = readWorkspaceEditorState(workspacePath);
  if (activeTab) {
    const absPath = isAbsolute(activeTab) ? activeTab : join(workspacePath, activeTab);
    if (existsSync(absPath) && isFluidScriptFile(absPath)) {
      return absPath;
    }
  }
  return findFluidFiles(workspacePath)[0] ?? null;
}

/** An engine that failed to come up. `reason` is 'init-failed', 'exited', 'timeout' or 'error'. */
export class EngineStartError extends Error {
  constructor(message, reason, exitCode = null) {
    super(message);
    this.name = 'EngineStartError';
    this.reason = reason;
    this.exitCode = exitCode;
  }
}

/** SIGTERM, then SIGKILL if it hasn't gone after `graceMs`. */
export function killEngine(child, graceMs = 3_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }, graceMs);
  timer.unref?.();
}

/**
 * Fork an engine on `port` for `workspacePath` and wait for its handshake.
 * Once `init-complete` reports success, starts the file watcher and asks the
 * engine to render the opening model.
 *
 * Rejects with an `EngineStartError` when initialization fails, the engine
 * exits first, or `timeoutMs` (0 = no limit) passes; the child is reaped in
 * the first and last cases.
 *
 * @param {object} opts
 * @param {string} opts.workspacePath absolute workspace path
 * @param {number} opts.port the port the engine listens on (already known free)
 * @param {NodeJS.ProcessEnv} [opts.env] base environment (default: process.env)
 * @param {number} [opts.timeoutMs] startup limit, 0 for none
 * @param {(child: import('child_process').ChildProcess) => void} [opts.onSpawn] called right after fork
 * @param {(data: Buffer) => void} [opts.onStdout]
 * @param {(data: Buffer) => void} [opts.onStderr]
 * @param {(url: string) => void} [opts.onReady] the engine is listening (initialization still running)
 * @param {() => void} [opts.onInitialized] initialization succeeded, before the watcher starts
 * @returns {Promise<{ child: import('child_process').ChildProcess, port: number, url: string, close(): void }>}
 *   `close()` stops the watcher (it also stops by itself when the engine exits); it does not stop the engine.
 */
export async function startEngine({
  workspacePath,
  port,
  env = process.env,
  timeoutMs = 0,
  onSpawn,
  onStdout,
  onStderr,
  onReady,
  onInitialized,
}) {
  const child = fork(serverEntry, [], {
    env: {
      ...env,
      FLUIDCAD_SERVER_PORT: String(port),
      FLUIDCAD_WORKSPACE_PATH: workspacePath,
    },
    // Load-bearing: without it the engine's sourceLocations shift by the SSR
    // transform's line offset, mis-targeting breakpoints and feature edits.
    execArgv: ['--enable-source-maps'],
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });

  onSpawn?.(child);
  if (onStdout) {
    child.stdout.on('data', onStdout);
  } else {
    child.stdout.resume();
  }
  if (onStderr) {
    child.stderr.on('data', onStderr);
  } else {
    child.stderr.resume();
  }

  const url = await new Promise((resolvePromise, reject) => {
    let readyUrl = null;
    const timeout = timeoutMs > 0
      ? setTimeout(() => {
        cleanup();
        killEngine(child);
        reject(new EngineStartError(`The engine did not start within ${timeoutMs / 1000}s.`, 'timeout'));
      }, timeoutMs)
      : null;

    const onMessage = (msg) => {
      if (msg?.type === 'ready') {
        readyUrl = typeof msg.url === 'string' ? msg.url : `http://127.0.0.1:${port}`;
        onReady?.(readyUrl);
      } else if (msg?.type === 'init-complete') {
        cleanup();
        if (msg.success) {
          resolvePromise(readyUrl ?? `http://127.0.0.1:${port}`);
        } else {
          // Up and listening but it will never serve a scene: reap it, or
          // every failed start leaves an engine on a port.
          killEngine(child);
          reject(new EngineStartError(msg.error || 'The engine failed to initialize.', 'init-failed'));
        }
      }
    };
    const onError = (err) => {
      cleanup();
      killEngine(child);
      reject(new EngineStartError(err.message, 'error'));
    };
    const onExit = (code) => {
      cleanup();
      reject(new EngineStartError(`The engine exited with code ${code} before it was ready.`, 'exited', code));
    };
    function cleanup() {
      if (timeout) {
        clearTimeout(timeout);
      }
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
    }

    child.on('message', onMessage);
    child.on('error', onError);
    child.on('exit', onExit);
  });

  onInitialized?.();

  let watcher = createFileWatcher(workspacePath, child);
  const close = () => {
    if (watcher) {
      watcher.close();
      watcher = null;
    }
  };
  child.once('exit', close);

  const opening = pickOpeningFile(workspacePath);
  if (opening) {
    child.send({ type: 'process-file', filePath: opening });
  }

  return { child, port, url, close };
}
