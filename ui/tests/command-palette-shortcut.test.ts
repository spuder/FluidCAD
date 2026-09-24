// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { ShortcutManager } from '../src/ui/shortcut-manager';
import { COMMAND_PALETTE_SHORTCUT } from '../src/ui/command-palette';
import { TOOL_SHORTCUTS } from '../src/ui/sketch-toolbar';
import { CONSTRAINT_SHORTCUTS } from '../src/interactive/solved-constraint-toolbar/solved-constraint-toolbar';

const managers: ShortcutManager[] = [];

function make(): ShortcutManager {
  const m = new ShortcutManager({ timeout: 200 });
  managers.push(m);
  return m;
}

function press(key: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

afterEach(() => {
  while (managers.length > 0) {
    managers.pop()!.destroy();
  }
});

/** Every bare-letter binding the sketch-mode manager carries. */
const sketchBindings = [
  ...Object.values(TOOL_SHORTCUTS),
  ...Object.values(CONSTRAINT_SHORTCUTS),
  'g', // guide latch
  'n', // look along sketch normal
];

describe('command palette shortcut', () => {
  it('is a bare letter, so it needs only the hand that is off the mouse', () => {
    expect(COMMAND_PALETTE_SHORTCUT).toMatch(/^[a-z]$/);
  });

  // It may share a PREFIX with a sketch chord — `sy` is fine, the sketch
  // manager tells them apart — but nothing may claim the key outright, or
  // that binding would become unreachable while a sketch is open.
  it('is not taken outright by any sketch-mode binding', () => {
    expect(sketchBindings).not.toContain(COMMAND_PALETTE_SHORTCUT);
  });

  /**
   * The reason both bindings can live on one manager: registered together,
   * the palette's letter waits out the chord timeout in case the longer
   * constraint chord was meant.
   */
  it('opens once the chord timeout passes with no second letter', async () => {
    const fired: string[] = [];
    const m = make();
    m.register(COMMAND_PALETTE_SHORTCUT, () => fired.push('palette'));
    m.register(CONSTRAINT_SHORTCUTS.symmetric, () => fired.push('symmetric'));
    m.enable();

    press(COMMAND_PALETTE_SHORTCUT);
    expect(fired).toEqual([]); // still waiting to see if `sy` was meant

    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(fired).toEqual(['palette']);
  });

  it('applies the constraint instead when its second letter follows', () => {
    const fired: string[] = [];
    const m = make();
    m.register(COMMAND_PALETTE_SHORTCUT, () => fired.push('palette'));
    m.register(CONSTRAINT_SHORTCUTS.symmetric, () => fired.push('symmetric'));
    m.enable();

    for (const key of CONSTRAINT_SHORTCUTS.symmetric) {
      press(key);
    }

    expect(fired).toEqual(['symmetric']);
  });

  // Outside a sketch the sketch manager is disabled entirely, so the global
  // one carries the key with nothing to disambiguate against.
  it('opens immediately where no sketch chord shares its prefix', () => {
    const fired: string[] = [];
    const m = make();
    m.register(COMMAND_PALETTE_SHORTCUT, () => fired.push('palette'));
    m.enable();

    press(COMMAND_PALETTE_SHORTCUT);
    expect(fired).toEqual(['palette']);
  });
});
