import { resolve } from 'path';
import open from 'open';
import { findFreePort } from '../lib/server-client.js';
import { startEngine } from '../lib/engine.js';

async function runServe(opts) {
  const workspacePath = resolve(opts.workspace);
  const requestedPort = Number(opts.port);
  if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
    throw new Error(`Invalid --port "${opts.port}".`);
  }

  // Another workspace's server (or an editor extension) is often already on
  // 3100; step aside instead of dying on EADDRINUSE.
  const freePort = await findFreePort(requestedPort);
  if (freePort !== requestedPort) {
    console.log(`Port ${requestedPort} is in use — starting on ${freePort} instead.`);
  }

  let engine = null;
  const closeWatcher = () => { engine?.close(); };

  try {
    engine = await startEngine({
      workspacePath,
      port: freePort,
      onStdout: (data) => { process.stdout.write(data); },
      onStderr: (data) => { process.stderr.write(data); },
      onSpawn: (child) => {
        process.on('SIGINT', () => {
          closeWatcher();
          child.kill('SIGINT');
        });
        process.on('SIGTERM', () => {
          closeWatcher();
          child.kill('SIGTERM');
        });
      },
      onReady: (url) => {
        console.log(`FluidCAD ready at ${url}`);
        if (opts.open) {
          open(url).catch((err) => {
            console.error(`Failed to open browser: ${err.message}`);
          });
        }
      },
      onInitialized: () => {
        console.log('FluidCAD initialized successfully.');
      },
    });
  } catch (err) {
    if (err?.reason === 'exited') {
      // The engine went away on its own (or on Ctrl-C): mirror its exit code.
      process.exit(err.exitCode || 0);
    }
    if (err?.reason === 'init-failed') {
      console.error(`FluidCAD initialization failed: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  engine.child.on('exit', (code) => {
    closeWatcher();
    process.exit(code || 0);
  });
}

export function registerServeCommand(program) {
  program
    .command('serve')
    .description('Open FluidCAD in the browser: 3D viewport, code editor, and live rebuild')
    .option('-w, --workspace <path>', 'workspace directory', process.cwd())
    .option('-p, --port <port>', 'server port (the first free port at or above it is used)', '3100')
    // The page is the whole product now — a viewport, a code editor and the
    // engine — so opening it is the point of the command rather than an extra.
    // `--open` is kept as a no-op flag so existing scripts don't break.
    .option('--open', 'open the UI in the default browser when ready', true)
    .option('--no-open', 'do not open a browser — useful for CI and remote sessions')
    .action((opts) => {
      runServe(opts).catch((err) => {
        console.error(err?.message ?? err);
        process.exit(1);
      });
    });
}
