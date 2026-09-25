import { describe, it, expect } from 'vitest';
import {
  bezierControlBindings,
  liveBezierControlPoints,
  tessellateBezier,
} from '../src/sketch-solver-client/bezier-preview';
import type { SolvedEntityView, SolvedSketchModel } from '../src/sketch-solver-client/model';

function modelWith(entities: SolvedEntityView[]): SolvedSketchModel {
  return {
    sketch: {} as any,
    plane: {} as any,
    solver: null,
    entities: new Map(entities.map(e => [e.entityId, e])),
    constraints: [],
    hasDatums: false,
    conflictingEntityIds: new Set(),
    constrainedEntityIds: new Set(),
    referenceProducers: new Map(),
    derivedProducers: new Map(),
    dof: null,
    outcome: null,
    fullyConstrained: false,
    conflictCount: 0,
    redundantCount: 0,
  };
}

function bezierObj(object: Record<string, unknown>): any {
  return { id: 'bz', uniqueType: 'bezier-3', type: 'bezier', object, sceneShapes: [] };
}

describe('tessellateBezier', () => {
  it('hits the end poles and the quadratic midpoint', () => {
    const pts = tessellateBezier([[0, 0], [5, 10], [10, 0]], 4)!;
    expect(pts).toHaveLength(5);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[4]).toEqual([10, 0]);
    // B(0.5) = 0.25·P0 + 0.5·P1 + 0.25·P2
    expect(pts[2][0]).toBeCloseTo(5);
    expect(pts[2][1]).toBeCloseTo(5);
  });

  it('refuses fewer than two poles', () => {
    expect(tessellateBezier([[1, 1]], 8)).toBeNull();
  });
});

describe('bezier control bindings', () => {
  it('binds literal points to their anchors and accessor points by coincidence', () => {
    const model = modelWith([
      { entityId: 7, kind: 'point', point: [5, 10], obj: {} as any },
      { entityId: 8, kind: 'point', point: [10, 0], obj: {} as any },
      { entityId: 2, kind: 'line', start: [-5, 0], end: [0, 0], obj: {} as any },
    ]);
    const obj = bezierObj({
      startPoint: [0, 0],
      resolvedPoints: [[5, 10], [10, 0]],
      anchors: [
        { pointIndex: 1, entityId: 7 },
        { pointIndex: 2, entityId: 8 },
      ],
    });
    const bindings = bezierControlBindings(obj, model)!;
    expect(bindings.map(b => [b.entityId, b.role])).toEqual([
      [2, 'end'],
      [7, 'point'],
      [8, 'point'],
    ]);

    // A drag frame mutates the model in place — the poles follow.
    model.entities.get(7)!.point = [5, 20];
    model.entities.get(2)!.end = [1, 1];
    expect(liveBezierControlPoints(bindings, model)).toEqual([[1, 1], [5, 20], [10, 0]]);
  });

  it('leaves unbound points at their payload position', () => {
    const obj = bezierObj({ startPoint: [0, 0], resolvedPoints: [[3, 3], [6, 0]] });
    const bindings = bezierControlBindings(obj, modelWith([]))!;
    expect(liveBezierControlPoints(bindings, modelWith([]))).toEqual([[0, 0], [3, 3], [6, 0]]);
  });

  it('ignores non-bezier statements', () => {
    expect(bezierControlBindings({ uniqueType: 'line', object: {} } as any, null)).toBeNull();
  });
});
