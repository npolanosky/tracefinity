'use client'

import type { Point } from '@/types'
import { signedArea, edgeMidpointNormal, interiorAngleDeg, interiorBisector } from '@/lib/svg'

interface Props {
  points: Point[]
  holes?: Point[][]
  /** multiply SVG-unit distances by this to get mm */
  mmPerUnit: number
  /** scales fonts/offsets so labels stay readable at any canvas size */
  uiScale: number
}

const MAX_EDGE_LABELS = 120

function formatMm(mm: number): string {
  return mm >= 10 ? mm.toFixed(1) : mm.toFixed(2)
}

function RingMeasurements({ points, mmPerUnit, uiScale }: { points: Point[]; mmPerUnit: number; uiScale: number }) {
  if (points.length < 3) return null

  const ccw = signedArea(points) > 0
  const n = points.length
  const minEdgeLen = 24 * uiScale

  const edges = points.map((p, i) => {
    const q = points[(i + 1) % n]
    const len = Math.hypot(q.x - p.x, q.y - p.y)
    return { i, p, q, len }
  })

  const shown = new Set(
    edges
      .filter((e) => e.len >= minEdgeLen)
      .sort((a, b) => b.len - a.len)
      .slice(0, MAX_EDGE_LABELS)
      .map((e) => e.i)
  )

  const fontSize = 11 * uiScale
  const halo: React.CSSProperties = {
    paintOrder: 'stroke',
    stroke: 'rgba(24, 24, 27, 0.85)',
    strokeWidth: 3 * uiScale,
    strokeLinejoin: 'round',
  }

  return (
    <g className="pointer-events-none select-none">
      {edges.map((e) => {
        if (!shown.has(e.i)) return null
        const { mid, normal } = edgeMidpointNormal(e.p, e.q, ccw)
        const x = mid.x + normal.x * 10 * uiScale
        const y = mid.y + normal.y * 10 * uiScale
        let deg = (Math.atan2(e.q.y - e.p.y, e.q.x - e.p.x) * 180) / Math.PI
        if (deg > 90) deg -= 180
        if (deg < -90) deg += 180
        return (
          <text
            key={`e${e.i}`}
            x={x}
            y={y}
            transform={`rotate(${deg} ${x} ${y})`}
            fontSize={fontSize}
            fill="rgb(125, 211, 252)"
            textAnchor="middle"
            dominantBaseline="central"
            style={halo}
          >
            {formatMm(e.len * mmPerUnit)}
          </text>
        )
      })}
      {points.map((v, i) => {
        // angle label only where both adjacent edges are labeled, to limit clutter
        const prevEdge = (i - 1 + n) % n
        if (!shown.has(prevEdge) || !shown.has(i)) return null
        const prev = points[prevEdge]
        const next = points[(i + 1) % n]
        const angle = interiorAngleDeg(prev, v, next, ccw)
        if (angle > 178 && angle < 182) return null // collinear trace noise
        const bis = interiorBisector(prev, v, next, ccw)
        const x = v.x + bis.x * 14 * uiScale
        const y = v.y + bis.y * 14 * uiScale
        return (
          <text
            key={`a${i}`}
            x={x}
            y={y}
            fontSize={fontSize}
            fill="rgb(253, 224, 71)"
            textAnchor="middle"
            dominantBaseline="central"
            style={halo}
          >
            {Math.round(angle)}&deg;
          </text>
        )
      })}
    </g>
  )
}

/**
 * SVG overlay showing edge lengths (mm) and interior vertex angles for a
 * polygon ring and its holes. Coordinate-system agnostic: the host passes
 * points in its own SVG units plus the unit->mm factor.
 */
export function MeasurementOverlay({ points, holes, mmPerUnit, uiScale }: Props) {
  return (
    <>
      <RingMeasurements points={points} mmPerUnit={mmPerUnit} uiScale={uiScale} />
      {(holes ?? []).map((hole, i) => (
        <RingMeasurements key={i} points={hole} mmPerUnit={mmPerUnit} uiScale={uiScale} />
      ))}
    </>
  )
}
