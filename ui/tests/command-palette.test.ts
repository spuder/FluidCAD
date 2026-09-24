// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { CommandPalette, type PaletteCommand } from '../src/ui/command-palette';

// jsdom has no scrollIntoView; the result list calls it to keep the
// highlighted row in view.
Element.prototype.scrollIntoView = () => {};

const palettes: CommandPalette[] = [];

function make(commands: PaletteCommand[]): CommandPalette {
  const p = new CommandPalette(() => commands);
  palettes.push(p);
  return p;
}

function query(popover: Element, selector: string): HTMLElement | null {
  return popover.querySelector(selector);
}

function press(el: Element, key: string): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

afterEach(() => {
  while (palettes.length > 0) {
    palettes.pop()!.close();
  }
  document.body.innerHTML = '';
});

function cmd(id: string, label: string, extra: Partial<PaletteCommand> = {}): PaletteCommand {
  return { id, label, run: () => runs.push(id), ...extra };
}

let runs: string[] = [];

describe('CommandPalette', () => {
  it('lists every command in declared order when the query is empty', () => {
    runs = [];
    const p = make([cmd('line', 'Line'), cmd('circle', 'Circle')]);
    p.open();
    const rows = document.querySelectorAll('button');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Line');
    expect(rows[1].textContent).toContain('Circle');
  });

  it('fuzzy-filters as the user types', () => {
    runs = [];
    const p = make([cmd('line', 'Line'), cmd('circle', 'Circle'), cmd('polyline', 'Polyline')]);
    p.open();
    const input = document.querySelector('input')!;
    input.value = 'li';
    input.dispatchEvent(new Event('input'));

    const rows = document.querySelectorAll('button');
    const labels = [...rows].map((r) => r.textContent);
    expect(labels.some((t) => t?.includes('Line'))).toBe(true);
    expect(labels.some((t) => t?.includes('Polyline'))).toBe(true);
    expect(labels.some((t) => t?.includes('Circle'))).toBe(false);
  });

  it('runs the highlighted command on Enter and closes', () => {
    runs = [];
    const p = make([cmd('line', 'Line'), cmd('circle', 'Circle')]);
    p.open();
    const input = document.querySelector('input')!;

    press(input, 'ArrowDown'); // highlight moves to Circle
    press(input, 'Enter');

    expect(runs).toEqual(['circle']);
    expect(p.isOpen()).toBe(false);
  });

  it('runs a clicked row directly, regardless of highlight', () => {
    runs = [];
    const p = make([cmd('line', 'Line'), cmd('circle', 'Circle')]);
    p.open();
    const rows = document.querySelectorAll('button');
    rows[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(runs).toEqual(['circle']);
    expect(p.isOpen()).toBe(false);
  });

  it('closes without running anything on Escape', () => {
    runs = [];
    const p = make([cmd('line', 'Line')]);
    p.open();
    press(document.querySelector('input')!, 'Escape');

    expect(runs).toEqual([]);
    expect(p.isOpen()).toBe(false);
  });

  it('shows a shortcut badge for commands that carry one', () => {
    const p = make([cmd('line', 'Line', { shortcut: 'l' }), cmd('undo', 'Undo', { shortcut: 'mod+z' })]);
    p.open();
    const kbds = document.querySelectorAll('kbd');
    expect(kbds).toHaveLength(2);
    expect(kbds[0].textContent).toBe('l');
  });

  it('re-fetches the command list on every open, reflecting the current context', () => {
    let available: PaletteCommand[] = [];
    const p = new CommandPalette(() => available);
    palettes.push(p);

    p.open();
    expect(document.querySelectorAll('button')).toHaveLength(0);
    p.close();

    available = [cmd('extrude', 'Extrude')];
    p.open();
    const rows = document.querySelectorAll('button');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Extrude');
  });

  it('toggle() opens when closed and closes when open', () => {
    const p = make([cmd('line', 'Line')]);
    p.toggle();
    expect(p.isOpen()).toBe(true);
    p.toggle();
    expect(p.isOpen()).toBe(false);
  });
});
