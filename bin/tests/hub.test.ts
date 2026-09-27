// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { isSameOriginJson } from '../commands/hub.js';

// The hub's project routes rename and delete folders, so they must only
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

describe('fluidcad hub project routes', () => {
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

  const rename = (headers: Record<string, string>, body: unknown) =>
    fetch(`${base}/hub/api/rename`, { method: 'POST', headers, body: JSON.stringify(body) });

  it('refuses the cross-site rename a hostile page can send', async () => {
    const res = await rename(
      { 'Content-Type': 'text/plain', Origin: 'https://evil.example' },
      { name: 'bracket', newName: 'pwned' },
    );
    expect(res.status).toBe(403);
    expect(fs.existsSync(path.join(projects, 'bracket'))).toBe(true);
    expect(fs.existsSync(path.join(projects, 'pwned'))).toBe(false);
  });

  it('refuses JSON from another origin', async () => {
    const res = await rename(
      { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      { name: 'bracket', newName: 'pwned' },
    );
    expect(res.status).toBe(403);
    expect(fs.existsSync(path.join(projects, 'bracket'))).toBe(true);
  });

  it('still renames for the hub page itself', async () => {
    const res = await rename(
      { 'Content-Type': 'application/json', Origin: base },
      { name: 'bracket', newName: 'renamed' },
    );
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(projects, 'renamed', 'init.js'))).toBe(true);
  });
});
