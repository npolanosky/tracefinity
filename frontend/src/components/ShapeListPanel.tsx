'use client'

import { Circle, Copy, Minus, Pencil, Plus, RectangleHorizontal, Trash2 } from 'lucide-react'
import type { ToolShape, ToolShapeMode } from '@/types'
import { NumberField } from '@/components/NumberField'
import { makeShape, duplicateShape, shapeDisplayName } from '@/lib/shapes'

interface Props {
  shapes: ToolShape[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onShapesChange: (shapes: ToolShape[]) => void
  clearanceOverride: number | null
  onClearanceChange: (v: number | null) => void
  spacingOverride: number | null
  onSpacingChange: (v: number | null) => void
  materializeError: string | null
  onConvertToPolygon: () => void
}

const MODE_LABEL: Record<ToolShapeMode, string> = {
  add: 'Solid',
  subtract: 'Hole',
  guide: 'Guide',
}

const MODE_STYLE: Record<ToolShapeMode, string> = {
  add: 'bg-accent-muted text-accent',
  subtract: 'bg-red-900/40 text-red-400',
  guide: 'bg-blue-900/40 text-blue-400',
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-2">
      <span className="text-[10px] text-text-muted w-14">{label}</span>
      {children}
    </label>
  )
}

const FIELD_CLASS =
  'w-16 h-6 bg-elevated border border-border-subtle rounded text-right text-[11px] text-text-primary pr-1.5 focus:outline-none focus:border-accent'

export function ShapeListPanel({
  shapes,
  selectedId,
  onSelect,
  onShapesChange,
  clearanceOverride,
  onClearanceChange,
  spacingOverride,
  onSpacingChange,
  materializeError,
  onConvertToPolygon,
}: Props) {
  const update = (id: string, patch: Partial<ToolShape>) => {
    onShapesChange(shapes.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }

  const add = (shape: ToolShape) => {
    onShapesChange([...shapes, shape])
    onSelect(shape.id)
  }

  const remove = (id: string) => {
    onShapesChange(shapes.filter((s) => s.id !== id))
    if (selectedId === id) onSelect(null)
  }

  const cycleMode = (s: ToolShape) => {
    if (s.type === 'line') return // lines are always guides
    const order: ToolShapeMode[] = ['add', 'subtract', 'guide']
    const next = order[(order.indexOf(s.mode) + 1) % order.length]
    // depth only means something on solids
    update(s.id, { mode: next, ...(next !== 'add' ? { depth: null } : {}) })
  }

  return (
    <div className="flex flex-col gap-2 w-[230px] max-h-full overflow-y-auto">
      {/* add buttons */}
      <div className="glass-toolbar px-2 py-1.5 flex items-center gap-1">
        <button
          onClick={() => add(makeShape('rectangle'))}
          className="p-1.5 rounded-[7px] hover:bg-border/50 text-text-secondary"
          title="Add rectangle"
        >
          <RectangleHorizontal className="w-4 h-4" />
        </button>
        <button
          onClick={() => add(makeShape('ellipse'))}
          className="p-1.5 rounded-[7px] hover:bg-border/50 text-text-secondary"
          title="Add circle / ellipse"
        >
          <Circle className="w-4 h-4" />
        </button>
        <button
          onClick={() => add(makeShape('line'))}
          className="p-1.5 rounded-[7px] hover:bg-border/50 text-text-secondary"
          title="Add guide line"
        >
          <Pencil className="w-4 h-4" />
        </button>
        <span className="text-[10px] text-text-muted ml-1">Add shape</span>
      </div>

      {/* shape rows */}
      {shapes.map((s) => {
        const selected = s.id === selectedId
        const isCircle = s.type === 'ellipse' && s.rx === s.ry
        return (
          <div
            key={s.id}
            onClick={() => onSelect(s.id)}
            className={`glass-toolbar px-2.5 py-2 cursor-pointer ${selected ? 'ring-1 ring-accent' : ''}`}
          >
            <div className="flex items-center gap-1.5">
              {s.type === 'rectangle' ? (
                <RectangleHorizontal className="w-3.5 h-3.5 text-text-muted shrink-0" />
              ) : s.type === 'ellipse' ? (
                <Circle className="w-3.5 h-3.5 text-text-muted shrink-0" />
              ) : (
                <Pencil className="w-3.5 h-3.5 text-text-muted shrink-0" />
              )}
              <span className="text-[11px] text-text-primary truncate flex-1">
                {shapeDisplayName(s)}
                {s.mode === 'add' && s.depth != null && (
                  <span className="text-text-muted"> · {s.depth}mm</span>
                )}
              </span>
              <button
                onClick={(e) => { e.stopPropagation(); cycleMode(s) }}
                className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${MODE_STYLE[s.mode]}`}
                title={s.type === 'line' ? 'Lines are always guides' : 'Solid adds material to the cutout, Hole carves an island, Guide is construction only'}
              >
                {s.mode === 'add' ? <span className="inline-flex items-center gap-0.5"><Plus className="w-2.5 h-2.5" />{MODE_LABEL[s.mode]}</span> : s.mode === 'subtract' ? <span className="inline-flex items-center gap-0.5"><Minus className="w-2.5 h-2.5" />{MODE_LABEL[s.mode]}</span> : MODE_LABEL[s.mode]}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); add(duplicateShape(s)) }}
                className="p-1 rounded hover:bg-border/50 text-text-muted hover:text-text-secondary"
                title="Duplicate"
              >
                <Copy className="w-3 h-3" />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); remove(s.id) }}
                className="p-1 rounded hover:bg-red-900/30 text-text-muted hover:text-red-400"
                title="Delete shape"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>

            {selected && (
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5" onClick={(e) => e.stopPropagation()}>
                <Field label="X">
                  <NumberField value={s.x} min={-500} max={500} step={0.1} onCommit={(v) => update(s.id, { x: v })} className={FIELD_CLASS} />
                </Field>
                <Field label="Y">
                  <NumberField value={s.y} min={-500} max={500} step={0.1} onCommit={(v) => update(s.id, { y: v })} className={FIELD_CLASS} />
                </Field>
                {s.type === 'rectangle' && (
                  <>
                    <Field label="Width">
                      <NumberField value={s.width ?? 0} min={0.5} max={500} step={0.1} onCommit={(v) => update(s.id, { width: v })} className={FIELD_CLASS} />
                    </Field>
                    <Field label="Height">
                      <NumberField value={s.height ?? 0} min={0.5} max={500} step={0.1} onCommit={(v) => update(s.id, { height: v })} className={FIELD_CLASS} />
                    </Field>
                    <Field label="Corner r">
                      <NumberField value={s.corner_radius ?? 0} min={0} max={250} step={0.1} onCommit={(v) => update(s.id, { corner_radius: v })} className={FIELD_CLASS} />
                    </Field>
                  </>
                )}
                {s.type === 'ellipse' && isCircle && (
                  <Field label="Diameter">
                    <NumberField value={(s.rx ?? 0) * 2} min={0.5} max={1000} step={0.1} onCommit={(v) => update(s.id, { rx: v / 2, ry: v / 2 })} className={FIELD_CLASS} />
                  </Field>
                )}
                {s.type === 'ellipse' && (
                  <>
                    <Field label="Width">
                      <NumberField value={(s.rx ?? 0) * 2} min={0.5} max={1000} step={0.1} onCommit={(v) => update(s.id, { rx: v / 2 })} className={FIELD_CLASS} />
                    </Field>
                    <Field label="Height">
                      <NumberField value={(s.ry ?? 0) * 2} min={0.5} max={1000} step={0.1} onCommit={(v) => update(s.id, { ry: v / 2 })} className={FIELD_CLASS} />
                    </Field>
                  </>
                )}
                {s.type === 'line' && (
                  <Field label="Length">
                    <NumberField value={s.width ?? 0} min={1} max={1000} step={0.1} onCommit={(v) => update(s.id, { width: v })} className={FIELD_CLASS} />
                  </Field>
                )}
                <Field label="Angle">
                  <NumberField value={s.rotation} min={-180} max={180} step={0.1} onCommit={(v) => update(s.id, { rotation: v })} className={FIELD_CLASS} />
                </Field>
                {s.mode === 'add' && s.type !== 'line' && (
                  <Field label="Depth">
                    <NumberField
                      value={s.depth ?? null}
                      min={5}
                      max={200}
                      step={0.5}
                      nullable
                      placeholder="default"
                      onCommit={(v) => update(s.id, { depth: v })}
                      onCommitNull={() => update(s.id, { depth: null })}
                      className={FIELD_CLASS}
                    />
                  </Field>
                )}
              </div>
            )}
          </div>
        )
      })}

      {materializeError && (
        <div className="glass-toolbar px-2.5 py-2 text-[11px] text-amber-400 border border-amber-700/50 rounded">
          {materializeError} — changes are not saved until the outline is valid again.
        </div>
      )}

      {/* tool-level settings */}
      <div className="glass-toolbar px-2.5 py-2 space-y-1.5">
        <Field label="Clearance">
          <NumberField
            value={clearanceOverride}
            min={0}
            max={10}
            step={0.05}
            nullable
            placeholder="bin default"
            onCommit={(v) => onClearanceChange(v)}
            onCommitNull={() => onClearanceChange(null)}
            className={FIELD_CLASS}
          />
        </Field>
        <p className="text-[10px] text-text-muted leading-tight">
          Cutouts grow by this much per side in bins. Leave blank to use each bin&apos;s clearance; set 0 for an exact fit.
        </p>
        <Field label="Spacing">
          <NumberField
            value={spacingOverride}
            min={0}
            max={20}
            step={0.25}
            nullable
            placeholder="bin default"
            onCommit={(v) => onSpacingChange(v)}
            onCommitNull={() => onSpacingChange(null)}
            className={FIELD_CLASS}
          />
        </Field>
        <p className="text-[10px] text-text-muted leading-tight">
          Extra keep-out air gap when arranging tools in a bin (the cutout itself is unchanged). Use for tools that overhang their cutout.
        </p>
        <p className="text-[10px] text-text-muted leading-tight">
          Holes are carved after all solids are merged.
        </p>
        <button
          onClick={onConvertToPolygon}
          className="w-full mt-1 px-2 py-1.5 text-[11px] text-text-secondary hover:text-text-primary border border-border-subtle rounded-[7px] hover:bg-border/30 transition-colors"
          title="Detach from shapes and edit as a freeform outline (one-way)"
        >
          Convert to polygon
        </button>
      </div>
    </div>
  )
}
