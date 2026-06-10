import type { Point, ToolShape } from '@/types'
import { salientPoints, projectOntoShape } from '@/lib/shapes'

export interface SnapIndicator {
  point?: Point // matched snap point (tool space mm)
  axisX?: number // vertical alignment guide at this x
  axisY?: number // horizontal alignment guide at this y
}

export interface SnapResult {
  x: number
  y: number
  indicator: SnapIndicator | null
}

/**
 * Snap a shape being dragged to (candidateX, candidateY).
 * Precedence: salient point-to-point > guide edge projection > axis alignment > grid.
 * Pass gridMm = null for grid off; bypass entirely (Alt) by not calling this.
 */
export function snapShapePosition(
  dragged: ToolShape,
  candidateX: number,
  candidateY: number,
  others: ToolShape[],
  gridMm: number | null,
  thresholdMm: number,
): SnapResult {
  const at = { ...dragged, x: candidateX, y: candidateY }
  const myPoints = salientPoints(at)
  const targets: Point[] = [{ x: 0, y: 0 }]
  for (const s of others) targets.push(...salientPoints(s))

  // point-to-point
  let best: { d: number; dx: number; dy: number; target: Point } | null = null
  for (const mp of myPoints) {
    for (const t of targets) {
      const d = Math.hypot(t.x - mp.x, t.y - mp.y)
      if (d < thresholdMm && (!best || d < best.d)) {
        best = { d, dx: t.x - mp.x, dy: t.y - mp.y, target: t }
      }
    }
  }
  if (best) {
    return { x: candidateX + best.dx, y: candidateY + best.dy, indicator: { point: best.target } }
  }

  // projection onto guide edges (lines, circles, guide rects)
  const guides = others.filter((s) => s.mode === 'guide')
  let bestProj: { d: number; dx: number; dy: number; target: Point } | null = null
  for (const g of guides) {
    for (const mp of myPoints) {
      const q = projectOntoShape(g, mp)
      if (!q) continue
      const d = Math.hypot(q.x - mp.x, q.y - mp.y)
      if (d < thresholdMm && (!bestProj || d < bestProj.d)) {
        bestProj = { d, dx: q.x - mp.x, dy: q.y - mp.y, target: q }
      }
    }
  }
  if (bestProj) {
    return {
      x: candidateX + bestProj.dx,
      y: candidateY + bestProj.dy,
      indicator: { point: bestProj.target },
    }
  }

  // single-axis center alignment
  let x = candidateX
  let y = candidateY
  const indicator: SnapIndicator = {}
  let bestAx = thresholdMm
  let bestAy = thresholdMm
  for (const t of targets) {
    const dx = Math.abs(t.x - candidateX)
    if (dx < bestAx) {
      bestAx = dx
      x = t.x
      indicator.axisX = t.x
    }
    const dy = Math.abs(t.y - candidateY)
    if (dy < bestAy) {
      bestAy = dy
      y = t.y
      indicator.axisY = t.y
    }
  }

  // grid on whichever axes didn't axis-snap
  if (gridMm) {
    if (indicator.axisX === undefined) x = Math.round(x / gridMm) * gridMm
    if (indicator.axisY === undefined) y = Math.round(y / gridMm) * gridMm
  }

  const hasIndicator = indicator.axisX !== undefined || indicator.axisY !== undefined
  return { x, y, indicator: hasIndicator ? indicator : null }
}

/** rotation snapping: 15-degree detents within a few degrees */
export function snapRotation(deg: number, enabled: boolean): number {
  if (!enabled) return normalizeDeg(deg)
  const detent = Math.round(deg / 15) * 15
  if (Math.abs(deg - detent) < 4) return normalizeDeg(detent)
  return normalizeDeg(deg)
}

function normalizeDeg(deg: number): number {
  let d = deg % 360
  if (d > 180) d -= 360
  if (d < -180) d += 360
  return Number(d.toFixed(1))
}
