import { describe, expect, it } from 'vitest'
import { arrangeTools, type ToolPadInfo } from './packing'
import type { BinConfig, PlacedTool } from '@/types'

function makeConfig(overrides: Partial<BinConfig> = {}): BinConfig {
  return {
    grid_x: 2,
    grid_y: 2,
    grid_unit_x_mm: 42,
    grid_unit_y_mm: 42,
    grid_unit_locked: true,
    height_units: 4,
    magnets: true,
    magnet_diameter: 6,
    magnet_depth: 2.4,
    magnet_corners_only: false,
    stacking_lip: true,
    rim_units: 0,
    wall_thickness: 1.6,
    cutout_depth: 20,
    cutout_clearance: 1.0,
    cutout_chamfer: 0,
    tool_spacing: 0,
    insert_enabled: false,
    insert_height: 1.0,
    insert_clearance: 0.2,
    text_labels: [],
    bed_size: 256,
    ...overrides,
  }
}

function makeSquare(id: string, toolId: string, size: number): PlacedTool {
  return {
    id,
    tool_id: toolId,
    name: id,
    points: [
      { x: 0, y: 0 },
      { x: size, y: 0 },
      { x: size, y: size },
      { x: 0, y: size },
    ],
    finger_holes: [],
    interior_rings: [],
    rotation: 0,
  }
}

function bounds(pt: PlacedTool) {
  const xs = pt.points.map((p) => p.x)
  const ys = pt.points.map((p) => p.y)
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  }
}

/** outline-to-outline gap between two tools along whichever axis separates them */
function outlineGap(a: PlacedTool, b: PlacedTool): number {
  const ba = bounds(a)
  const bb = bounds(b)
  const dx = Math.max(bb.minX - ba.maxX, ba.minX - bb.maxX)
  const dy = Math.max(bb.minY - ba.maxY, ba.minY - bb.maxY)
  return Math.max(dx, dy)
}

const WEB = 1.6 // max(1.2, wall_thickness 1.6)

describe('arrangeTools spacing', () => {
  it('legacy gap without spacing matches 2*clearance + web', () => {
    const config = makeConfig()
    const result = arrangeTools(
      [makeSquare('a', 't1', 30), makeSquare('b', 't2', 30)],
      config,
      false,
    )!
    expect(result.unplacedIds).toEqual([])
    const [a, b] = result.tools
    expect(outlineGap(a, b)).toBeCloseTo(2 * 1.0 + WEB, 5)
  })

  it('per-tool spacing widens the gap by both tools\' spacing', () => {
    const config = makeConfig()
    const toolInfo = new Map<string, ToolPadInfo>([
      ['t1', { spacing: 3.25 }],
      ['t2', { spacing: 3.25 }],
    ])
    const result = arrangeTools(
      [makeSquare('a', 't1', 20), makeSquare('b', 't2', 20)],
      config,
      false,
      toolInfo,
    )!
    expect(result.unplacedIds).toEqual([])
    const [a, b] = result.tools
    expect(outlineGap(a, b)).toBeCloseTo(2 * 1.0 + 2 * 3.25 + WEB, 5)
  })

  it('bin tool_spacing applies to tools without an override', () => {
    const config = makeConfig({ tool_spacing: 2 })
    const toolInfo = new Map<string, ToolPadInfo>([
      ['t1', { spacing: 3.25 }],
      ['t2', {}],
    ])
    const result = arrangeTools(
      [makeSquare('a', 't1', 20), makeSquare('b', 't2', 20)],
      config,
      false,
      toolInfo,
    )!
    const [a, b] = result.tools
    // clr_a + sp_a + clr_b + sp_b + web
    expect(outlineGap(a, b)).toBeCloseTo(1.0 + 3.25 + 1.0 + 2 + WEB, 5)
  })

  it('keeps the outline clear of the bin wall by edge + pad', () => {
    const config = makeConfig()
    const toolInfo = new Map<string, ToolPadInfo>([['t1', { spacing: 3.25 }]])
    const result = arrangeTools([makeSquare('a', 't1', 20)], config, false, toolInfo)!
    const b = bounds(result.tools[0])
    const edge = config.wall_thickness + 0.25
    const pad = config.cutout_clearance + 3.25 + WEB / 2
    expect(b.minX).toBeCloseTo(edge + pad, 5)
    expect(b.minY).toBeCloseTo(edge + pad, 5)
  })

  it('clearance override composes with spacing in the pad', () => {
    const config = makeConfig()
    const toolInfo = new Map<string, ToolPadInfo>([
      ['t1', { clearance: 0, spacing: 5 }],
      ['t2', { clearance: 0, spacing: 5 }],
    ])
    const result = arrangeTools(
      [makeSquare('a', 't1', 20), makeSquare('b', 't2', 20)],
      config,
      false,
      toolInfo,
    )!
    const [a, b] = result.tools
    expect(outlineGap(a, b)).toBeCloseTo(0 + 5 + 0 + 5 + WEB, 5)
  })
})

