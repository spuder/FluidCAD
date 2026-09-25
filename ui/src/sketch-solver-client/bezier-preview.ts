// Live drag preview for bezier curves. A bezier is not a solver entity — its
// literal control points are free solver points it owns (P8 anchors), and
// accessor-valued control points ride other entities' points. The drag loop
// moves those points; this module re-derives the curve (and its control
// polygon) from them each frame, so the curve follows the cursor instead of
// staying parked until the write-back re-render.

import type { SceneObjectRender } from '../types';
import type { SolvedSketchModel } from './model';
import type { Vec2 } from './resolve';

type PointRole = 'point' | 'start' | 'end' | 'center';

/** One control point: its payload position, plus the solver point it tracks
 * (absent when nothing in the model sits there — it then stays put). */
export type BezierControlBinding = {
  at: Vec2;
  entityId?: number;
  role?: PointRole;
};

/** A payload point sits on a model point within this distance (mm). */
const BIND_EPS = 1e-5;

/** Payload control points of a bezier statement, in pole order (start
 * first); null for anything else or an incomplete placeholder. */
export function bezierPayloadPoints(obj: SceneObjectRender): Vec2[] | null {
  if (!obj.uniqueType?.startsWith('bezier-')) {
    return null;
  }
  const start = obj.object?.startPoint as Vec2 | null | undefined;
  const rest = obj.object?.resolvedPoints as Vec2[] | undefined;
  const points: Vec2[] = [];
  if (start) {
    points.push([start[0], start[1]]);
  }
  for (const p of rest ?? []) {
    points.push([p[0], p[1]]);
  }
  return points;
}

/**
 * Bind every control point of a bezier statement to the solver point that
 * drives it: a literal control point to its own anchor entity (joined by
 * `anchors[].pointIndex`), an accessor-valued one (`line.end()`) to the
 * model point it coincides with. Null when the statement is not a bezier.
 */
export function bezierControlBindings(
  obj: SceneObjectRender,
  model: SolvedSketchModel | null,
): BezierControlBinding[] | null {
  const points = bezierPayloadPoints(obj);
  if (!points) {
    return null;
  }
  const anchorOf = new Map<number, number>();
  const anchors = obj.object?.anchors as { pointIndex: number; entityId: number }[] | undefined;
  if (Array.isArray(anchors)) {
    for (const a of anchors) {
      if (model?.entities.has(a.entityId)) {
        anchorOf.set(a.pointIndex, a.entityId);
      }
    }
  }
  return points.map((at, i) => {
    const anchor = anchorOf.get(i);
    if (anchor !== undefined) {
      return { at, entityId: anchor, role: 'point' as const };
    }
    const slot = model ? findPointSlot(model, at) : null;
    return slot ? { at, ...slot } : { at };
  });
}

function findPointSlot(model: SolvedSketchModel, at: Vec2): { entityId: number; role: PointRole } | null {
  for (const [entityId, e] of model.entities) {
    for (const role of ['point', 'start', 'end', 'center'] as const) {
      const p = e[role];
      if (p && Math.abs(p[0] - at[0]) < BIND_EPS && Math.abs(p[1] - at[1]) < BIND_EPS) {
        return { entityId, role };
      }
    }
  }
  return null;
}

/** Current control points: each bound point read from the (live-mutated)
 * model, unbound ones at their payload position. */
export function liveBezierControlPoints(
  bindings: BezierControlBinding[],
  model: SolvedSketchModel | null,
): Vec2[] {
  return bindings.map((b) => {
    if (b.entityId === undefined || !b.role || !model) {
      return b.at;
    }
    return model.entities.get(b.entityId)?.[b.role] ?? b.at;
  });
}

/** Polyline of `segments` segments along the Bezier curve with these poles
 * (de Casteljau). Null for fewer than two poles. */
export function tessellateBezier(poles: Vec2[], segments: number): Vec2[] | null {
  if (poles.length < 2 || segments < 1) {
    return null;
  }
  const out: Vec2[] = [];
  const work: Vec2[] = poles.map(p => [p[0], p[1]]);
  for (let s = 0; s <= segments; s++) {
    const t = s / segments;
    for (let i = 0; i < poles.length; i++) {
      work[i][0] = poles[i][0];
      work[i][1] = poles[i][1];
    }
    for (let k = poles.length - 1; k > 0; k--) {
      for (let i = 0; i < k; i++) {
        work[i][0] += (work[i + 1][0] - work[i][0]) * t;
        work[i][1] += (work[i + 1][1] - work[i][1]) * t;
      }
    }
    out.push([work[0][0], work[0][1]]);
  }
  return out;
}
