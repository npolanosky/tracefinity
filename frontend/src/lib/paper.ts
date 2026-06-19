import type { PaperSize } from '@/types'

export const PAPER_SIZE_OPTIONS: { value: PaperSize; label: string }[] = [
  { value: 'a4', label: 'A4' },
  { value: 'letter', label: 'Letter' },
  { value: 'a3', label: 'A3' },
  { value: 'tabloid', label: 'Tabloid' },
]

export const DEFAULT_PAPER_SIZE: PaperSize = 'a4'
