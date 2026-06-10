import type { Point, ToolShape, ToolShapeMode, ToolShapeType } from '@/types'

let shapeCounter = 0

export function makeShape(type: ToolShapeType, mode: ToolShapeMode = 'add'): ToolShape {
  const id = `shape-${Date.now().toString(36)}-${shapeCounter++}`
  switch (type) {
    case 'rectangle':
      return { id, type, mode, x: 0, y: 0, rotation: 0, width: 40, height: 40, corner_radius: 0 }
    case 'ellipse':
      return { id, type, mode, x: 0, y: 0, rotation: 0, rx: 10, ry: 10 }
    case 'line':
      return { id, type, mode: 'guide', x: 0, y: 0, rotation: 0, width: 50 }
  }
}

export function duplicateShape(shape: ToolShape): ToolShape {
  return { ...shape, id: `shape-${Date.now().toString(36)}-${shapeCounter++}`, x: shape.x + 5, y: shape.y + 5 }
}

export function rotatePoint(p: Point, deg: number): Point {
  const rad = (deg * Math.PI) / 180
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c }
}

function toWorld(shape: ToolShape, local: Point): Point {
  const r = rotatePoint(local, shape.rotation)
  return { x: shape.x + r.x, y: shape.y + r.y }
}

/** points other shapes can snap to: center, corners, edge midpoints, quadrants, endpoints */
export function salientPoints(shape: ToolShape): Point[] {
  const pts: Point[] = [{ x: shape.x, y: shape.y }]
  if (shape.type === 'rectangle') {
    const hw = (shape.width ?? 0) / 2
    const hh = (shape.height ?? 0) / 2
    for (const [lx, ly] of [
      [-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh], // corners
      [0, -hh], [hw, 0], [0, hh], [-hw, 0], // edge midpoints
    ]) {
      pts.push(toWorld(shape, { x: lx, y: ly }))
    }
  } else if (shape.type === 'ellipse') {
    const rx = shape.rx ?? 0
    const ry = shape.ry ?? 0
    for (const [lx, ly] of [[rx, 0], [-rx, 0], [0, ry], [0, -ry]]) {
      pts.push(toWorld(shape, { x: lx, y: ly }))
    }
  } else if (shape.type === 'line') {
    const hl = (shape.width ?? 0) / 2
    pts.push(toWorld(shape, { x: -hl, y: 0 }))
    pts.push(toWorld(shape, { x: hl, y: 0 }))
  }
  return pts
}

/** axis-aligned bounds in tool space, accounting for rotation */
export function shapeBounds(shape: ToolShape): { minX: number; minY: number; maxX: number; maxY: number } {
  let corners: Point[]
  if (shape.type === 'rectangle') {
    const hw = (shape.width ?? 0) / 2
    const hh = (shape.height ?? 0) / 2
    corners = [
      toWorld(shape, { x: -hw, y: -hh }),
      toWorld(shape, { x: hw, y: -hh }),
      toWorld(shape, { x: hw, y: hh }),
      toWorld(shape, { x: -hw, y: hh }),
    ]
  } else if (shape.type === 'ellipse') {
    // bbox of a rotated ellipse
    const rx = shape.rx ?? 0
    const ry = shape.ry ?? 0
    const rad = (shape.rotation * Math.PI) / 180
    const ex = Math.sqrt((rx * Math.cos(rad)) ** 2 + (ry * Math.sin(rad)) ** 2)
    const ey = Math.sqrt((rx * Math.sin(rad)) ** 2 + (ry * Math.cos(rad)) ** 2)
    return { minX: shape.x - ex, minY: shape.y - ey, maxX: shape.x + ex, maxY: shape.y + ey }
  } else {
    const hl = (shape.width ?? 0) / 2
    corners = [toWorld(shape, { x: -hl, y: 0 }), toWorld(shape, { x: hl, y: 0 })]
  }
  const xs = corners.map((p) => p.x)
  const ys = corners.map((p) => p.y)
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
}

/** nearest point on the shape's edge/curve to p (used for guide projection snapping) */
export function projectOntoShape(shape: ToolShape, p: Point): Point | null {
  // work in the shape's local frame
  const rel = rotatePoint({ x: p.x - shape.x, y: p.y - shape.y }, -shape.rotation)

  let local: Point | null = null
  if (shape.type === 'line') {
    const hl = (shape.width ?? 0) / 2
    local = { x: Math.max(-hl, Math.min(hl, rel.x)), y: 0 }
  } else if (shape.type === 'ellipse') {
    const rx = shape.rx ?? 0
    const ry = shape.ry ?? 0
    if (rx <= 0 || ry <= 0) return null
    // radial projection (exact for circles, good approximation for ellipses)
    const a = Math.atan2(rel.y / ry, rel.x / rx)
    local = { x: rx * Math.cos(a), y: ry * Math.sin(a) }
  } else if (shape.type === 'rectangle') {
    const hw = (shape.width ?? 0) / 2
    const hh = (shape.height ?? 0) / 2
    // nearest point on the rectangle's perimeter
    const cx = Math.max(-hw, Math.min(hw, rel.x))
    const cy = Math.max(-hh, Math.min(hh, rel.y))
    if (Math.abs(cx) !== hw && Math.abs(cy) !== hh) {
      // inside: push to the nearest edge
      const dxEdge = hw - Math.abs(cx)
      const dyEdge = hh - Math.abs(cy)
      if (dxEdge < dyEdge) local = { x: Math.sign(cx || 1) * hw, y: cy }
      else local = { x: cx, y: Math.sign(cy || 1) * hh }
    } else {
      local = { x: cx, y: cy }
    }
  }
  if (!local) return null
  const w = rotatePoint(local, shape.rotation)
  return { x: shape.x + w.x, y: shape.y + w.y }
}

export function shapeDisplayName(shape: ToolShape): string {
  if (shape.type === 'rectangle') return `Rect ${fmt(shape.width)}×${fmt(shape.height)}`
  if (shape.type === 'ellipse') {
    if (shape.rx === shape.ry) return `Circle ⌀${fmt((shape.rx ?? 0) * 2)}`
    return `Ellipse ${fmt((shape.rx ?? 0) * 2)}×${fmt((shape.ry ?? 0) * 2)}`
  }
  return `Guide line ${fmt(shape.width)}`
}

function fmt(v: number | null | undefined): string {
  return String(Number((v ?? 0).toFixed(2)))
}
