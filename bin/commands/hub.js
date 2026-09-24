import { fork, spawn } from 'child_process';
import { createServer, request as httpRequest } from 'http';
import { connect } from 'net';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { findFreePort } from '../lib/server-client.js';
import { isLoopbackBindAddress, isLoopbackHostHeader } from '../../server/dist/host-guard.js';
import { readProjectConfig } from '../../server/dist/project-config.js';

/**
 * `fluidcad hub` — one address, many projects.
 *
 * The engine holds one workspace per process, so the hub doesn't try to make
 * one server hold several. It does what the desktop app does instead: one
 * `fluidcad serve` child per project, started on demand, and a small front
 * process in front of them. The front serves the desktop start screen at `/`
 * and reverse-proxies `/p/<name>/*` to that project's engine with the prefix
 * stripped — which works because the page uses relative URLs throughout.
 *
 * Engines always bind loopback: only the hub is reachable from outside, so
 * `FLUIDCAD_SERVER_HOST` widens the hub's bind address, never an engine's.
 * Every link the hub emits is relative too, so the hub itself can sit behind
 * a path-prefix proxy.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliEntry = resolve(__dirname, '..', 'fluidcad.js');
const startPage = resolve(__dirname, '..', '..', 'shell', 'static', 'start.html');
const uiDist = resolve(__dirname, '..', '..', 'ui', 'dist');

const ENGINE_START_TIMEOUT_MS = 120_000;
const ENGINE_FIRST_PORT = 3200;
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/;

function isValidName(name) {
  return typeof name === 'string' && PROJECT_NAME.test(name) && !name.includes('..');
}

// ---------------------------------------------------------------------------
// Projects on disk
// ---------------------------------------------------------------------------

function listProjects(root, engines, opened) {
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidName(entry.name)) {
      continue;
    }
    const dir = join(root, entry.name);
    if (!existsSync(join(dir, 'init.js'))) {
      continue;
    }
    const config = readProjectConfig(dir);
    const lastOpenedAt = opened.get(entry.name) ?? statSync(dir).mtime.toISOString();
    projects.push({
      name: entry.name,
      path: dir,
      lastOpenedAt,
      open: engines.get(entry.name)?.state === 'ready',
      engine: config.engine ?? null,
      engineSource: config.source === 'package.json' ? 'own' : 'pin',
      thumbnail: null,
    });
  }
  projects.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  return projects;
}

/**
 * Deleting moves the folder to `<projects>/.trash/<name>-<time>` rather than
 * erasing it: a click in a browser should not be able to lose work for good.
 * The dot keeps the trash out of the project list.
 */
function trashProject(root, name) {
  const dir = join(root, name);
  if (!existsSync(join(dir, 'init.js'))) {
    throw new Error(`No project named "${name}".`);
  }
  const trash = join(root, '.trash');
  mkdirSync(trash, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(trash, `${name}-${stamp}`);
  renameSync(dir, target);
  return target;
}

function renameProject(root, name, newName) {
  const from = join(root, name);
  const to = join(root, newName);
  if (!existsSync(join(from, 'init.js'))) {
    throw new Error(`No project named "${name}".`);
  }
  if (existsSync(to)) {
    throw new Error(`"${newName}" already exists.`);
  }
  // Safe to move as a whole: files import each other relatively, and the
  // saved editor state (.fluidcad/editor-state.json) is workspace-relative.
  renameSync(from, to);
}

function createProject(root, name) {
  const dir = join(root, name);
  if (existsSync(join(dir, 'init.js'))) {
    return Promise.reject(new Error(`A project named "${name}" already exists.`));
  }
  mkdirSync(dir, { recursive: true });
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliEntry, 'init'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(output.trim() || `fluidcad init exited with code ${code}.`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Engines: one `fluidcad serve` child per project
// ---------------------------------------------------------------------------

class EnginePool {
  constructor(root) {
    this.root = root;
    /** name -> { state, child, port, ready: Promise, lastActivity, sockets } */
    this.engines = new Map();
  }

  get(name) {
    return this.engines.get(name);
  }

  /** The running engine's port, starting it first when needed. */
  async ensure(name) {
    let engine = this.engines.get(name);
    if (!engine) {
      engine = this.start(name);
    }
    engine.lastActivity = Date.now();
    await engine.ready;
    return engine.port;
  }

  start(name) {
    const dir = join(this.root, name);
    const engine = { state: 'starting', child: null, port: 0, ready: null, lastActivity: Date.now(), sockets: 0 };
    this.engines.set(name, engine);

    engine.ready = (async () => {
      const requested = await findFreePort(ENGINE_FIRST_PORT, 500);
      if (engine.state === 'stopped') {
        throw new Error(`The engine for "${name}" was stopped before it started.`);
      }
      // The engine stays on loopback whatever the hub binds; the hub is its
      // only client.
      const env = { ...process.env };
      delete env.FLUIDCAD_SERVER_HOST;
      const child = fork(cliEntry, ['serve', '--workspace', dir, '--port', String(requested), '--no-open'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      engine.child = child;

      const prefix = `[${name}] `;
      const log = (stream) => (data) => {
        for (const line of String(data).split('\n')) {
          if (line.trim()) {
            stream.write(prefix + line + '\n');
          }
        }
      };
      child.stderr.on('data', log(process.stderr));

      await new Promise((resolvePromise, reject) => {
        let buffer = '';
        const timeout = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error(`The engine for "${name}" did not start within ${ENGINE_START_TIMEOUT_MS / 1000}s.`));
        }, ENGINE_START_TIMEOUT_MS);
        child.stdout.on('data', (data) => {
          log(process.stdout)(data);
          if (engine.state !== 'starting') {
            return;
          }
          buffer += data;
          const ready = buffer.match(/FluidCAD ready at https?:\/\/[^\s:]+:(\d+)/);
          if (ready) {
            engine.port = Number(ready[1]);
          }
          if (buffer.includes('FluidCAD initialized successfully.') && engine.port) {
            clearTimeout(timeout);
            engine.state = 'ready';
            resolvePromise();
          }
        });
        child.on('exit', (code) => {
          clearTimeout(timeout);
          // A no-op once ready; also settles waiters when stopped mid-start.
          reject(new Error(`The engine for "${name}" exited with code ${code} before it was ready.`));
        });
      });
    })();

    engine.ready.catch((err) => {
      console.error(err.message);
      if (this.engines.get(name) === engine) {
        this.engines.delete(name);
      }
    });

    // Forget an engine that dies later, so the next request starts a new one.
    engine.ready.then(() => {
      engine.child.on('exit', () => {
        engine.state = 'stopped';
        if (this.engines.get(name) === engine) {
          this.engines.delete(name);
        }
      });
    }, () => {});

    return engine;
  }

  /** Resolves once the engine has exited (or after `graceMs`), so its folder can be moved. */
  stop(name, graceMs = 5_000) {
    const engine = this.engines.get(name);
    if (!engine) {
      return Promise.resolve();
    }
    this.engines.delete(name);
    engine.state = 'stopped';
    const child = engine.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve();
    }
    return new Promise((resolvePromise) => {
      const timer = setTimeout(resolvePromise, graceMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolvePromise();
      });
      child.kill('SIGTERM');
    });
  }

  stopIdle(idleMs) {
    const now = Date.now();
    for (const [name, engine] of this.engines) {
      if (engine.state === 'ready' && engine.sockets === 0 && now - engine.lastActivity > idleMs) {
        console.log(`Stopping idle engine for "${name}".`);
        this.stop(name);
      }
    }
  }

  stopAll() {
    for (const name of [...this.engines.keys()]) {
      this.stop(name);
    }
  }
}

// ---------------------------------------------------------------------------
// The start page, running in a browser
// ---------------------------------------------------------------------------

/**
 * `shell/static/start.html` talks to Electron only through
 * `window.fluidcadShell.start.*`. This is the web stand-in for that bridge,
 * injected ahead of the page's own script so the page runs unchanged.
 */
const SHELL_SHIM = `<script>
(() => {
  const byPath = new Map();
  const post = (url, body) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { throw new Error(data.error || res.statusText); }
    return data;
  });
  const go = (name) => { location.href = 'p/' + encodeURIComponent(name) + '/'; };
  const fail = (err) => { alert(err.message || String(err)); };
  window.fluidcadShell = {
    start: {
      async list() {
        const res = await fetch('hub/api/list');
        const state = await res.json();
        byPath.clear();
        for (const project of state.projects) { byPath.set(project.path, project.name); }
        return state;
      },
      async open(path) { go(byPath.get(path) ?? path); },
      async openDialog() {
        const names = [...byPath.values()];
        const name = prompt(names.length ? 'Open project:\\n' + names.join('\\n') : 'No projects yet.', names[0] ?? '');
        if (!name) { return; }
        if (!names.includes(name.trim())) { fail(new Error('No project named "' + name.trim() + '".')); return; }
        go(name.trim());
      },
      async newProject() {
        const name = prompt('New project name (letters, numbers, spaces, . _ -):');
        if (!name) { return; }
        try {
          await post('hub/api/new', { name: name.trim() });
          go(name.trim());
        } catch (err) { fail(err); }
      },
      forgetLabel: 'Stop engine',
      async renameProject(path) {
        const name = byPath.get(path) ?? path;
        const newName = prompt('Rename project "' + name + '" to:', name);
        if (!newName || newName.trim() === name) { return; }
        await post('hub/api/rename', { name, newName: newName.trim() }).catch(fail);
      },
      async deleteProject(path) {
        const name = byPath.get(path) ?? path;
        if (!confirm('Delete project "' + name + '"?\\n\\nIts folder is moved to .trash inside the projects folder.')) { return; }
        await post('hub/api/delete', { name }).catch(fail);
      },
      async forget(path) {
        // No recents list on the server: removing a card stops its engine.
        await post('hub/api/stop', { name: byPath.get(path) ?? path }).catch(fail);
      },
      async feed() { return { notifications: [], tutorials: [] }; },
      async dismissNotification() {},
      async openLink(url) { window.open(url, '_blank', 'noopener'); },
      onChanged() {},
    },
  };
})();
</script>
`;

/** The same artwork the project pages use, served from the built UI. */
const ICON_FILES = {
  '/favicon.ico': 'image/x-icon',
  '/logo.svg': 'image/svg+xml',
  '/logo.png': 'image/png',
};
const ICON_LINKS =
  '<link rel="icon" type="image/svg+xml" href="logo.svg">' +
  '<link rel="alternate icon" href="favicon.ico">' +
  '<link rel="apple-touch-icon" href="logo.png">';

function renderStartPage() {
  // The desktop page has no network access at all; here the bridge is fetch,
  // so the hub's copy may talk to its own origin.
  const html = readFileSync(startPage, 'utf8')
    .replace("default-src 'none';", "default-src 'none'; connect-src 'self';")
    .replace('img-src data: https:;', "img-src 'self' data: https:;")
    .replace('</title>', '</title>\n    ' + ICON_LINKS);
  const marker = '<script>';
  const at = html.lastIndexOf(marker);
  if (at === -1) {
    throw new Error(`Unexpected start page layout: ${startPage}`);
  }
  return html.slice(0, at) + SHELL_SHIM + html.slice(at);
}

// ---------------------------------------------------------------------------
// HTTP front
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolvePromise, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) {
        reject(new Error('Request body too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolvePromise(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

/** `/p/<name>/rest?query` -> { name, rest } (rest keeps its leading slash), or null. */
function parseProjectPath(url) {
  const match = /^\/p\/([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(url);
  if (!match) {
    return null;
  }
  let name;
  try {
    name = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return { name, rest: match[2] ?? '', query: match[3] ?? '' };
}

async function runHub(opts) {
  const root = resolve(opts.projects);
  mkdirSync(root, { recursive: true });
  const port = Number(opts.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port "${opts.port}".`);
  }
  const idleMinutes = Number(opts.idleMinutes);
  if (!Number.isFinite(idleMinutes) || idleMinutes < 0) {
    throw new Error(`Invalid --idle-minutes "${opts.idleMinutes}".`);
  }

  // Same boundary as `serve` (server/src/host-guard.ts): loopback by default,
  // with the DNS-rebinding Host check; FLUIDCAD_SERVER_HOST exposes it
  // deliberately (a container behind a reverse proxy) and lifts the check.
  const host = process.env.FLUIDCAD_SERVER_HOST || '127.0.0.1';
  const enforceHost = isLoopbackBindAddress(host);
  const hostAllowed = (req) => !enforceHost || isLoopbackHostHeader(req.headers.host);

  const pool = new EnginePool(root);
  /** name -> ISO time it was last opened through the hub. */
  const opened = new Map();

  async function handleHubApi(req, res, path) {
    if (req.method === 'GET' && path === '/hub/api/list') {
      const projects = listProjects(root, pool.engines, opened);
      sendJson(res, 200, { home: '', limit: projects.length, projects });
      return;
    }
    if (req.method === 'POST' && ['/hub/api/new', '/hub/api/stop', '/hub/api/delete', '/hub/api/rename'].includes(path)) {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: err.message });
        return;
      }
      if (!isValidName(body.name)) {
        sendJson(res, 400, { error: 'Use letters, numbers, spaces, ".", "_" or "-" (up to 64), starting with a letter or number.' });
        return;
      }
      if (path === '/hub/api/rename') {
        if (!isValidName(body.newName)) {
          sendJson(res, 400, { error: 'Use letters, numbers, spaces, ".", "_" or "-" (up to 64), starting with a letter or number.' });
          return;
        }
        await pool.stop(body.name);
        try {
          renameProject(root, body.name, body.newName);
          if (opened.has(body.name)) {
            opened.set(body.newName, opened.get(body.name));
            opened.delete(body.name);
          }
          console.log(`Renamed project "${body.name}" to "${body.newName}".`);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 409, { error: err.message });
        }
        return;
      }
      if (path === '/hub/api/delete') {
        await pool.stop(body.name);
        try {
          const target = trashProject(root, body.name);
          console.log(`Moved project "${body.name}" to ${target}.`);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 404, { error: err.message });
        }
        return;
      }
      if (path === '/hub/api/stop') {
        await pool.stop(body.name);
        sendJson(res, 200, { ok: true });
        return;
      }
      try {
        await createProject(root, body.name);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendJson(res, 409, { error: err.message });
      }
      return;
    }
    sendJson(res, 404, { error: 'Not found.' });
  }

  function projectExists(name) {
    return isValidName(name) && existsSync(join(root, name, 'init.js'));
  }

  function proxyHttp(req, res, enginePort, path) {
    // The project's page itself gets a `fluidcad-home` meta tag pointing back
    // at the picker (relative, so any outer prefix survives); the page turns
    // its logo into that link. Asked for uncompressed and unconditionally so
    // there is a body to edit.
    const isPage = req.method === 'GET' && (path === '/' || path.startsWith('/?'));
    const headers = { ...req.headers, host: `127.0.0.1:${enginePort}` };
    if (isPage) {
      delete headers['accept-encoding'];
      delete headers['if-none-match'];
      delete headers['if-modified-since'];
    }
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: enginePort,
      method: req.method,
      path,
      headers,
    }, (upstreamRes) => {
      const isHtml = String(upstreamRes.headers['content-type'] ?? '').includes('text/html');
      if (!isPage || !isHtml || upstreamRes.statusCode !== 200) {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
        return;
      }
      const chunks = [];
      upstreamRes.on('data', (chunk) => chunks.push(chunk));
      upstreamRes.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf8')
          .replace(/<head>/i, '<head>\n  <meta name="fluidcad-home" content="../../">');
        const out = { ...upstreamRes.headers, 'cache-control': 'no-store' };
        delete out['content-length'];
        delete out['etag'];
        delete out['last-modified'];
        res.writeHead(200, out);
        res.end(html);
      });
      upstreamRes.on('error', () => res.destroy());
    });
    upstream.on('error', (err) => {
      if (!res.headersSent) {
        sendJson(res, 502, { error: `Engine unreachable: ${err.message}` });
      } else {
        res.destroy();
      }
    });
    req.pipe(upstream);
  }

  const server = createServer(async (req, res) => {
    if (!hostAllowed(req)) {
      sendJson(res, 403, { error: `Rejected request for host "${req.headers.host ?? ''}": this server answers only to localhost.` });
      return;
    }
    const url = req.url ?? '/';
    const path = url.split('?')[0];

    if (path === '/' || path === '/index.html') {
      try {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(renderStartPage());
      } catch (err) {
        sendJson(res, 500, { error: err.message });
      }
      return;
    }
    if (Object.hasOwn(ICON_FILES, path)) {
      try {
        const body = readFileSync(resolve(uiDist, '.' + path));
        res.writeHead(200, { 'Content-Type': ICON_FILES[path], 'Cache-Control': 'public, max-age=86400' });
        res.end(body);
      } catch {
        sendJson(res, 404, { error: 'Not found.' });
      }
      return;
    }
    if (path.startsWith('/hub/api/')) {
      await handleHubApi(req, res, path);
      return;
    }

    const target = parseProjectPath(url);
    if (!target) {
      sendJson(res, 404, { error: 'Not found.' });
      return;
    }
    if (!projectExists(target.name)) {
      sendJson(res, 404, { error: `No project named "${target.name}".` });
      return;
    }
    // The page resolves its URLs against its own directory, so it must be
    // loaded with the trailing slash. Relative Location keeps any outer prefix.
    if (target.rest === '') {
      res.writeHead(301, { Location: `${encodeURIComponent(target.name)}/${target.query}` });
      res.end();
      return;
    }
    if (target.rest === '/') {
      opened.set(target.name, new Date().toISOString());
    }
    let enginePort;
    try {
      enginePort = await pool.ensure(target.name);
    } catch (err) {
      sendJson(res, 502, { error: err.message });
      return;
    }
    proxyHttp(req, res, enginePort, target.rest + target.query);
  });

  // WebSocket upgrades: a raw TCP pipe to the engine, with the path and Host
  // rewritten the same way as plain requests.
  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const target = parseProjectPath(req.url ?? '');
    if (!hostAllowed(req) || !target || !projectExists(target.name)) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    let enginePort;
    try {
      enginePort = await pool.ensure(target.name);
    } catch {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      return;
    }
    const engine = pool.get(target.name);
    const upstream = connect(enginePort, '127.0.0.1', () => {
      const lines = [`${req.method} ${target.rest || '/'}${target.query} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const key = req.rawHeaders[i];
        const value = key.toLowerCase() === 'host' ? `127.0.0.1:${enginePort}` : req.rawHeaders[i + 1];
        lines.push(`${key}: ${value}`);
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) {
        upstream.write(head);
      }
      socket.pipe(upstream).pipe(socket);
    });
    if (engine) {
      engine.sockets += 1;
    }
    let closed = false;
    const close = () => {
      if (closed) {
        return;
      }
      closed = true;
      if (engine) {
        engine.sockets -= 1;
        engine.lastActivity = Date.now();
      }
      socket.destroy();
      upstream.destroy();
    };
    upstream.on('error', close);
    upstream.on('close', close);
    socket.on('close', close);
  });

  let reaper = null;
  if (idleMinutes > 0) {
    reaper = setInterval(() => pool.stopIdle(idleMinutes * 60_000), 60_000);
    reaper.unref();
  }

  const shutdown = () => {
    if (reaper) {
      clearInterval(reaper);
    }
    pool.stopAll();
    server.close();
    // Give the engines their SIGTERM before we go.
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolvePromise);
  });
  const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  console.log(`FluidCAD hub ready at http://${shownHost}:${port}/ (projects in ${root})`);
}

export function registerHubCommand(program) {
  program
    .command('hub')
    .description('Serve a project picker for a folder of projects, starting one engine per project on demand')
    .option('--projects <dir>', 'folder whose subfolders are projects (each with an init.js)', process.cwd())
    .option('-p, --port <port>', 'port the hub listens on', '3100')
    .option('--idle-minutes <minutes>', 'stop an engine with no open page after this many minutes (0 = never)', '30')
    .action((opts) => {
      runHub(opts).catch((err) => {
        console.error(err?.message ?? err);
        process.exit(1);
      });
    });
}
