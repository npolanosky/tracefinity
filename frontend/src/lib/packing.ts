import type { PlacedTool, BinConfig } from '@/types'

/**
 * Top-down "palletizing" of placed tools: pack each tool's padded bounding
 * box into the smallest grid footprint that holds them all, optionally
 * allowing 90-degree rotation. Rectangle packing (shelf / first-fit
 * decreasing height) is deliberate -- the pocket web spacing means irregular
 * outlines rarely interlock, and bbox packing stays fast and predictable.
 */

const MAX_GRID = 10 // BinParams caps grid_x/grid_y at 10

interface PackItem {
  id: string
  w: number // padded bbox, mm
  h: number
}

interface Placement {
  x: number // padded bbox origin within the interior, mm
  y: number
  rotated: boolean
}

interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function toolBounds(pt: PlacedTool): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pt.points) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y)
  }
  for (const fh of pt.finger_holes) {
    const r = fh.shape === 'rectangle' ? Math.max(fh.width || 0, fh.height || 0) / 2 : fh.radius
    minX = Math.min(minX, fh.x - r); minY = Math.min(minY, fh.y - r)
    maxX = Math.max(maxX, fh.x + r); maxY = Math.max(maxY, fh.y + r)
  }
  return { minX, minY, maxX, maxY }
}

/**
 * Shelf packing into a fixed W x H. Returns placements for the items that
 * fit (greedy, biggest first); an item that doesn't fit is simply absent.
 */
function packShelves(
  items: PackItem[],
  binW: number,
  binH: number,
  allowRotation: boolean,
): Map<string, Placement> {
  // normalize to landscape when rotation is allowed; sort tallest first
  const oriented = items.map((it) => {
    const rotated = allowRotation && it.h > it.w
    return { id: it.id, w: rotated ? it.h : it.w, h: rotated ? it.w : it.h, rotated }
  })
  oriented.sort((a, b) => b.h - a.h || b.w - a.w)

  const placements = new Map<string, Placement>()
  const shelves: { y: number; height: number; xUsed: number }[] = []
  let nextY = 0

  for (const it of oriented) {
    let placed = false
    for (const shelf of shelves) {
      // try as-is, then the other orientation if rotation is allowed
      if (it.w <= binW - shelf.xUsed && it.h <= shelf.height) {
        placements.set(it.id, { x: shelf.xUsed, y: shelf.y, rotated: it.rotated })
        shelf.xUsed += it.w
        placed = true
        break
      }
      if (allowRotation && it.h <= binW - shelf.xUsed && it.w <= shelf.height) {
        placements.set(it.id, { x: shelf.xUsed, y: shelf.y, rotated: !it.rotated })
        shelf.xUsed += it.h
        placed = true
        break
      }
    }
    if (!placed) {
      // open a new shelf; prefer the orientation with the lower shelf height
      const fitsAsIs = it.h <= binH - nextY && it.w <= binW
      const fitsRotated = allowRotation && it.w <= binH - nextY && it.h <= binW
      if (fitsAsIs && (!fitsRotated || it.h <= it.w)) {
        shelves.push({ y: nextY, height: it.h, xUsed: it.w })
        placements.set(it.id, { x: 0, y: nextY, rotated: it.rotated })
        nextY += it.h
      } else if (fitsRotated) {
        shelves.push({ y: nextY, height: it.w, xUsed: it.h })
        placements.set(it.id, { x: 0, y: nextY, rotated: !it.rotated })
        nextY += it.w
      }
    }
  }
  return placements
}

export interface ArrangeResult {
  tools: PlacedTool[]
  gridX: number
  gridY: number
  unplacedIds: string[]
}

// per-tool padding inputs, keyed by PlacedTool.tool_id; null/undefined
// fields fall back to the bin's cutout_clearance / tool_spacing
export interface ToolPadInfo {
  clearance?: number | null
  spacing?: number | null
}

export function arrangeTools(
  placedTools: PlacedTool[],
  config: BinConfig,
  allowRotation: boolean,
  toolInfo?: Map<string, ToolPadInfo>,
): ArrangeResult | null {
  if (placedTools.length === 0) return null

  // distance from bin edge to the bbox must cover wall + clearance (matches
  // the auto-size margin); between two pockets we need both clearances plus
  // a printable web, so each padded box carries clearance + spacing + web/2
  // per side. spacing is a keep-out air gap for tools that overhang their
  // cutout; clearance is later baked into the pocket at STL time, so the
  // finished-pocket gap is spacing_a + spacing_b + web.
  const web = Math.max(1.2, config.wall_thickness)
  const edge = config.wall_thickness + 0.25

  const padById = new Map(placedTools.map((pt) => {
    const info = toolInfo?.get(pt.tool_id)
    const clr = info?.clearance ?? config.cutout_clearance
    const sp = info?.spacing ?? (config.tool_spacing ?? 0)
    return [pt.id, clr + sp + web / 2]
  }))

  const boundsById = new Map(placedTools.map((pt) => [pt.id, toolBounds(pt)]))
  const items: PackItem[] = placedTools.map((pt) => {
    const b = boundsById.get(pt.id)!
    const pad = padById.get(pt.id)!
    return { id: pt.id, w: b.maxX - b.minX + 2 * pad, h: b.maxY - b.minY + 2 * pad }
  })

  const gux = config.grid_unit_x_mm
  const guy = config.grid_unit_y_mm

  // candidate grids by footprint (cell count), squarer first on ties
  const candidates: { gx: number; gy: number }[] = []
  for (let gx = 1; gx <= MAX_GRID; gx++) {
    for (let gy = 1; gy <= MAX_GRID; gy++) candidates.push({ gx, gy })
  }
  candidates.sort(
    (a, b) =>
      a.gx * a.gy - b.gx * b.gy ||
      Math.abs(a.gx * gux - a.gy * guy) - Math.abs(b.gx * gux - b.gy * guy),
  )

  let best: { gx: number; gy: number; placements: Map<string, Placement> } | null = null
  for (const { gx, gy } of candidates) {
    const interiorW = gx * gux - 2 * edge
    const interiorH = gy * guy - 2 * edge
    if (interiorW <= 0 || interiorH <= 0) continue
    const placements = packShelves(items, interiorW, interiorH, allowRotation)
    if (placements.size === placedTools.length) {
      best = { gx, gy, placements }
      break
    }
    // remember the fullest fallback (prefer more placed, then fewer cells --
    // candidates iterate smallest-first so first max wins)
    if (!best || placements.size > best.placements.size) {
      best = { gx, gy, placements }
    }
  }
  if (!best) return null

  const unplacedIds: string[] = []
  const tools = placedTools.map((pt) => {
    const placement = best!.placements.get(pt.id)
    if (!placement) {
      unplacedIds.push(pt.id)
      return pt
    }
    const b = boundsById.get(pt.id)!
    let points = pt.points
    let fingerHoles = pt.finger_holes
    let rings = pt.interior_rings ?? []
    let rotation = pt.rotation || 0
    let bb = b

    if (placement.rotated) {
      // +90 degrees about the bbox centre; finger holes keep their own
      // rotation value to match sync_placed_tools' convention
      const cx = (b.minX + b.maxX) / 2
      const cy = (b.minY + b.maxY) / 2
      const rot = (x: number, y: number) => ({ x: cx - (y - cy), y: cy + (x - cx) })
      points = points.map((p) => rot(p.x, p.y))
      fingerHoles = fingerHoles.map((fh) => ({ ...fh, ...rot(fh.x, fh.y) }))
      rings = rings.map((ring) => ring.map((p) => rot(p.x, p.y)))
      rotation = (rotation + 90) % 360
      const halfW = (b.maxX - b.minX) / 2
      const halfH = (b.maxY - b.minY) / 2
      bb = { minX: cx - halfH, maxX: cx + halfH, minY: cy - halfW, maxY: cy + halfW }
    }

    const pad = padById.get(pt.id)!
    const dx = edge + placement.x + pad - bb.minX
    const dy = edge + placement.y + pad - bb.minY
    return {
      ...pt,
      points: points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
      finger_holes: fingerHoles.map((fh) => ({ ...fh, x: fh.x + dx, y: fh.y + dy })),
      interior_rings: rings.map((ring) => ring.map((p) => ({ x: p.x + dx, y: p.y + dy }))),
      rotation,
    }
  })

  return { tools, gridX: best.gx, gridY: best.gy, unplacedIds }
}
