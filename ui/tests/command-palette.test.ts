// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CommandPalette, type PaletteCommand } from '../src/ui/command-palette';

// jsdom has no scrollIntoView; the result list calls it to keep the
// highlighted row in view.
Element.prototype.scrollIntoView = () => {};

const palettes: CommandPalette[] = [];
let runs: string[] = [];

function cmd(id: string, label: string, extra: Partial<PaletteCommand> = {}): PaletteCommand {
  return { id, label, run: () => runs.push(id), ...extra };
}

function make(commands: PaletteCommand[]): CommandPalette {
  const p = new CommandPalette(() => commands);
  palettes.push(p);
  return p;
}

/** The palette's own popover, so assertions never catch stray page DOM. */
function rows(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('body > div button')];
}

function input(): HTMLInputElement {
  return document.querySelector('input')!;
}

function press(el: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return event;
}

function type(text: string): void {
  const field = input();
  field.value = text;
  field.dispatchEvent(new Event('input'));
}

beforeEach(() => {
  runs = [];
});

afterEach(() => {
  while (palettes.length > 0) {
    palettes.pop()!.close();
  }
  document.body.innerHTML = '';
});

describe('CommandPalette', () => {
  it('lists every command in declared order when the query is empty', () => {
    make([cmd('line', 'Line'), cmd('circle', 'Circle')]).open();

    expect(rows().map((r) => r.textContent)).toEqual(['Line', 'Circle']);
  });

  it('fuzzy-filters as the user types', () => {
    make([cmd('line', 'Line'), cmd('circle', 'Circle'), cmd('polyline', 'Polyline')]).open();
    type('li');

    const labels = rows().map((r) => r.textContent);
    expect(labels).toContain('Line');
    expect(labels).toContain('Polyline');
    expect(labels).not.toContain('Circle');
  });

  it('runs the highlighted command on Enter and closes', () => {
    const p = make([cmd('line', 'Line'), cmd('circle', 'Circle')]);
    p.open();

    press(input(), 'ArrowDown');
    press(input(), 'Enter');

    expect(runs).toEqual(['circle']);
    expect(p.isOpen()).toBe(false);
  });

  it('runs a clicked row directly, regardless of highlight', () => {
    const p = make([cmd('line', 'Line'), cmd('circle', 'Circle')]);
    p.open();
    rows()[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(runs).toEqual(['circle']);
    expect(p.isOpen()).toBe(false);
  });

  it('closes without running anything on Escape', () => {
    const p = make([cmd('line', 'Line')]);
    p.open();
    press(input(), 'Escape');

    expect(runs).toEqual([]);
    expect(p.isOpen()).toBe(false);
  });

  // The ShortcutManager that registers the opening combo stands down inside an
  // <input>, so the palette has to close on that key itself — and consume it,
  // or the browser takes Ctrl+K for the address bar and the VSCode host reads
  // it as a chord prefix.
  it('closes on its own opening combo and consumes the key', () => {
    for (const modifier of ['ctrlKey', 'metaKey'] as const) {
      const p = make([cmd('line', 'Line')]);
      p.open();

      const event = press(input(), 'k', { [modifier]: true });

      expect(p.isOpen()).toBe(false);
      expect(event.defaultPrevented).toBe(true);
      expect(runs).toEqual([]);
    }
  });

  it('leaves an unrelated modifier combo to the rest of the app', () => {
    const p = make([cmd('line', 'Line')]);
    p.open();

    const event = press(input(), 'k', { ctrlKey: true, shiftKey: true });

    expect(p.isOpen()).toBe(true);
    expect(event.defaultPrevented).toBe(false);
  });

  it('shows a shortcut badge for commands that carry one', () => {
    make([cmd('line', 'Line', { shortcut: 'l' }), cmd('undo', 'Undo', { shortcut: 'mod+z' })]).open();

    const kbds = document.querySelectorAll('kbd');
    expect(kbds).toHaveLength(2);
    expect(kbds[0].textContent).toBe('l');
  });

  it('re-fetches the command list on every open, reflecting the current context', () => {
    let available: PaletteCommand[] = [];
    const p = new CommandPalette(() => available);
    palettes.push(p);

    p.open();
    expect(rows()).toHaveLength(0);
    p.close();

    available = [cmd('extrude', 'Extrude')];
    p.open();
    expect(rows().map((r) => r.textContent)).toEqual(['Extrude']);
  });

  it('toggle() opens when closed and closes when open', () => {
    const p = make([cmd('line', 'Line')]);
    p.toggle();
    expect(p.isOpen()).toBe(true);
    p.toggle();
    expect(p.isOpen()).toBe(false);
  });
});
