'use client'

import { useEffect, useState } from 'react'

/** Tiny build-version indicator pinned to the bottom-right corner. */
export function VersionBadge() {
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/version')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.version) setVersion(d.version) })
      .catch(() => {})
  }, [])

  if (!version) return null

  // shorten a trailing git sha (e.g. "dev-<40hex>" -> "dev-<7hex>")
  const display = version.replace(/-([0-9a-f]{7})[0-9a-f]+$/, '-$1')

  return (
    <div
      title={version}
      className="fixed bottom-1 right-2 z-40 text-[10px] leading-none text-text-muted/50 pointer-events-none select-none"
    >
      {display}
    </div>
  )
}
