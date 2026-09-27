/**
 * Base every feature/shape PNG under `public/icons/` is served from, fixed at
 * build time. The app build uses a relative `icons/` so the page keeps working
 * behind a path prefix (e.g. a hub at `/p/<name>/`); the `fluidcad/viewer-ui`
 * library build keeps the absolute `/icons/` its hosts rely on, since they may
 * render at arbitrarily deep paths. Unset (vitest runs source directly) falls
 * back to the app's relative base.
 */
const ICON_BASE: string =
  typeof __FLUIDCAD_ICON_BASE__ !== 'undefined' ? __FLUIDCAD_ICON_BASE__ : 'icons/';

/** URL of the icon PNG `name` (no extension), e.g. `iconUrl('extrude')`. */
export function iconUrl(name: string): string {
  return `${ICON_BASE}${name}.png`;
}
