// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import WebSocket from 'ws';
import { isSameOriginJson } from '../commands/hub.js';

// The hub's POST routes act on projects (stopping engines), so they must only
// answer the hub's own page: a page on another site can make the browser
// POST to the hub (the Host header is the hub's own, so the loopback Host
// check does not help), but it cannot send JSON or hide where it came from.

const req = (headers: Record<string, string>) => ({ headers });

describe('isSameOriginJson', () => {
  it('accepts the hub page\'s own JSON request', () => {
    expect(isSameOriginJson(req({
      host: 'fluidcad.example.ts.net',
      'content-type': 'application/json',
      origin: 'https://fluidcad.example.ts.net',
      'sec-fetch-site': 'same-origin',
    }))).toBe(true);
  });

  it('accepts a non-browser client that sends neither Origin nor Sec-Fetch-Site', () => {
    expect(isSameOriginJson(req({ host: '127.0.0.1:3100', 'content-type': 'application/json; charset=utf-8' }))).toBe(true);
  });

  it('refuses a body that is not JSON (the no-preflight form a cross-site page can send)', () => {
    expect(isSameOriginJson(req({ host: '127.0.0.1:3100', 'content-type': 'text/plain' }))).toBe(false);
    expect(isSameOriginJson(req({ host: '127.0.0.1:3100' }))).toBe(false);
  });

  it('refuses another site, by Sec-Fetch-Site or by Origin', () => {
    expect(isSameOriginJson(req({
      host: '127.0.0.1:3100', 'content-type': 'application/json', 'sec-fetch-site': 'cross-site',
    }))).toBe(false);
    expect(isSameOriginJson(req({
      host: '127.0.0.1:3100', 'content-type': 'application/json', origin: 'https://evil.example',
    }))).toBe(false);
    expect(isSameOriginJson(req({
      host: '127.0.0.1:3100', 'content-type': 'application/json', origin: 'not a url',
    }))).toBe(false);
  });

  it('matches Origin against X-Forwarded-Host behind a proxy that rewrites Host', () => {
    expect(isSameOriginJson(req({
      host: '127.0.0.1:3100',
      'x-forwarded-host': 'cad.example.com',
      'content-type': 'application/json',
      origin: 'https://cad.example.com',
    }))).toBe(true);
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

describe('fluidcad hub: cross-site requests', () => {
  let hub: ChildProcess;
  let base: string;
  let projects: string;

  beforeAll(async () => {
    projects = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-hub-')));
    fs.mkdirSync(path.join(projects, 'bracket'));
    fs.writeFileSync(path.join(projects, 'bracket', 'init.js'), '');
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const cli = path.resolve(import.meta.dirname, '..', 'fluidcad.js');
    hub = spawn(process.execPath, [cli, 'hub', '--projects', projects, '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      hub.stdout!.on('data', (data) => { if (String(data).includes('hub ready')) resolve(); });
      hub.once('exit', (code) => reject(new Error(`hub exited with ${code}`)));
    });
  });

  afterAll(() => {
    hub?.kill('SIGTERM');
    fs.rmSync(projects, { recursive: true, force: true });
  });

  const stop = (headers: Record<string, string>, body: unknown) =>
    fetch(`${base}/hub/api/stop`, { method: 'POST', headers, body: JSON.stringify(body) });

  it('refuses the cross-site request a hostile page can send', async () => {
    const res = await stop({ 'Content-Type': 'text/plain', Origin: 'https://evil.example' }, { name: 'bracket' });
    expect(res.status).toBe(403);
  });

  it('refuses JSON from another origin', async () => {
    const res = await stop({ 'Content-Type': 'application/json', Origin: 'https://evil.example' }, { name: 'bracket' });
    expect(res.status).toBe(403);
  });

  it('still answers the hub page itself', async () => {
    const res = await stop({ 'Content-Type': 'application/json', Origin: base }, { name: 'bracket' });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Black-box: a spawned hub, driven over HTTP and WebSocket only.
// ---------------------------------------------------------------------------

type Hub = { base: string; port: number; child: ChildProcess; output: () => string; stop: () => Promise<void> };

async function startHub(projects: string): Promise<Hub> {
  const port = await freePort();
  const cli = path.resolve(import.meta.dirname, '..', 'fluidcad.js');
  const child = spawn(process.execPath, [cli, 'hub', '--projects', projects, '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Both pipes are always drained: an engine's logs are forwarded through
  // the hub's, and a full pipe would stall it. Kept (bounded) for diagnosis.
  let output = '';
  const keep = (data: Buffer) => { output = (output + data).slice(-20_000); };
  child.stdout!.on('data', keep);
  child.stderr!.on('data', keep);
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', () => { if (output.includes('hub ready')) resolve(); });
    child.once('exit', (code) => reject(new Error(`hub exited with ${code}: ${output}`)));
  });
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    child,
    output: () => output,
    // Waits for the hub to exit, which is after it has SIGTERMed its engines.
    stop: () => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 10_000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    }),
  };
}

function makeProject(projects: string, name: string, initJs = '') {
  fs.mkdirSync(path.join(projects, name), { recursive: true });
  fs.writeFileSync(path.join(projects, name, 'init.js'), initJs);
}

describe('fluidcad hub — projects over HTTP', () => {
  let hub: Hub;
  let projects: string;

  beforeAll(async () => {
    projects = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-hub-')));
    makeProject(projects, 'good');
    makeProject(projects, 'my part');
    makeProject(projects, '.hidden');
    makeProject(projects, '.trash');
    makeProject(projects, 'bad$name');
    makeProject(projects, '_leading-underscore');
    fs.mkdirSync(path.join(projects, 'no-init'));
    fs.writeFileSync(path.join(projects, 'loose-file.js'), '');
    hub = await startHub(projects);
  }, 30_000);

  afterAll(async () => {
    await hub?.stop();
    fs.rmSync(projects, { recursive: true, force: true });
  });

  const post = (route: string, body: unknown) => fetch(`${hub.base}/hub/api/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: hub.base },
    body: JSON.stringify(body),
  });
  const names = async () => {
    const res = await fetch(`${hub.base}/hub/api/list`);
    expect(res.status).toBe(200);
    const state = await res.json() as { projects: { name: string }[] };
    return state.projects.map((project) => project.name).sort();
  };

  it('lists only valid-named subfolders that hold an init.js', async () => {
    expect(await names()).toEqual(['good', 'my part']);
    const res = await fetch(`${hub.base}/hub/api/list`);
    const state = await res.json() as { projects: { name: string; path: string; open: boolean }[] };
    const good = state.projects.find((project) => project.name === 'good')!;
    expect(good.path).toBe(path.join(projects, 'good'));
    expect(good.open).toBe(false);
  });

  it('serves the start page with the browser shim at /', async () => {
    const res = await fetch(`${hub.base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(await res.text()).toContain('window.fluidcadShell');
  });

  it('refuses a bad project name or JSON body on stop (400)', async () => {
    expect((await post('stop', { name: '../good' })).status).toBe(400);
    expect((await post('stop', {})).status).toBe(400);
    const res = await fetch(`${hub.base}/hub/api/stop`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json',
    });
    expect(res.status).toBe(400);
  });

  it('redirects /p/<name> to <name>/ (relative, query kept)', async () => {
    const plain = await fetch(`${hub.base}/p/good`, { redirect: 'manual' });
    expect(plain.status).toBe(301);
    expect(plain.headers.get('location')).toBe('good/');

    const spaced = await fetch(`${hub.base}/p/my%20part?x=1`, { redirect: 'manual' });
    expect(spaced.status).toBe(301);
    expect(spaced.headers.get('location')).toBe('my%20part/?x=1');
  });

  it('answers 404 for unknown projects and non-projects without starting an engine', async () => {
    for (const url of ['/p/nope', '/p/nope/', '/p/no-init/', '/p/.trash/', '/p/bad%24name/', '/p/..%2F/', '/elsewhere']) {
      const res = await fetch(`${hub.base}${url}`, { redirect: 'manual' });
      expect(res.status, url).toBe(404);
    }
    const state = await (await fetch(`${hub.base}/hub/api/list`)).json() as { projects: { open: boolean }[] };
    expect(state.projects.every((project) => !project.open)).toBe(true);
  });

  it('refuses a WebSocket upgrade for an unknown project', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${hub.port}/p/nope/`);
    const status = await new Promise<number>((resolve) => {
      socket.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      socket.on('error', () => resolve(-1));
    });
    socket.terminate();
    expect(status).toBe(404);
  });

  it.each([
    ['/favicon.ico', 'image/x-icon'],
    ['/logo.svg', 'image/svg+xml'],
    ['/logo.png', 'image/png'],
  ])('serves %s as %s', async (url, type) => {
    const res = await fetch(`${hub.base}${url}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe(type);
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });
});

// Proxying needs a real engine: the hub forks `fluidcad serve` itself, so
// there is nothing to stub. One project, one engine, shared by both tests;
// the first request pays for the boot (OpenCascade wasm).
describe('fluidcad hub — proxying to a project engine', () => {
  let hub: Hub;
  let projects: string;
  const NAME = 'engine demo';
  const SLUG = encodeURIComponent(NAME);

  beforeAll(async () => {
    projects = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fluidcad-hub-engine-')));
    // A project is any subfolder that `fluidcad init` has scaffolded.
    const dir = path.join(projects, NAME);
    fs.mkdirSync(dir);
    const cli = path.resolve(import.meta.dirname, '..', 'fluidcad.js');
    expect(spawnSync(process.execPath, [cli, 'init'], { cwd: dir }).status).toBe(0);
    hub = await startHub(projects);
  }, 60_000);

  afterAll(async () => {
    await hub?.stop();
    fs.rmSync(projects, { recursive: true, force: true });
  }, 30_000);

  it('starts the engine on demand and serves its page with a way home', async () => {
    const res = await fetch(`${hub.base}/p/${SLUG}/`);
    expect(res.status, hub.output()).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('<meta name="fluidcad-home" content="../../">');

    // The prefix is stripped for the page's other requests too.
    const icon = await fetch(`${hub.base}/p/${SLUG}/logo.svg`);
    expect(icon.status).toBe(200);
    expect(await icon.text()).not.toContain('fluidcad-home');

    const state = await (await fetch(`${hub.base}/hub/api/list`)).json() as { projects: { name: string; open: boolean }[] };
    expect(state.projects.find((project) => project.name === NAME)?.open).toBe(true);
  }, 180_000);

  it('pipes a WebSocket through to the engine', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${hub.port}/p/${SLUG}/`);
    try {
      const message = await new Promise<{ type: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no init-complete over the socket\n${hub.output()}`)), 150_000);
        socket.on('message', (data) => {
          const msg = JSON.parse(String(data));
          if (msg.type === 'init-complete') {
            clearTimeout(timer);
            resolve(msg);
          }
        });
        socket.on('unexpected-response', (_req, res) => {
          clearTimeout(timer);
          reject(new Error(`upgrade refused: ${res.statusCode}`));
        });
        socket.on('error', (err) => { clearTimeout(timer); reject(err); });
      });
      expect(message.type).toBe('init-complete');
    } finally {
      socket.terminate();
    }
  }, 180_000);
});
