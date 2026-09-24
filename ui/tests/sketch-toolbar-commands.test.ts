// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { SketchToolbar, TOOL_SHORTCUTS } from '../src/ui/sketch-toolbar';
import { ShortcutManager } from '../src/ui/shortcut-manager';
import type { ToolId } from '../src/interactive/sketch-tool';

const managers: ShortcutManager[] = [];

function build(): { toolbar: SketchToolbar; selected: (ToolId | null)[]; shortcuts: ShortcutManager } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const selected: (ToolId | null)[] = [];
  const shortcuts = new ShortcutManager({ timeout: 200 });
  managers.push(shortcuts);
  // Echo the pick back as the armed tool, the way SketchToolbarService does
  // once it has built the tool — without it the bar never sees its own state
  // and the toggle paths can't be exercised.
  let toolbar: SketchToolbar;
  toolbar = new SketchToolbar(
    host,
    (id) => {
      selected.push(id);
      toolbar.setActiveTool(id);
    },
    () => {},
    () => {},
    shortcuts,
  );
  return { toolbar, selected, shortcuts };
}

afterEach(() => {
  while (managers.length > 0) {
    managers.pop()!.destroy();
  }
  document.body.innerHTML = '';
});

describe('SketchToolbar palette surface', () => {
  it('lists every tool of the bar with its icon and chord', () => {
    const { toolbar } = build();
    const commands = toolbar.listCommands();

    expect(commands.find((c) => c.id === 'line')).toEqual({
      id: 'line', label: 'Line', iconPng: 'line', shortcut: 'l',
    });
    // Every listed chord is one the bar actually registered, so a palette row
    // never advertises a key that does nothing.
    for (const command of commands) {
      expect(command.shortcut).toBe(TOOL_SHORTCUTS[command.id]);
    }
  });

  /**
   * The bug this guards: `activateTool` used to delegate to the click handler,
   * which toggles — so picking the already-armed tool by name from the palette
   * disarmed it instead of arming it.
   */
  it('arms a tool that is already armed rather than toggling it off', () => {
    const { toolbar, selected } = build();
    toolbar.setActiveTool('line');

    toolbar.activateTool('line');

    expect(selected).toEqual(['line']);
  });

  it('arms a different tool the same way', () => {
    const { toolbar, selected } = build();
    toolbar.setActiveTool('circle');

    toolbar.activateTool('line');

    expect(selected).toEqual(['line']);
  });

  // Rectangle carries session options (rounded/centered); arming it by name
  // has to resolve to the same variant its button would arm.
  it('resolves the rectangle variant when armed by name', () => {
    const { toolbar, selected } = build();

    toolbar.activateTool('rect');

    expect(selected).toEqual(['rect']);
  });

  // The chord keeps the toggle: it is aimed at a button whose armed state the
  // user can see, so pressing it again is a deliberate disarm. Bezier's `b`
  // rather than Line's `l`, which is a prefix of Polyline's `ll` — two of
  // those would be a different chord, not the same one twice.
  it('still toggles off when the tool chord is pressed twice', () => {
    const { selected, shortcuts } = build();
    shortcuts.enable();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));

    expect(selected).toEqual(['bezier', null]);
  });
});
