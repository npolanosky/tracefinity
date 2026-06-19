// "Send to slicer" uses each slicer's registered URL protocol. The slicer
// opens and downloads the file from the embedded URL, so it must be an
// absolute URL the client machine can reach (the same host that serves the UI).
//
// Caveats:
// - OrcaSlicer is the most permissive and the most reliable here.
// - PrusaSlicer restricts its URL handler to printables.com + approved
//   partners by default, so a self-hosted URL may be refused unless allowed.
// - Bambu Studio's open-from-URL scheme is the least documented; treat as
//   best-effort.

export type SlicerId = 'orcaslicer' | 'prusaslicer' | 'bambustudio'

export const SLICERS: { id: SlicerId; label: string; url: (fileUrl: string) => string }[] = [
  { id: 'orcaslicer', label: 'OrcaSlicer', url: (u) => `orcaslicer://open?file=${u}` },
  { id: 'prusaslicer', label: 'PrusaSlicer', url: (u) => `prusaslicer://open?file=${u}` },
  { id: 'bambustudio', label: 'Bambu Studio', url: (u) => `bambustudioopen://open?file=${u}` },
]

export const DEFAULT_SLICER: SlicerId = 'orcaslicer'

export function slicerLabel(id: SlicerId): string {
  return SLICERS.find((s) => s.id === id)?.label ?? 'Slicer'
}

export function slicerUrl(id: SlicerId, fileUrl: string): string {
  const slicer = SLICERS.find((s) => s.id === id) ?? SLICERS[0]
  return slicer.url(fileUrl)
}

/** Make a relative API path absolute so a desktop slicer can fetch it. */
export function absoluteUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return origin + path
}
