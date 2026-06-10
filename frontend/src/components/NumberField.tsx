'use client'

import { useEffect, useState } from 'react'

interface NumberFieldProps {
  value: number | null
  min: number
  max: number
  step?: number
  onCommit: (v: number) => void
  onCommitNull?: () => void
  nullable?: boolean
  placeholder?: string
  disabled?: boolean
  className?: string
}

function stepDecimals(step: number): number {
  return step >= 1 ? 0 : Math.min(3, String(step).split('.')[1]?.length ?? 1)
}

function format(value: number | null, step: number): string {
  if (value == null) return ''
  // avoid float noise like 0.30000000000000004 from step arithmetic
  return String(Number(value.toFixed(stepDecimals(step))))
}

/**
 * Numeric input that only parses/clamps on commit (blur or Enter), never per
 * keystroke -- typing "37" into a min-30 field must not clamp the intermediate
 * "3" to 30. Escape reverts to the last committed value.
 */
export function NumberField({
  value,
  min,
  max,
  step = 1,
  onCommit,
  onCommitNull,
  nullable,
  placeholder,
  disabled,
  className,
}: NumberFieldProps) {
  const [text, setText] = useState(() => format(value, step))
  const [focused, setFocused] = useState(false)

  // follow external changes (e.g. paired slider drags) while not being typed in
  useEffect(() => {
    if (!focused) setText(format(value, step))
  }, [value, step, focused])

  const revert = () => setText(format(value, step))

  const commit = (raw: string) => {
    const trimmed = raw.trim()
    if (trimmed === '' && nullable) {
      onCommitNull?.()
      return
    }
    const n = parseFloat(trimmed)
    if (isNaN(n)) {
      revert()
      return
    }
    const clamped = Math.min(max, Math.max(min, n))
    const snapped = Math.round((clamped - min) / step) * step + min
    const final = Number(Math.min(max, snapped).toFixed(stepDecimals(step)))
    setText(format(final, step))
    onCommit(final)
  }

  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      onFocus={() => setFocused(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => {
        setFocused(false)
        commit(e.target.value)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          revert()
          ;(e.currentTarget as HTMLInputElement).blur()
        }
      }}
      className={
        className ??
        'w-14 h-7 bg-elevated text-right text-xs font-semibold text-text-primary rounded pr-2 focus:outline-none'
      }
    />
  )
}
