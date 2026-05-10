'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

type Mode = 'starting' | 'ready' | 'lost'

interface BootInfo {
  ready: boolean
  phase: string
  current?: string
  loaded?: string[]
  pending?: string[]
  startedAt?: number
}

const POLL_INTERVAL_MS = 5_000
const HEARTBEAT_INTERVAL_MS = 30_000
const HEARTBEAT_FAIL_THRESHOLD = 2
const FETCH_TIMEOUT_MS = 4_000
const NETWORK_ERROR_EVENT = 'tracefinity:api-network-error'

const FRIENDLY_PHASE: Record<string, string> = {
  starting: 'Starting backend',
  'loading paper detector': 'Loading paper detector (4 MB)',
  'loading isnet': 'Loading IS-Net (179 MB)',
  'loading birefnet-lite': 'Loading BiRefNet Lite (224 MB)',
  'loading inspyrenet': 'Loading InSPyReNet',
  ready: 'Ready',
}

function describePhase(boot: BootInfo | null): string {
  if (!boot) return 'Connecting to backend…'
  return FRIENDLY_PHASE[boot.phase] ?? boot.phase.replace(/^loading /, 'Loading ')
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { method: 'GET', cache: 'no-store', signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export function ReadinessGate({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<Mode>('starting')
  const [boot, setBoot] = useState<BootInfo | null>(null)
  const [attempt, setAttempt] = useState(0)
  const failsRef = useRef(0)
  const cancelledRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const probeRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    cancelledRef.current = false

    async function probe() {
      if (cancelledRef.current) return
      let nextDelay = POLL_INTERVAL_MS
      let success = false

      // /boot.json is served by nginx and is always reachable once the
      // container is up. /api/ready confirms uvicorn has bound the socket.
      try {
        const res = await fetchWithTimeout('/boot.json', FETCH_TIMEOUT_MS)
        if (res.ok) {
          const data = await res.json() as BootInfo
          setBoot(data)
          if (data.ready) {
            // Confirm uvicorn is actually answering before we drop the splash.
            try {
              const ready = await fetchWithTimeout('/api/ready', FETCH_TIMEOUT_MS)
              if (ready.ok) {
                failsRef.current = 0
                setMode('ready')
                nextDelay = HEARTBEAT_INTERVAL_MS
                success = true
              }
            } catch { /* fall through to retry */ }
          }
        } else if (res.status === 503) {
          // boot.json missing — backend hasn't written it yet, just retry.
        }
      } catch {
        // network error reaching nginx — container is probably down.
      }

      if (!success) {
        failsRef.current += 1
        if (mode === 'ready' && failsRef.current >= HEARTBEAT_FAIL_THRESHOLD) {
          setMode('lost')
        } else if (mode !== 'ready') {
          setMode('starting')
        }
        setAttempt((a) => a + 1)
      }

      if (cancelledRef.current) return
      timerRef.current = setTimeout(probe, nextDelay)
    }

    probeRef.current = probe
    probe()

    function handleNetworkError() {
      // An API call failed elsewhere; re-probe immediately so the splash
      // surfaces fast if the backend dropped.
      if (timerRef.current) clearTimeout(timerRef.current)
      probeRef.current?.()
    }
    window.addEventListener(NETWORK_ERROR_EVENT, handleNetworkError)

    return () => {
      cancelledRef.current = true
      if (timerRef.current) clearTimeout(timerRef.current)
      window.removeEventListener(NETWORK_ERROR_EVENT, handleNetworkError)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (mode === 'ready') {
    return <>{children}</>
  }

  const isLost = mode === 'lost'
  const elapsedSec = boot?.startedAt
    ? Math.max(0, Math.floor((Date.now() - boot.startedAt) / 1000))
    : null

  return (
    <>
      {children}
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center bg-base/95 backdrop-blur-sm"
        role="status"
        aria-live="polite"
      >
        <div className="glass rounded-[10px] px-6 py-5 max-w-sm w-[calc(100%-2rem)] flex flex-col items-center gap-3 text-center">
          <img src="/favicon.svg" alt="" className="w-10 h-10 rounded-md" />
          <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <Loader2 className="w-4 h-4 animate-spin text-accent" />
            <span>
              {isLost ? 'Lost connection to backend…' : describePhase(boot)}
            </span>
          </div>
          {boot?.loaded && boot.loaded.length > 0 && !isLost && (
            <p className="text-[10px] text-text-muted leading-relaxed">
              Loaded: {boot.loaded.join(', ')}
              {boot.pending && boot.pending.length > 0
                ? ` · Remaining: ${boot.pending.join(', ')}`
                : ''}
            </p>
          )}
          <p className="text-[11px] leading-relaxed text-text-muted">
            {isLost
              ? `Backend stopped responding. Reconnecting every ${POLL_INTERVAL_MS / 1000}s — check the container if this persists.`
              : elapsedSec !== null
                ? `${elapsedSec}s elapsed. First boot of a fresh container takes ~30 seconds.`
                : 'Container starting…'}
          </p>
          {!isLost && attempt > 0 && (
            <p className="text-[10px] text-text-muted">attempt {attempt + 1}</p>
          )}
        </div>
      </div>
    </>
  )
}
