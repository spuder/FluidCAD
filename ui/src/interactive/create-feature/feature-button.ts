import { ICON_IMG_FALLBACK } from '../../ui/object-icons';
import { TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_BASE, TOOLBAR_BTN_ICON, TOOLBAR_BTN_LABEL } from '../../ui/toolbar-styles';

/**
 * The toolbar button every feature service registers: an icon with a muted
 * caption inside a daisyUI tooltip wrapper (which hides with the button so
 * no phantom toolbar gap), toggling armed styling. The service owns the
 * enter/exit toggle via `onClick`.
 *
 * The button also tracks its own visible/disabled/active state and emits
 * {@link onStateChange} on every transition, so another surface can mirror
 * it and delegate clicks straight back through {@link click} — every
 * service's coordination then runs unchanged whichever surface was clicked.
 */
export class FeatureButton {
  /**
   * Every feature button ever built, in construction order — the command
   * palette's source for the part workbench, the way `SketchToolbar`'s own
   * list is its source for the sketcher. A registry rather than sixteen
   * services each publishing their button: they all already funnel through
   * this constructor, and the class exposes everything a palette row needs
   * (label, icon, reachability, and a {@link click} that runs the service's
   * coordination unchanged).
   *
   * Buttons live as long as the app does, so nothing is ever removed.
   */
  private static readonly registry: FeatureButton[] = [];

  onClick?: () => void;
  /** Fired whenever `visible`, `disabled`, or `active` changes. */
  onStateChange?: () => void;

  private readonly button: HTMLButtonElement;
  private readonly wrap: HTMLElement;
  private readonly icon: string;
  private readonly label: string;
  private _visible: boolean;
  private _disabled = false;
  private _active = false;

  constructor(group: HTMLElement, opts: {
    icon: string;
    label: string;
    tip: string;
    ariaLabel: string;
    /** `data-tool` marker on the wrapper — an anchor for sibling buttons. */
    datasetTool?: string;
    /** Prepend to the group instead of appending (the Plane button). */
    prepend?: boolean;
    /** Insert before this element instead of appending (the Shell button). */
    insertBefore?: Element | null;
    /** Start hidden (buttons gated on the first render's scene). */
    hidden?: boolean;
  }) {
    this.icon = opts.icon;
    this.label = opts.label;
    this.button = document.createElement('button');
    this.button.className = TOOLBAR_BTN_BASE;
    this.button.setAttribute('aria-label', opts.ariaLabel);
    this.button.innerHTML = `<img src="${opts.icon}" ${ICON_IMG_FALLBACK} class="${TOOLBAR_BTN_ICON}" alt="" /><span class="${TOOLBAR_BTN_LABEL}">${opts.label}</span>`;
    this.button.addEventListener('click', () => this.onClick?.());
    this.wrap = document.createElement('span');
    this.wrap.className = 'tooltip tooltip-bottom shrink-0';
    this.wrap.dataset.tip = opts.tip;
    if (opts.datasetTool) {
      this.wrap.dataset.tool = opts.datasetTool;
    }
    this.wrap.appendChild(this.button);
    this._visible = !opts.hidden;
    if (opts.hidden) {
      this.wrap.classList.add('hidden');
    }
    if (opts.prepend) {
      group.prepend(this.wrap);
    } else if (opts.insertBefore !== undefined) {
      group.insertBefore(this.wrap, opts.insertBefore);
    } else {
      group.appendChild(this.wrap);
    }
    FeatureButton.registry.push(this);
  }

  /**
   * The feature buttons a user could press right now: shown, enabled, and in
   * a navbar group the current workbench actually displays (the navbar hides
   * a group by putting `hidden` on its host, so an ancestor carrying it means
   * this button is off-bench). Create buttons hidden while a sketch is being
   * edited ({@link setSketchHidden}) are off the list too: Finish Sketch owns
   * that group until the sketch closes.
   */
  static reachable(): FeatureButton[] {
    return FeatureButton.registry.filter(
      (button) =>
        button._visible &&
        !button._disabled &&
        !button.wrap.classList.contains('feature-sketch-hidden') &&
        button.wrap.closest('.hidden') === null,
    );
  }

  /** Drop every registered button. Tests only — the app never unbuilds one. */
  static clearRegistry(): void {
    FeatureButton.registry.length = 0;
  }

  /** The button's icon URL, for surfaces that mirror the button. */
  get iconSrc(): string {
    return this.icon;
  }

  /** The button's caption, for surfaces that mirror the button. */
  get labelText(): string {
    return this.label;
  }

  get visible(): boolean {
    return this._visible;
  }

  get disabled(): boolean {
    return this._disabled;
  }

  get active(): boolean {
    return this._active;
  }

  /**
   * Programmatically trigger the button: runs exactly what a toolbar click
   * would (enter/exit plus every `onEnter` hook in main.ts).
   */
  click(): void {
    this.button.click();
  }

  setDisabled(disabled: boolean): void {
    if (this._disabled === disabled) {
      return;
    }
    this._disabled = disabled;
    this.button.disabled = disabled;
    this.onStateChange?.();
  }

  setActive(active: boolean): void {
    if (this._active === active) {
      return;
    }
    this._active = active;
    this.button.className = active ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_BASE;
    this.onStateChange?.();
  }

  setVisible(visible: boolean): void {
    if (this._visible === visible) {
      return;
    }
    this._visible = visible;
    this.wrap.classList.toggle('hidden', !visible);
    this.onStateChange?.();
  }

  /**
   * Hide (or restore) this button while a sketch is being edited — the
   * Finish Sketch button owns the create group then. It rides a separate
   * class from {@link setVisible} so the owning service's per-render
   * visibility updates keep flowing underneath: leaving sketch mode drops
   * back to whatever `visible` currently says.
   */
  setSketchHidden(hidden: boolean): void {
    this.wrap.classList.toggle('feature-sketch-hidden', hidden);
  }
}
