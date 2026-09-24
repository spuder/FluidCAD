import { ICON_IMG_FALLBACK } from './object-icons';
import { fuzzyScore } from './fuzzy-match';
import { formatShortcut } from './shortcut-manager';

/**
 * One entry the command palette can run. Callers own the command's identity
 * (icon, label, chord) — the palette only searches and dispatches, the same
 * split `quick-open.ts` uses for workspace files.
 */
export interface PaletteCommand {
  id: string;
  label: string;
  /** PNG basename under `/icons`, the same artwork the toolbar buttons use. Absent: a blank slot, so rows still align. */
  iconPng?: string;
  /** A {@link ShortcutManager} binding string (`'c'`, `'mod+z'`, …), shown formatted on the row. */
  shortcut?: string;
  run(): void;
}

const MAX_RESULTS = 20;

/**
 * The Fusion-style "type the tool's name" menu (issue #71): press a key to
 * open a centered, fuzzy-searchable list of every command currently usable,
 * so reaching a tool never depends on knowing where its button lives or
 * remembering its chord.
 *
 * `getCommands` is called fresh on every {@link open} rather than once at
 * construction — the usable set changes with context (sketch tools only
 * exist while a sketch is being edited), and the palette should always
 * reflect what the app can actually do right now rather than a snapshot from
 * whenever it was built. Built on the same popover/list idiom as
 * `quick-open.ts`'s `+` picker, centered instead of anchored to a button
 * since it has no toolbar home of its own.
 */
export class CommandPalette {
  private popover: HTMLDivElement | null = null;
  private commands: PaletteCommand[] = [];
  private query = '';
  private highlighted = 0;
  private results: PaletteCommand[] = [];

  constructor(private readonly getCommands: () => PaletteCommand[]) {}

  isOpen(): boolean {
    return this.popover !== null;
  }

  close(): void {
    this.popover?.remove();
    this.popover = null;
    document.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
  }

  toggle(): void {
    if (this.popover) {
      this.close();
    } else {
      this.open();
    }
  }

  open(): void {
    if (this.popover) {
      return;
    }

    const popover = document.createElement('div');
    // Centered near the top of the view, Fusion's own placement for this —
    // opaque for the same reason as quick-open's: it sits over the navbar
    // and canvas, and a translucent surface would let both read through.
    popover.className =
      'fixed z-[200] left-1/2 -translate-x-1/2 top-[15vh] w-[420px] bg-base-100 ' +
      'border border-base-content/10 rounded-md shadow-[0_4px_12px_rgba(0,0,0,0.4)] overflow-hidden';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Search commands…';
    input.className =
      'w-full bg-transparent px-3 py-2 text-sm outline-none ' +
      'border-b border-base-content/10 placeholder:text-base-content/40';
    popover.appendChild(input);

    const list = document.createElement('div');
    list.className = 'max-h-[320px] overflow-y-auto py-1';
    popover.appendChild(list);

    document.body.appendChild(popover);
    this.popover = popover;
    this.commands = this.getCommands();
    this.query = '';
    this.highlighted = 0;
    document.addEventListener('pointerdown', this.onDocumentPointerDown, true);

    input.addEventListener('input', () => {
      this.query = input.value;
      this.highlighted = 0;
      this.renderResults(list);
    });
    input.addEventListener('keydown', (event) => this.onKeyDown(event, list));
    input.focus();

    this.renderResults(list);
  }

  private readonly onDocumentPointerDown = (event: PointerEvent): void => {
    if (this.popover && !this.popover.contains(event.target as Node)) {
      this.close();
    }
  };

  private onKeyDown(event: KeyboardEvent, list: HTMLElement): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (this.results.length > 0) {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        this.highlighted = (this.highlighted + step + this.results.length) % this.results.length;
        this.renderResults(list);
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      this.activate(this.highlighted);
    }
  }

  private activate(index: number): void {
    const command = this.results[index];
    if (!command) {
      return;
    }
    this.close();
    command.run();
  }

  private renderResults(list: HTMLElement): void {
    // Stable sort on score alone (no alphabetical tiebreak): with an empty
    // query every score ties at 0, and the list should fall back to the
    // caller's declared order — sketch tools grouped the way the toolbar
    // groups them — rather than scrambling it alphabetically.
    this.results = this.commands
      .map((command) => ({ command, score: fuzzyScore(command.label, this.query) }))
      .filter((row): row is { command: PaletteCommand; score: number } => row.score !== null)
      .sort((a, b) => a.score - b.score)
      .slice(0, MAX_RESULTS)
      .map((row) => row.command);

    list.replaceChildren();

    for (const [index, command] of this.results.entries()) {
      list.appendChild(this.buildRow(command, index === this.highlighted, () => this.activate(index)));
    }

    (list.children[this.highlighted] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });

    if (this.results.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'px-3 py-2 text-xs text-base-content/40';
      empty.textContent = this.commands.length === 0 ? 'No commands available right now.' : 'No matches.';
      list.appendChild(empty);
    }
  }

  private buildRow(command: PaletteCommand, highlighted: boolean, onPick: () => void): HTMLElement {
    const row = document.createElement('button');
    row.className =
      'w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm ' +
      (highlighted ? 'bg-base-content/10 text-base-content' : 'text-base-content/70');

    const icon = document.createElement('span');
    icon.className = 'shrink-0 size-3.5 flex items-center justify-center';
    if (command.iconPng) {
      icon.innerHTML = `<img src="/icons/${command.iconPng}.png" ${ICON_IMG_FALLBACK} class="size-3.5" alt="" />`;
    }
    row.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'flex-1 min-w-0 truncate';
    label.textContent = command.label;
    row.appendChild(label);

    if (command.shortcut) {
      const kbd = document.createElement('kbd');
      kbd.className = 'kbd kbd-xs shrink-0 text-base-content/50';
      kbd.textContent = formatShortcut(command.shortcut);
      row.appendChild(kbd);
    }

    row.addEventListener('click', onPick);
    return row;
  }
}
