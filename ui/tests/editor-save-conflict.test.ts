// @vitest-environment jsdom

// A save carries the mtime this page last read or wrote; the server answers
// 409 when the disk has moved on since (another tab or device, an agent,
// `git`). What the page does next is the user's call — overwrite, reload, or
// keep the buffer unsaved — and a wrong branch here silently loses work.
// This drives WorkspaceModels with a fake Monaco and a recording fetch.

import { describe, it, expect, afterEach, vi } from 'vitest';

// Just enough Monaco for WorkspaceModels: models keyed by URI, a version id
// that moves on every edit, and offset-based positions for the minimal edit
// `applyTextAsSingleEdit` pushes.
vi.mock('../src/editor/monaco-setup', () => {
  const models = new Map<string, any>();
  const createModel = (content: string, _lang: string, uri: { key: string }) => {
    let text = content;
    let version = 1;
    const listeners: (() => void)[] = [];
    const model = {
      uri,
      getValue: () => text,
      getVersionId: () => version,
      onDidChangeContent: (fn: () => void) => { listeners.push(fn); return { dispose() {} }; },
      getPositionAt: (offset: number) => offset,
      pushStackElement: () => {},
      pushEditOperations: (_sel: unknown, ops: { range: { start: number; end: number }; text: string }[]) => {
        for (const op of ops) {
          text = text.slice(0, op.range.start) + op.text + text.slice(op.range.end);
        }
        version++;
        listeners.forEach((fn) => fn());
        return null;
      },
      // Test-only: a keystroke.
      type: (next: string) => { text = next; version++; listeners.forEach((fn) => fn()); },
      dispose: () => { models.delete(uri.key); },
    };
    models.set(uri.key, model);
    return model;
  };
  return {
    monaco: {
      Uri: { file: (path: string) => ({ key: `file://${path}`, fsPath: path }) },
      editor: {
        getModel: (uri: { key: string }) => models.get(uri.key) ?? null,
        createModel,
      },
      Range: { fromPositions: (start: number, end: number) => ({ start, end }) },
      __models: models,
    },
  };
});

import { monaco } from '../src/editor/monaco-setup';
import { WorkspaceModels, SaveConflictError } from '../src/editor/models';
import { FileRequestError } from '../src/editor/editor-api';

const ROOT = '/ws';
const REL = 'init.js';
const ABS = `${ROOT}/${REL}`;

type Recorded = { url: string; body: any };
type Reply = { status: number; body: unknown };

function install(opts: { disk: { content: string; mtimeMs: number }; writes: Reply[]; reread?: { content: string; mtimeMs: number } }) {
  const requests: Recorded[] = [];
  const writes = [...opts.writes];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ url, body });
    let reply: Reply;
    if (url === 'api/files/tree') {
      reply = { status: 200, body: { workspacePath: ROOT, files: [{ path: REL, absPath: ABS, kind: 'model' }], truncated: false } };
    } else if (url.startsWith('api/files/read')) {
      const reads = requests.filter((r) => r.url.startsWith('api/files/read')).length;
      const disk = reads > 1 && opts.reread ? opts.reread : opts.disk;
      reply = { status: 200, body: { path: REL, absPath: ABS, kind: 'model', ...disk } };
    } else if (url === 'api/files/write') {
      reply = writes.shift() ?? { status: 500, body: { error: 'unexpected write' } };
    } else {
      reply = { status: 404, body: { error: 'not found' } };
    }
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      statusText: String(reply.status),
      json: async () => reply.body,
    };
  });
  return { requests, writes: () => requests.filter((r) => r.url === 'api/files/write') };
}

async function loaded(disk = { content: 'const a = 1;', mtimeMs: 1000 }) {
  const models = new WorkspaceModels();
  const entry = await models.ensure(REL);
  expect(entry.mtimeMs).toBe(disk.mtimeMs);
  // A keystroke: the buffer is now ahead of the disk.
  (entry.model as any).type('const a = 2;');
  expect(models.isDirty(ABS)).toBe(true);
  return { models, entry };
}

const CONFLICT: Reply = { status: 409, body: { error: 'init.js changed on disk.' } };
const written = (mtimeMs: number): Reply => ({ status: 200, body: { path: REL, absPath: ABS, kind: 'model', mtimeMs } });

afterEach(() => {
  vi.unstubAllGlobals();
  // vitest runs with `isolate: false`: don't leak models between tests.
  (monaco as any).__models.clear();
});

describe('WorkspaceModels.save — stale-write conflicts', () => {
  it('sends the mtime it loaded as expectedMtimeMs and adopts the new one', async () => {
    const { writes } = install({ disk: { content: 'const a = 1;', mtimeMs: 1000 }, writes: [written(2000)] });
    const { models, entry } = await loaded();

    await models.save(ABS);

    expect(writes()).toHaveLength(1);
    expect(writes()[0].body).toEqual({ path: REL, content: 'const a = 2;', expectedMtimeMs: 1000 });
    expect(entry.mtimeMs).toBe(2000);
    expect(models.isDirty(ABS)).toBe(false);

    // The next save is checked against the mtime of this write, not the load.
    (entry.model as any).type('const a = 3;');
    const second = install({ disk: { content: '', mtimeMs: 0 }, writes: [written(3000)] });
    await models.save(ABS);
    expect(second.writes()[0].body.expectedMtimeMs).toBe(2000);
  });

  it('on 409 + overwrite, re-sends without expectedMtimeMs and ends clean', async () => {
    const { writes } = install({ disk: { content: 'const a = 1;', mtimeMs: 1000 }, writes: [CONFLICT, written(5000)] });
    const { models, entry } = await loaded();
    const resolver = vi.fn(async () => 'overwrite' as const);
    models.conflictResolver = resolver;

    await models.save(ABS);

    expect(resolver).toHaveBeenCalledWith(REL);
    expect(writes()).toHaveLength(2);
    expect(writes()[0].body.expectedMtimeMs).toBe(1000);
    expect(writes()[1].body).toEqual({ path: REL, content: 'const a = 2;' });
    expect('expectedMtimeMs' in writes()[1].body).toBe(false);
    expect(entry.mtimeMs).toBe(5000);
    expect(models.isDirty(ABS)).toBe(false);
  });

  it('on 409 + reload, adopts the disk\'s content and mtime and ends clean', async () => {
    const { writes } = install({
      disk: { content: 'const a = 1;', mtimeMs: 1000 },
      reread: { content: 'const a = 99; // from elsewhere', mtimeMs: 7000 },
      writes: [CONFLICT],
    });
    const { models, entry } = await loaded();
    models.conflictResolver = async () => 'reload';

    await models.save(ABS);

    expect(writes()).toHaveLength(1);
    expect(entry.model.getValue()).toBe('const a = 99; // from elsewhere');
    expect(entry.mtimeMs).toBe(7000);
    expect(models.isDirty(ABS)).toBe(false);
  });

  it('on 409 + keep, throws SaveConflictError and leaves the buffer dirty', async () => {
    const { writes } = install({ disk: { content: 'const a = 1;', mtimeMs: 1000 }, writes: [CONFLICT] });
    const { models, entry } = await loaded();
    models.conflictResolver = async () => 'keep';

    const err = await models.save(ABS).catch((e) => e);

    expect(err).toBeInstanceOf(SaveConflictError);
    expect(err.relPath).toBe(REL);
    expect(writes()).toHaveLength(1);
    expect(entry.model.getValue()).toBe('const a = 2;');
    expect(entry.mtimeMs).toBe(1000);
    expect(models.isDirty(ABS)).toBe(true);
  });

  it('with no resolver, the 409 propagates and the buffer stays dirty', async () => {
    const { writes } = install({ disk: { content: 'const a = 1;', mtimeMs: 1000 }, writes: [CONFLICT] });
    const { models, entry } = await loaded();

    const err = await models.save(ABS).catch((e) => e);

    expect(err).toBeInstanceOf(FileRequestError);
    expect(err.status).toBe(409);
    expect(writes()).toHaveLength(1);
    expect(entry.mtimeMs).toBe(1000);
    expect(models.isDirty(ABS)).toBe(true);
  });
});
