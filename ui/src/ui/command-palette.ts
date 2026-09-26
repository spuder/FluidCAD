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
  /** Icon URL — the same artwork the toolbar button uses. Absent: a blank slot, so rows still align. */
  icon?: string;
  /**
   * Which bench the command belongs to, shown muted after the label. Only
   * worth setting where a bare label would be ambiguous: Fillet, Offset,
   * Copy and Mirror all name both a sketch tool and a solid feature.
   */
  detail?: string;
  /** A {@link ShortcutManager} binding string (`'c'`, `'mod+z'`, …), shown formatted on the row. */
  shortcut?: string;
  run(): void;
}

/**
 * The key that opens the palette: a bare letter, so it is reachable with the
 * hand that is not on the mouse — the point of the thing. Registered on both
 * shortcut managers (see main.ts) so whichever one is live owns it, and
 * inside a sketch it waits out the chord timeout in case `sy` (Symmetric)
 * was meant, exactly as `c` waits for `ca`/`cc`/`cl`/`cn`/`cp`.
 *
 * Bound to {@link CommandPalette.open}, not a toggle: once the palette is up
 * the key belongs to the search box, so a query can contain the letter.
 */
export const COMMAND_PALETTE_SHORTCUT = 's';

/**
 * The combo that does the same thing, kept alongside the letter: it is what
 * every other editor binds this to, and it still works where the letter
 * cannot — inside a text field, and without waiting on the chord timeout.
 */
export const COMMAND_PALETTE_COMBO = 'mod+k';

/**
 * Generous because the list scrolls and the command set is bounded (unlike
 * quick-open's, which filters a workspace of unknown size) — a cap tight
 * enough to bite would silently drop commands rather than shorten a list.
 */
const MAX_RESULTS = 50;

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
  private list: HTMLElement | null = null;
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
    this.list = null;
    document.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
    document.removeEventListener('keydown', this.onDocumentKeyDown, true);
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
    this.list = list;
    this.commands = this.getCommands();
    this.query = '';
    this.highlighted = 0;
    document.addEventListener('pointerdown', this.onDocumentPointerDown, true);
    document.addEventListener('keydown', this.onDocumentKeyDown, true);

    input.addEventListener('input', () => {
      this.query = input.value;
      this.highlighted = 0;
      this.renderResults(list);
    });
    input.focus();

    this.renderResults(list);
  }

  private readonly onDocumentPointerDown = (event: PointerEvent): void => {
    if (this.popover && !this.popover.contains(event.target as Node)) {
      this.close();
    }
  };

  /**
   * Capture phase on the document, like the app's other overlays (settings,
   * share, the confirm dialog), and every key handled here stops propagating.
   * A key the palette acts on is spent: the modify-pick panel applies its
   * feature on any document-level Enter, and it and the sketch toolbar both
   * back out on any Escape — so an Enter that picked "Fillet" would otherwise
   * apply the fillet it just opened, and an Escape that dismissed the palette
   * would also close whatever dialog or tool sat behind it. Listening on the
   * document rather than the input also keeps the keys working once focus
   * has moved onto a result row.
   */
  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    const list = this.list;
    if (!list) {
      return;
    }
    // The opening combo, handled here rather than by the ShortcutManager that
    // registered it: that manager stands down inside an `<input>`
    // (`isEditableTarget`), so while the palette holds focus the key would
    // otherwise be neither acted on nor consumed — leaving the browser to
    // take it for the address bar, or the VSCode host to open a Ctrl+K chord.
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      if (this.results.length > 0) {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        this.highlighted = (this.highlighted + step + this.results.length) % this.results.length;
        this.renderResults(list);
      }
      return;
    }
    // An IME's Enter commits the composition; it is not a pick.
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      this.activate(this.highlighted);
    }
  };

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

    // Sized well above quick-open's 3.5: that list draws inline SVG, these are
    // the toolbar's PNGs, authored for its w-7 buttons and muddy when halved.
    const icon = document.createElement('span');
    icon.className = 'shrink-0 size-5 flex items-center justify-center';
    if (command.icon) {
      icon.innerHTML = `<img src="${command.icon}" ${ICON_IMG_FALLBACK} class="size-5 object-contain" alt="" />`;
    }
    row.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'flex-1 min-w-0 truncate';
    label.textContent = command.label;
    if (command.detail) {
      const detail = document.createElement('span');
      detail.className = 'ml-1.5 text-xs text-base-content/40';
      detail.textContent = command.detail;
      label.appendChild(detail);
    }
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
