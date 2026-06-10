'use client'

import { RefObject } from 'react'
import type { Point, ToolShape } from '@/types'
import { polygonPathData } from '@/lib/svg'
import { DISPLAY_SCALE } from '@/lib/constants'
import { shapeBounds } from '@/lib/shapes'
import type { SnapIndicator } from '@/lib/shapeSnap'

const S = DISPLAY_SCALE

interface Props {
  svgRef: RefObject<SVGSVGElement | null>
  zvbX: number
  zvbY: number
  zvbW: number
  zvbH: number
  zoom: number
  gridMinX: number
  gridMaxX: number
  gridMinY: number
  gridMaxY: number
  gridStep: number

  shapes: ToolShape[]
  selectedId: string | null
  outlinePoints: Point[]
  outlineRings: Point[][]
  snapIndicator: SnapIndicator | null

  handleBackgroundClick: (e: React.MouseEvent) => void
  handleSvgMouseDown: (e: React.MouseEvent) => void
  handleShapeMouseDown: (id: string) => (e: React.MouseEvent) => void
  handleResizeMouseDown: (id: string) => (e: React.MouseEvent) => void
  handleRotateMouseDown: (id: string) => (e: React.MouseEvent) => void
}

function ShapeElement({ shape, zoom, selected }: { shape: ToolShape; zoom: number; selected: boolean }) {
  const sw = (selected ? 2.5 : 1.5) / zoom
  const stroke =
    shape.mode === 'guide'
      ? 'rgb(96, 165, 250)'
      : shape.mode === 'subtract'
        ? 'rgb(248, 113, 113)'
        : selected
          ? 'rgb(90, 180, 222)'
          : 'rgb(148, 163, 184)'
  const dash = shape.mode === 'guide' ? `${8 / zoom},${5 / zoom}` : shape.mode === 'subtract' ? `${5 / zoom},${3 / zoom}` : undefined
  const transform = `translate(${shape.x * S},${shape.y * S})${shape.rotation ? ` rotate(${shape.rotation})` : ''}`

  if (shape.type === 'rectangle') {
    const w = (shape.width ?? 0) * S
    const h = (shape.height ?? 0) * S
    const r = (shape.corner_radius ?? 0) * S
    return (
      <g transform={transform}>
        <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={r} ry={r} fill="none" stroke={stroke} strokeWidth={sw} strokeDasharray={dash} />
      </g>
    )
  }
  if (shape.type === 'ellipse') {
    return (
      <g transform={transform}>
        <ellipse rx={(shape.rx ?? 0) * S} ry={(shape.ry ?? 0) * S} fill="none" stroke={stroke} strokeWidth={sw} strokeDasharray={dash} />
      </g>
    )
  }
  // guide line
  const hl = ((shape.width ?? 0) / 2) * S
  return (
    <g transform={transform}>
      <line x1={-hl} y1={0} x2={hl} y2={0} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} />
    </g>
  )
}

function MaskShape({ shape }: { shape: ToolShape }) {
  const fill = shape.mode === 'add' ? 'white' : 'black'
  const transform = `translate(${shape.x * S},${shape.y * S})${shape.rotation ? ` rotate(${shape.rotation})` : ''}`
  if (shape.type === 'rectangle') {
    const w = (shape.width ?? 0) * S
    const h = (shape.height ?? 0) * S
    const r = (shape.corner_radius ?? 0) * S
    return <rect transform={transform} x={-w / 2} y={-h / 2} width={w} height={h} rx={r} ry={r} fill={fill} />
  }
  return <ellipse transform={transform} rx={(shape.rx ?? 0) * S} ry={(shape.ry ?? 0) * S} fill={fill} />
}

export function ShapeDesignerCanvas({
  svgRef, zvbX, zvbY, zvbW, zvbH, zoom,
  gridMinX, gridMaxX, gridMinY, gridMaxY, gridStep,
  shapes, selectedId, outlinePoints, outlineRings, snapIndicator,
  handleBackgroundClick, handleSvgMouseDown,
  handleShapeMouseDown, handleResizeMouseDown, handleRotateMouseDown,
}: Props) {
  const stopClick = (e: React.MouseEvent) => e.stopPropagation()
  const s = zvbW / 800
  // solid shapes ordered so the mask builds add-then-subtract; guides never paint
  const solidShapes = [...shapes.filter((sh) => sh.mode === 'add'), ...shapes.filter((sh) => sh.mode === 'subtract')]
  const selected = shapes.find((sh) => sh.id === selectedId)

  return (
    <div className="absolute inset-0">
      <svg
        ref={svgRef}
        viewBox={`${zvbX} ${zvbY} ${zvbW} ${zvbH}`}
        preserveAspectRatio="xMidYMid meet"
        className="w-full h-full cursor-default"
        style={{ overflow: 'hidden', backgroundColor: 'var(--color-inset)' }}
        onClick={handleBackgroundClick}
        onMouseDown={handleSvgMouseDown}
      >
        <rect x={zvbX} y={zvbY} width={zvbW} height={zvbH} fill="var(--color-inset)" />

        {/* mm grid */}
        {Array.from({ length: Math.ceil((gridMaxX - gridMinX) / gridStep) + 1 }).map((_, i) => {
          const x = (gridMinX + i * gridStep) * S
          const isOrigin = gridMinX + i * gridStep === 0
          return (
            <line
              key={`v${i}`}
              x1={x} y1={gridMinY * S} x2={x} y2={gridMaxY * S}
              stroke={isOrigin ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.08)'}
              strokeWidth={(isOrigin ? 1.5 : 0.5) / zoom}
            />
          )
        })}
        {Array.from({ length: Math.ceil((gridMaxY - gridMinY) / gridStep) + 1 }).map((_, i) => {
          const y = (gridMinY + i * gridStep) * S
          const isOrigin = gridMinY + i * gridStep === 0
          return (
            <line
              key={`h${i}`}
              x1={gridMinX * S} y1={y} x2={gridMaxX * S} y2={y}
              stroke={isOrigin ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.08)'}
              strokeWidth={(isOrigin ? 1.5 : 0.5) / zoom}
            />
          )
        })}

        {/* live boolean preview: white = solid, black = hole */}
        <mask id="shape-bool-mask">
          <rect x={zvbX} y={zvbY} width={zvbW} height={zvbH} fill="black" />
          {solidShapes.map((sh) => (
            <MaskShape key={sh.id} shape={sh} />
          ))}
        </mask>
        <rect
          x={zvbX} y={zvbY} width={zvbW} height={zvbH}
          fill="rgba(71, 85, 105, 0.65)"
          mask="url(#shape-bool-mask)"
          className="pointer-events-none"
        />

        {/* authoritative outline from the last server materialization */}
        {outlinePoints.length >= 3 && (
          <path
            d={polygonPathData(outlinePoints, outlineRings, S)}
            fillRule="evenodd"
            fill="none"
            stroke="rgb(72, 168, 214)"
            strokeWidth={1.5 / zoom}
            className="pointer-events-none"
          />
        )}

        {/* per-shape strokes + hit areas */}
        {shapes.map((sh) => (
          <g key={sh.id}>
            <ShapeElement shape={sh} zoom={zoom} selected={sh.id === selectedId} />
            {/* hit target */}
            {(() => {
              const transform = `translate(${sh.x * S},${sh.y * S})${sh.rotation ? ` rotate(${sh.rotation})` : ''}`
              const common = {
                transform,
                fill: sh.mode === 'guide' ? 'none' : 'transparent',
                stroke: 'transparent',
                strokeWidth: 14 / zoom,
                className: 'cursor-move',
                onMouseDown: handleShapeMouseDown(sh.id),
                onClick: stopClick,
              }
              if (sh.type === 'rectangle') {
                const w = (sh.width ?? 0) * S
                const h = (sh.height ?? 0) * S
                return <rect x={-w / 2} y={-h / 2} width={w} height={h} {...common} />
              }
              if (sh.type === 'ellipse') {
                return <ellipse rx={(sh.rx ?? 0) * S} ry={(sh.ry ?? 0) * S} {...common} />
              }
              const hl = ((sh.width ?? 0) / 2) * S
              return <line x1={-hl} y1={0} x2={hl} y2={0} {...common} fill="none" />
            })()}
          </g>
        ))}

        {/* selection: bbox + resize + rotate handles */}
        {selected && (() => {
          const b = shapeBounds(selected)
          const pad = 6 * s
          const x1 = b.minX * S - pad
          const y1 = b.minY * S - pad
          const x2 = b.maxX * S + pad
          const y2 = b.maxY * S + pad
          const handleR = 9 * s
          return (
            <g>
              <rect
                x={x1} y={y1} width={x2 - x1} height={y2 - y1}
                fill="none" stroke="rgba(90, 180, 222, 0.4)" strokeWidth={1.5 * s}
                strokeDasharray={`${6 * s},${4 * s}`}
                className="pointer-events-none"
              />
              {selected.type !== 'line' && (
                <circle
                  cx={x2} cy={y2} r={handleR}
                  fill="#1e293b" stroke="rgb(90, 180, 222)" strokeWidth={2 * s}
                  className="cursor-nwse-resize"
                  onMouseDown={handleResizeMouseDown(selected.id)}
                  onClick={stopClick}
                />
              )}
              <line
                x1={selected.x * S} y1={y1}
                x2={selected.x * S} y2={y1 - 18 * s}
                stroke="rgba(90, 180, 222, 0.6)" strokeWidth={2 * s} strokeDasharray={`${6 * s},${5 * s}`}
                className="pointer-events-none"
              />
              <circle
                cx={selected.x * S} cy={y1 - 18 * s - handleR}
                r={handleR}
                fill="rgb(90, 180, 222)" stroke="white" strokeWidth={2 * s}
                className="cursor-rotate"
                onMouseDown={handleRotateMouseDown(selected.id)}
                onClick={stopClick}
              />
            </g>
          )
        })()}

        {/* snap indicators */}
        {snapIndicator?.point && (
          <g className="pointer-events-none">
            <circle cx={snapIndicator.point.x * S} cy={snapIndicator.point.y * S} r={6 * s} fill="none" stroke="rgb(34, 197, 94)" strokeWidth={2 * s} />
            <line x1={snapIndicator.point.x * S - 10 * s} y1={snapIndicator.point.y * S} x2={snapIndicator.point.x * S + 10 * s} y2={snapIndicator.point.y * S} stroke="rgb(34, 197, 94)" strokeWidth={1 * s} />
            <line x1={snapIndicator.point.x * S} y1={snapIndicator.point.y * S - 10 * s} x2={snapIndicator.point.x * S} y2={snapIndicator.point.y * S + 10 * s} stroke="rgb(34, 197, 94)" strokeWidth={1 * s} />
          </g>
        )}
        {snapIndicator?.axisX !== undefined && (
          <line
            x1={snapIndicator.axisX * S} y1={zvbY} x2={snapIndicator.axisX * S} y2={zvbY + zvbH}
            stroke="rgba(34, 197, 94, 0.6)" strokeWidth={1 * s} strokeDasharray={`${5 * s},${4 * s}`}
            className="pointer-events-none"
          />
        )}
        {snapIndicator?.axisY !== undefined && (
          <line
            x1={zvbX} y1={snapIndicator.axisY * S} x2={zvbX + zvbW} y2={snapIndicator.axisY * S}
            stroke="rgba(34, 197, 94, 0.6)" strokeWidth={1 * s} strokeDasharray={`${5 * s},${4 * s}`}
            className="pointer-events-none"
          />
        )}
      </svg>
    </div>
  )
}
