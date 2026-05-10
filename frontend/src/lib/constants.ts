export const GRID_UNIT = 42
export const DEFAULT_GRID_UNIT = 42
export const DISPLAY_SCALE = 8
export const SNAP_GRID = 5 // default snap increment in mm
export const SNAP_GRID_MIN = 0.5
export const SNAP_GRID_MAX = 42
export const MAX_HISTORY = 50
export const ZOOM_FACTOR = 1.15
export const DEFAULT_CUTOUT_DEPTH = 20

export type SnapMode =
  | 'fixed-5'
  | 'fixed-1'
  | 'frac-2'
  | 'frac-4'
  | 'frac-8'

export const SNAP_FRACTIONS: { label: string; value: SnapMode }[] = [
  { label: '5 mm', value: 'fixed-5' },
  { label: '1 mm', value: 'fixed-1' },
  { label: '1/2 cell', value: 'frac-2' },
  { label: '1/4 cell', value: 'frac-4' },
  { label: '1/8 cell', value: 'frac-8' },
]

export function resolveSnap(mode: SnapMode, gridUnitMm: number): number {
  switch (mode) {
    case 'fixed-1':
      return 1
    case 'frac-2':
      return gridUnitMm / 2
    case 'frac-4':
      return gridUnitMm / 4
    case 'frac-8':
      return gridUnitMm / 8
    case 'fixed-5':
    default:
      return 5
  }
}
