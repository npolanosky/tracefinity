'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { Undo2, Redo2, Magnet } from 'lucide-react'
import type { Point, ToolShape } from '@/types'
import { DISPLAY_SCALE, ZOOM_FACTOR } from '@/lib/constants'
import { axisLock } from '@/lib/svg'
import { rotatePoint, shapeBounds } from '@/lib/shapes'
import { snapShapePosition, snapRotation, type SnapIndicator } from '@/lib/shapeSnap'
import { useHistory } from '@/hooks/useHistory'
import { ShapeDesignerCanvas } from '@/components/ShapeDesignerCanvas'
import { ShapeListPanel } from '@/components/ShapeListPanel'

const PADDING_MM = 20
const GRID_OPTIONS = [
  { label: 'Off', value: 0 },
  { label: '0.1', value: 0.1 },
  { label: '0.5', value: 0.5 },
  { label: '1', value: 1 },
  { label: '5', value: 5 },
]

interface Props {
  shapes: ToolShape[]
  outlinePoints: Point[]
  outlineRings: Point[][]
  clearanceOverride: number | null
  spacingOverride: number | null
  materializeError: string | null
  onShapesChange: (shapes: ToolShape[]) => void
  onClearanceChange: (v: number | null) => void
  onSpacingChange: (v: number | null) => void
  onConvertToPolygon: () => void
}

type DragState =
  | { type: 'shape'; id: string; startMm: Point; orig: ToolShape; alt: boolean }
  | { type: 'resize'; id: string; orig: ToolShape }
  | { type: 'rotate'; id: string; orig: ToolShape; startAngle: number; alt: boolean }
  | { type: 'pan'; startClientX: number; startClientY: number; origPanX: number; origPanY: number; svgScale: number }
  | null

export function ShapeDesigner({
  shapes,
  outlinePoints,
  outlineRings,
  clearanceOverride,
  spacingOverride,
  materializeError,
  onShapesChange,
  onClearanceChange,
  onSpacingChange,
  onConvertToPolygon,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [gridMm, setGridMm] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState<DragState>(null)
  const [dragShapes, setDragShapes] = useState<ToolShape[] | null>(null)
  const [snapIndicator, setSnapIndicator] = useState<SnapIndicator | null>(null)
  const spaceHeld = useRef(false)
  const didPanRef = useRef(false)

  const displayShapes = dragShapes ?? shapes

  const { set: pushHistory, undo: handleUndo, redo: handleRedo, canUndo, canRedo } = useHistory<ToolShape[]>(
    shapes,
    onShapesChange
  )

  const commitShapes = useCallback((updated: ToolShape[]) => {
    pushHistory(updated)
    onShapesChange(updated)
  }, [pushHistory, onShapesChange])

  // refs to avoid stale closures during window-level drag handlers
  const shapesRef = useRef(shapes)
  const dragShapesRef = useRef(dragShapes)
  const zoomRef = useRef(zoom)
  const panRef = useRef(pan)
  const gridRef = useRef(gridMm)
  useEffect(() => { shapesRef.current = shapes }, [shapes])
  useEffect(() => { dragShapesRef.current = dragShapes }, [dragShapes])
  useEffect(() => { zoomRef.current = zoom }, [zoom])
  useEffect(() => { panRef.current = pan }, [pan])
  useEffect(() => { gridRef.current = gridMm }, [gridMm])

  // viewBox from committed shapes + outline so the frame stays stable during drags
  const bounds = (() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const s of shapes) {
      const b = shapeBounds(s)
      minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY)
      maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY)
    }
    for (const p of outlinePoints) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y)
    }
    if (minX === Infinity) return { minX: -50, minY: -50, maxX: 50, maxY: 50 }
    return { minX, minY, maxX, maxY }
  })()

  const vbX = (bounds.minX - PADDING_MM) * DISPLAY_SCALE
  const vbY = (bounds.minY - PADDING_MM) * DISPLAY_SCALE
  const vbW = (bounds.maxX - bounds.minX + PADDING_MM * 2) * DISPLAY_SCALE
  const vbH = (bounds.maxY - bounds.minY + PADDING_MM * 2) * DISPLAY_SCALE
  const zvbW = vbW / zoom
  const zvbH = vbH / zoom
  const zvbX = vbX + (vbW - zvbW) / 2 + pan.x
  const zvbY = vbY + (vbH - zvbH) / 2 + pan.y

  const gridStep = 10
  const gridMinX = Math.floor(zvbX / DISPLAY_SCALE / gridStep) * gridStep
  const gridMaxX = Math.ceil((zvbX + zvbW) / DISPLAY_SCALE / gridStep) * gridStep
  const gridMinY = Math.floor(zvbY / DISPLAY_SCALE / gridStep) * gridStep
  const gridMaxY = Math.ceil((zvbY + zvbH) / DISPLAY_SCALE / gridStep) * gridStep

  const screenToMm = useCallback((clientX: number, clientY: number): Point => {
    if (!svgRef.current) return { x: 0, y: 0 }
    const rect = svgRef.current.getBoundingClientRect()
    const scale = Math.max(zvbW / rect.width, zvbH / rect.height)
    const offsetX = (rect.width * scale - zvbW) / 2
    const offsetY = (rect.height * scale - zvbH) / 2
    const svgX = (clientX - rect.left) * scale - offsetX + zvbX
    const svgY = (clientY - rect.top) * scale - offsetY + zvbY
    return { x: svgX / DISPLAY_SCALE, y: svgY / DISPLAY_SCALE }
  }, [zvbW, zvbH, zvbX, zvbY])

  const screenToMmRef = useRef(screenToMm)
  useEffect(() => { screenToMmRef.current = screenToMm }, [screenToMm])

  /** snap threshold in mm: ~8 screen px */
  const snapThresholdMm = useCallback((): number => {
    if (!svgRef.current) return 1
    const rect = svgRef.current.getBoundingClientRect()
    return (8 * Math.max(zvbW / rect.width, zvbH / rect.height)) / DISPLAY_SCALE
  }, [zvbW, zvbH])
  const thresholdRef = useRef(snapThresholdMm)
  useEffect(() => { thresholdRef.current = snapThresholdMm }, [snapThresholdMm])

  // scroll-to-zoom toward the cursor
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      const factor = e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR
      const oldZoom = zoomRef.current
      const newZoom = Math.min(20, Math.max(0.5, oldZoom * factor))
      if (newZoom === oldZoom) return

      const rect = svg.getBoundingClientRect()
      const curPan = panRef.current
      const curW = vbW / oldZoom
      const curH = vbH / oldZoom
      const curX = vbX + (vbW - curW) / 2 + curPan.x
      const curY = vbY + (vbH - curH) / 2 + curPan.y
      const svgScale = Math.min(rect.width / curW, rect.height / curH)
      const padLeft = (rect.width - curW * svgScale) / 2
      const padTop = (rect.height - curH * svgScale) / 2
      const cursorX = curX + (e.clientX - rect.left - padLeft) / svgScale
      const cursorY = curY + (e.clientY - rect.top - padTop) / svgScale
      const newW = vbW / newZoom
      const newH = vbH / newZoom
      const newX = vbX + (vbW - newW) / 2 + curPan.x
      const newY = vbY + (vbH - newH) / 2 + curPan.y
      const newSvgScale = Math.min(rect.width / newW, rect.height / newH)
      const newPadLeft = (rect.width - newW * newSvgScale) / 2
      const newPadTop = (rect.height - newH * newSvgScale) / 2
      const newCursorX = newX + (e.clientX - rect.left - newPadLeft) / newSvgScale
      const newCursorY = newY + (e.clientY - rect.top - newPadTop) / newSvgScale
      setPan({ x: curPan.x + (cursorX - newCursorX), y: curPan.y + (cursorY - newCursorY) })
      setZoom(newZoom)
    }
    svg.addEventListener('wheel', handleWheel, { passive: false })
    return () => svg.removeEventListener('wheel', handleWheel)
  }, [vbW, vbH, vbX, vbY])

  // space for pan, delete for removing the selected shape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) spaceHeld.current = true
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        const tag = (document.activeElement?.tagName || '').toLowerCase()
        if (tag === 'input' || tag === 'textarea') return
        commitShapes(shapesRef.current.filter((s) => s.id !== selectedId))
        setSelectedId(null)
      }
    }
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeld.current = false
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [selectedId, commitShapes])

  const handleShapeMouseDown = (id: string) => (e: React.MouseEvent) => {
    e.stopPropagation()
    if (spaceHeld.current) return
    const shape = shapes.find((s) => s.id === id)
    if (!shape) return
    setSelectedId(id)
    setDragging({ type: 'shape', id, startMm: screenToMm(e.clientX, e.clientY), orig: shape, alt: e.altKey })
  }

  const handleResizeMouseDown = (id: string) => (e: React.MouseEvent) => {
    e.stopPropagation()
    const shape = shapes.find((s) => s.id === id)
    if (!shape) return
    setDragging({ type: 'resize', id, orig: shape })
  }

  const handleRotateMouseDown = (id: string) => (e: React.MouseEvent) => {
    e.stopPropagation()
    const shape = shapes.find((s) => s.id === id)
    if (!shape) return
    const mm = screenToMm(e.clientX, e.clientY)
    const startAngle = (Math.atan2(mm.y - shape.y, mm.x - shape.x) * 180) / Math.PI
    setDragging({ type: 'rotate', id, orig: shape, startAngle, alt: e.altKey })
  }

  const handleSvgMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 && e.button !== 1) return
    if (e.button === 1 || spaceHeld.current || e.target === svgRef.current || (e.target as Element).tagName === 'rect') {
      // pan on background / middle button / space
      if (!svgRef.current) return
      const rect = svgRef.current.getBoundingClientRect()
      const svgScale = Math.min(rect.width / zvbW, rect.height / zvbH)
      didPanRef.current = false
      setDragging({ type: 'pan', startClientX: e.clientX, startClientY: e.clientY, origPanX: pan.x, origPanY: pan.y, svgScale })
    }
  }

  const handleBackgroundClick = () => {
    if (!didPanRef.current) setSelectedId(null)
  }

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!dragging) return
    const grid = gridRef.current

    if (dragging.type === 'pan') {
      const dx = (e.clientX - dragging.startClientX) / dragging.svgScale
      const dy = (e.clientY - dragging.startClientY) / dragging.svgScale
      if (Math.abs(dx) + Math.abs(dy) > 2) didPanRef.current = true
      setPan({ x: dragging.origPanX - dx, y: dragging.origPanY - dy })
      return
    }

    const mm = screenToMmRef.current(e.clientX, e.clientY)
    const base = shapesRef.current

    if (dragging.type === 'shape') {
      let dx = mm.x - dragging.startMm.x
      let dy = mm.y - dragging.startMm.y
      let next = { x: dragging.orig.x + dx, y: dragging.orig.y + dy }
      let indicator: SnapIndicator | null = null
      if (e.shiftKey) {
        // shift locks to the dominant cardinal axis; grid still snaps the
        // free axis (unless Alt), the locked axis stays exactly put
        ;({ dx, dy } = axisLock(dx, dy))
        const snapFree = (v: number) => (e.altKey || !grid ? v : Math.round(v / grid) * grid)
        next = {
          x: dx === 0 ? dragging.orig.x : snapFree(dragging.orig.x + dx),
          y: dy === 0 ? dragging.orig.y : snapFree(dragging.orig.y + dy),
        }
        indicator = dx === 0 ? { axisX: dragging.orig.x } : { axisY: dragging.orig.y }
      } else if (!e.altKey && !dragging.alt) {
        const others = base.filter((s) => s.id !== dragging.id)
        const snapped = snapShapePosition(dragging.orig, next.x, next.y, others, grid || null, thresholdRef.current())
        next = { x: snapped.x, y: snapped.y }
        indicator = snapped.indicator
      }
      setSnapIndicator(indicator)
      setDragShapes(base.map((s) => (s.id === dragging.id ? { ...s, x: next.x, y: next.y } : s)))
    } else if (dragging.type === 'resize') {
      const o = dragging.orig
      const local = rotatePoint({ x: mm.x - o.x, y: mm.y - o.y }, -o.rotation)
      const snapDim = (v: number) => {
        const dim = Math.max(0.5, v)
        return e.altKey || !grid ? dim : Math.max(0.5, Math.round(dim / grid) * grid)
      }
      let patch: Partial<ToolShape> = {}
      if (o.type === 'rectangle') {
        patch = { width: snapDim(Math.abs(local.x) * 2), height: snapDim(Math.abs(local.y) * 2) }
      } else if (o.type === 'ellipse') {
        if (o.rx === o.ry) {
          const r = snapDim(Math.hypot(local.x, local.y))
          patch = { rx: r, ry: r }
        } else {
          patch = { rx: snapDim(Math.abs(local.x)), ry: snapDim(Math.abs(local.y)) }
        }
      }
      setDragShapes(base.map((s) => (s.id === dragging.id ? { ...s, ...patch } : s)))
    } else if (dragging.type === 'rotate') {
      const o = dragging.orig
      const angle = (Math.atan2(mm.y - o.y, mm.x - o.x) * 180) / Math.PI
      const next = snapRotation(o.rotation + angle - dragging.startAngle, !e.altKey && !dragging.alt)
      setDragShapes(base.map((s) => (s.id === dragging.id ? { ...s, rotation: next } : s)))
    }
  }, [dragging])

  const handleMouseUp = useCallback(() => {
    if (dragging && dragging.type !== 'pan' && dragShapesRef.current) {
      commitShapes(dragShapesRef.current)
    }
    setDragging(null)
    setDragShapes(null)
    setSnapIndicator(null)
  }, [dragging, commitShapes])

  useEffect(() => {
    if (!dragging) return
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [dragging, handleMouseMove, handleMouseUp])

  return (
    <div className="h-full w-full relative">
      <ShapeDesignerCanvas
        svgRef={svgRef}
        zvbX={zvbX} zvbY={zvbY} zvbW={zvbW} zvbH={zvbH}
        zoom={zoom}
        gridMinX={gridMinX} gridMaxX={gridMaxX} gridMinY={gridMinY} gridMaxY={gridMaxY} gridStep={gridStep}
        shapes={displayShapes}
        selectedId={selectedId}
        outlinePoints={outlinePoints}
        outlineRings={outlineRings}
        snapIndicator={snapIndicator}
        handleBackgroundClick={handleBackgroundClick}
        handleSvgMouseDown={handleSvgMouseDown}
        handleShapeMouseDown={handleShapeMouseDown}
        handleResizeMouseDown={handleResizeMouseDown}
        handleRotateMouseDown={handleRotateMouseDown}
      />

      {/* floating toolbar: top centre */}
      <div className="absolute top-3.5 left-1/2 -translate-x-1/2 z-20 glass-toolbar px-2 py-1 pointer-events-auto">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 text-text-muted">
            <Magnet className="w-3.5 h-3.5" />
            <div className="flex rounded-[7px] overflow-hidden border border-border-subtle text-[11px]">
              {GRID_OPTIONS.map((opt) => (
                <button
                  key={opt.label}
                  onClick={() => setGridMm(opt.value)}
                  className={`px-2 py-1 transition-colors ${gridMm === opt.value ? 'bg-accent-muted text-accent' : 'text-text-muted hover:text-text-secondary'}`}
                  title={opt.value ? `Snap to ${opt.value}mm grid` : 'Grid snap off'}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <span className="text-[10px] ml-1">mm</span>
          </div>

          <div className="h-4 w-px bg-border-subtle mx-0.5" />

          <button
            onClick={handleUndo}
            disabled={!canUndo}
            className="p-1 rounded-[7px] hover:bg-border/50 hover:text-text-secondary disabled:opacity-30 disabled:cursor-not-allowed text-text-muted"
            title="Undo (Ctrl+Z)"
          >
            <Undo2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleRedo}
            disabled={!canRedo}
            className="p-1 rounded-[7px] hover:bg-border/50 hover:text-text-secondary disabled:opacity-30 disabled:cursor-not-allowed text-text-muted"
            title="Redo (Ctrl+Shift+Z)"
          >
            <Redo2 className="w-3.5 h-3.5" />
          </button>

          <span className="text-[10px] text-text-muted ml-1 hidden md:inline">
            Shift = axis lock · Alt = no snap · Space/middle-drag = pan · Scroll = zoom
          </span>
        </div>
      </div>

      {/* shape list panel: right edge */}
      <div className="absolute z-20 inset-x-3.5 bottom-3.5 max-h-[40%] lg:inset-x-auto lg:top-[60px] lg:right-3.5 lg:bottom-3.5 lg:max-h-none">
        <ShapeListPanel
          shapes={shapes}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onShapesChange={commitShapes}
          clearanceOverride={clearanceOverride}
          onClearanceChange={onClearanceChange}
          spacingOverride={spacingOverride}
          onSpacingChange={onSpacingChange}
          materializeError={materializeError}
          onConvertToPolygon={onConvertToPolygon}
        />
      </div>
    </div>
  )
}
