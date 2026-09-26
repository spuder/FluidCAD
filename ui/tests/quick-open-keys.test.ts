// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/editor/editor-api', () => ({
  listWorkspaceFiles: async () => ({
    files: [{ path: 'bracket.part.js', absPath: '/ws/bracket.part.js', kind: 'model', size: 0, mtimeMs: 0 }],
    folders: [],
  }),
}));

import { QuickOpen } from '../src/editor/quick-open';

// jsdom has no scrollIntoView; the result list calls it to keep the
// highlighted row in view.
Element.prototype.scrollIntoView = () => {};

let quickOpen: QuickOpen;
let opened: string[] = [];
let seen: string[] = [];

const onDocument = (e: KeyboardEvent) => seen.push(`document:${e.key}`);
const onWindow = (e: KeyboardEvent) => seen.push(`window:${e.key}`);

function press(key: string): void {
  document.querySelector('input')!.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  );
}

beforeEach(async () => {
  opened = [];
  seen = [];
  quickOpen = new QuickOpen({
    onOpen: (entry) => opened.push(entry.path),
    onCreate: () => {},
    onCreateFolder: async () => {},
  });
  const anchor = document.createElement('button');
  document.body.appendChild(anchor);
  await quickOpen.open(anchor);
  document.addEventListener('keydown', onDocument);
  window.addEventListener('keydown', onWindow);
});

afterEach(() => {
  document.removeEventListener('keydown', onDocument);
  window.removeEventListener('keydown', onWindow);
  quickOpen.close();
  document.body.innerHTML = '';
});

// The modify-pick panel applies on any document-level Enter and it and the
// sketch toolbar back out on any Escape: a key the popover spent must not
// reach them too.
describe('QuickOpen keys', () => {
  it('keeps the Enter that opens a file away from the rest of the app', () => {
    press('Enter');

    expect(opened).toEqual(['bracket.part.js']);
    expect(seen).toEqual([]);
  });

  it('keeps the Escape that dismisses it away from the rest of the app', () => {
    press('Escape');

    expect(quickOpen.isOpen()).toBe(false);
    expect(seen).toEqual([]);
  });

  it('keeps arrow navigation away from the rest of the app', () => {
    press('ArrowDown');

    expect(seen).toEqual([]);
  });

  it('leaves keys it does not handle to the rest of the app', () => {
    press('a');

    expect(seen).toEqual(['document:a', 'window:a']);
  });
});
