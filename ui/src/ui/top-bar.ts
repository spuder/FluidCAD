import { FileTabs, type FileTab, type FileTabsHandlers } from '../editor/tabs';
import { TopBarActions, type TopBarAction, type TopBarActionHandlers } from './top-bar-actions';
import type { SceneObjectRender, SerializedAssembly } from '../types';

export interface TopBarHandlers extends TopBarActionHandlers {
  /** Tab interactions. Absent on a viewport-only host — see {@link TopBar.setFileName}. */
  tabs?: FileTabsHandlers;
  /**
   * Runs before the brand link leaves for the host's project picker (see the
   * `fluidcad-home` meta tag); it saves unsaved buffers so leaving loses
   * nothing. A rejection keeps the page unless the user chooses to leave.
   */
  beforeLeave?: () => Promise<void>;
}

/**
 * The top application bar (Onshape-inspired): logo + wordmark, the workspace
 * name, the open files as tabs, and the document-wide actions the tabs leave
 * room for on the right — Import, Export and the light/dark toggle
 * ({@link TopBarActions}, which collapses them into one menu on a narrow
 * window).
 *
 * Panel toggles are not among those actions: they are latch buttons on the
 * PanelRail now, beside the panels they open. And there is no file tree here
 * or anywhere: files are tabs, added with `+`
 * (`docs/desktop/05-editor-surface-design.md`).
 */
export class TopBar {
  private readonly el: HTMLDivElement;
  private readonly tabs: FileTabs;
  private readonly actions: TopBarActions;
  private readonly workspaceName: HTMLSpanElement;

  constructor(container: HTMLElement, handlers: TopBarHandlers) {
    this.el = document.createElement('div');
    this.el.className =
      // z sits one above the navbar's z-[120] — both are stacking contexts and
      // the navbar is later in the DOM, so the Export dropdown, which hangs
      // below this bar, would otherwise paint underneath it.
      'absolute top-0 left-0 right-0 h-12 z-[121] flex items-center gap-2 px-3 ' +
      'panel-bg border-b border-base-content/10 select-none';

    // Logo + wordmark. A host that serves this page as one of several
    // projects (`fluidcad hub`) names its picker in a `fluidcad-home` meta
    // tag, and the brand becomes the way back to it.
    const home = document.querySelector<HTMLMetaElement>('meta[name="fluidcad-home"]')?.content;
    const brand: HTMLElement = home ? document.createElement('a') : document.createElement('div');
    brand.className = 'flex items-center gap-1.5 shrink-0';
    if (home && brand instanceof HTMLAnchorElement) {
      brand.href = home;
      brand.title = 'All projects';
      brand.classList.add('cursor-pointer', 'hover:opacity-80');
      brand.addEventListener('click', (event) => {
        // Modified clicks (new tab/window) leave this page alone.
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
          return;
        }
        event.preventDefault();
        void (async () => {
          try {
            await handlers.beforeLeave?.();
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            if (!window.confirm(`Saving failed (${reason}). Leave anyway and lose unsaved changes?`)) {
              return;
            }
          }
          window.location.href = (brand as HTMLAnchorElement).href;
        })();
      });
    }
    brand.innerHTML = `
      <img src="logo.svg" alt="FluidCAD" class="h-8 w-8 shrink-0" />
      <span class="text-[17px] font-bold text-base-content/80 tracking-tight">FluidCAD</span>
    `;
    this.el.appendChild(brand);

    // Divider — the brand on one side, the open document on the other.
    const divider = document.createElement('div');
    divider.className = 'w-px h-5 bg-base-content/15 mx-1 shrink-0';
    this.el.appendChild(divider);

    // Workspace folder name, ahead of the tabs — the document the tabs are
    // pages of. Hidden until a host that knows its workspace names it.
    this.workspaceName = document.createElement('span');
    this.workspaceName.className =
      'hidden text-[17px] font-semibold text-base-content/80 tracking-tight truncate max-w-[20vw] shrink-0 mr-1';
    this.el.appendChild(this.workspaceName);

    this.tabs = new FileTabs(this.el, handlers.tabs ?? NO_TABS, handlers.tabs !== undefined);
    this.actions = new TopBarActions(this.el, handlers);

    container.appendChild(this.el);
  }

  /** The plain label a viewport-only host shows instead of tabs. */
  setFileName(absPath: string): void {
    this.tabs.setFileName(absPath);
  }

  /** The workspace's folder name, shown ahead of the tabs. */
  setWorkspaceName(name: string): void {
    this.workspaceName.textContent = name;
    this.workspaceName.classList.toggle('hidden', name === '');
  }

  /** Add a host's own bar button, ahead of the shared ones and styled like them. */
  addAction(action: TopBarAction): HTMLButtonElement {
    return this.actions.addAction(action);
  }

  /** New scene: refresh what the Export dropdown lists — see {@link TopBarActions.updateSolids}. */
  updateSolids(objects: SceneObjectRender[], assembly?: SerializedAssembly): void {
    this.actions.updateSolids(objects, assembly);
  }

  /** Where a menu-invoked quick-open should hang from. */
  get tabAddAnchor(): HTMLElement {
    return this.tabs.addAnchor;
  }

  setTabs(tabs: FileTab[], activePath: string | null, currentModelPath: string | null): void {
    this.tabs.setTabs(tabs, activePath, currentModelPath);
  }
}

/** Stand-in for a host with no tabs; never reached, since none are rendered. */
const NO_TABS: FileTabsHandlers = {
  onActivate: () => undefined,
};
