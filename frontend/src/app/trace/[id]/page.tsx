'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { useDebouncedSave } from '@/hooks/useDebouncedSave'
import { Loader2, Copy, Upload, Download, Check, ChevronDown, ChevronRight, Sparkles, X, RefreshCw, AlertTriangle } from 'lucide-react'
import { PaperCornerEditor } from '@/components/PaperCornerEditor'
import { PolygonEditor } from '@/components/PolygonEditor'
import { SessionInfo } from '@/components/SessionInfo'
import { Alert } from '@/components/Alert'
import { getSession, setCorners, detectCorners, traceTools, updatePolygons, updateSession, getImageUrl, getAvailableKeys, traceFromMask, saveToolsFromSession, nameTools } from '@/lib/api'
import { CornersHint, TraceHint, EditHint } from '@/components/OnboardingIllustrations'
import { StepBar } from '@/components/StepBar'
import { PAPER_SIZE_OPTIONS, DEFAULT_PAPER_SIZE } from '@/lib/paper'
import { getSettings } from '@/lib/settings'
import type { PaperSize, Point, Polygon, Session } from '@/types'

type Step = 'corners' | 'trace' | 'edit'

const MASK_PROMPT = `Generate a pure black and white silhouette mask of ONLY the tools/objects in this image.
- Tools should be solid BLACK (#000000)
- Background should be solid WHITE (#FFFFFF)
- No shadows, gradients, or gray tones
- Sharp, clean edges
- Output ONLY the mask image, no text or explanation`

const TRACE_STEPS = [
  'Uploading image...',
  'Generating silhouette mask...',
  'Processing mask...',
  'Tracing contours...',
  'Identifying tools...',
]

export default function TracePage() {
  const router = useRouter()
  const params = useParams()
  const sessionId = params.id as string

  const [session, setSession] = useState<Session | null>(null)
  const [step, setStep] = useState<Step>('corners')
  const [loading, setLoading] = useState(true)
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [corners, setLocalCorners] = useState<Point[]>([])
  const [cornersAutoDetected, setCornersAutoDetected] = useState(false)
  const [redetecting, setRedetecting] = useState(false)
  const [detectAttempt, setDetectAttempt] = useState<number | null>(null)
  const [detectFailed, setDetectFailed] = useState(false)
  const [paperSize, setPaperSize] = useState<PaperSize>(DEFAULT_PAPER_SIZE)
  const [imageUrl, setImageUrl] = useState<string>('')
  const [correctedImageUrl, setCorrectedImageUrl] = useState<string>('')
  const [polygons, setPolygons] = useState<Polygon[]>([])

  const [provider, setProvider] = useState<'google' | 'manual'>('google')
  const [apiKey, setApiKey] = useState('')
  const [hasEnvKey, setHasEnvKey] = useState(false)
  const [providerLabel, setProviderLabel] = useState<string | null>(null)
  const [providerType, setProviderType] = useState<string | null>(null)
  const [namingAvailable, setNamingAvailable] = useState(false)
  const [naming, setNaming] = useState(false)
  const [tracers, setTracers] = useState<{ id: string; label: string }[]>([])
  const [selectedTracer, setSelectedTracer] = useState<string | null>(null)
  const [methodOpen, setMethodOpen] = useState(false)
  const methodRef = useRef<HTMLDivElement>(null)
  const [maskUrl, setMaskUrl] = useState<string | null>(null)
  const [maskVersion, setMaskVersion] = useState(0)
  const [imageVersion, setImageVersion] = useState(Date.now())
  const [copied, setCopied] = useState(false)
  const [showPrompt, setShowPrompt] = useState(false)
  const [traceStatus, setTraceStatus] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [includedPolygons, setIncludedPolygons] = useState<Set<string>>(new Set())
  const [hoveredPolygon, setHoveredPolygon] = useState<string | null>(null)
  const maskInputRef = useRef<HTMLInputElement>(null)
  const statusInterval = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    if (!methodOpen) return
    function handleClick(e: MouseEvent) {
      if (methodRef.current && !methodRef.current.contains(e.target as Node)) setMethodOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [methodOpen])

  useEffect(() => {
    async function load() {
      try {
        const [s, keys] = await Promise.all([
          getSession(sessionId),
          getAvailableKeys(),
        ])
        setSession(s)
        setHasEnvKey(keys.google)
        setNamingAvailable(keys.tool_naming)
        setProviderLabel(keys.provider_label)
        setProviderType(keys.provider)
        setTracers(keys.tracers || [])
        if (keys.tracers?.length) setSelectedTracer(keys.tracers[0].id)

        if (!keys.google) {
          setProvider('manual')
        }

        if (s.corners && s.corners.length === 4) {
          setLocalCorners(s.corners)
          setCornersAutoDetected(true)
        }
        if (s.paper_size) {
          setPaperSize(s.paper_size)
        } else {
          setPaperSize(getSettings().defaultPaperSize)
        }
        if (s.corrected_image_path) {
          setCorrectedImageUrl(`/storage/${s.corrected_image_path}`)
        }
        if (s.mask_image_path) {
          const maskRel = s.mask_image_path.replace(/^storage\//, '')
          setMaskUrl(`/storage/${maskRel}`)
        }
        if (s.polygons && s.polygons.length > 0) {
          setPolygons(s.polygons)
          setStep('edit')
        } else if (s.corrected_image_path) {
          setStep('trace')
        }
      } catch {
        setError('session not found')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [sessionId])

  useEffect(() => {
    if (session) {
      const path = step === 'corners' || !correctedImageUrl
        ? `/storage/${session.original_image_path}`
        : correctedImageUrl
      setImageUrl(getImageUrl(path))
    }
  }, [session, step, correctedImageUrl, sessionId])

  const singleTracer = tracers.length <= 1

  // re-run detection. `attempt` undefined = cascade through every strategy and
  // take the first hit; a number forces a specific fallback rung (the retry
  // button advances through them so we cover more cases automatically).
  async function runDetect(size: PaperSize, attempt?: number) {
    setRedetecting(true)
    setDetectFailed(false)
    try {
      const { corners: detected, attempt: used } = await detectCorners(sessionId, size, attempt)
      if (detected && detected.length === 4) {
        setLocalCorners(detected)
        setCornersAutoDetected(true)
        setDetectAttempt(used)
      } else {
        setDetectFailed(true)
      }
    } catch {
      setDetectFailed(true)
    } finally {
      setRedetecting(false)
    }
  }

  // picking the paper size the user actually used lets the backend constrain to
  // its aspect ratio (and re-runs detection live).
  function handleSelectPaperSize(size: PaperSize) {
    setPaperSize(size)
    runDetect(size)
  }

  // retry: advance to the next fallback strategy (wraps around)
  function handleRedetect() {
    runDetect(paperSize, (detectAttempt ?? -1) + 1)
  }

  async function handleCornersSubmit() {
    if (corners.length !== 4) return

    setProcessing(true)
    setError(null)

    try {
      const result = await setCorners(sessionId, corners, paperSize)
      setCorrectedImageUrl(result.corrected_image_url)
      setImageVersion(Date.now())
      // keep scale_factor current so the measurement overlay works without a reload
      setSession((s) => (s ? { ...s, scale_factor: result.scale_factor } : s))

      if (singleTracer && tracers.length === 1) {
        // single tracer: trace immediately without changing step
        setTraceStatus(TRACE_STEPS[0])
        let si = 0
        statusInterval.current = setInterval(() => {
          si = Math.min(si + 1, TRACE_STEPS.length - 1)
          setTraceStatus(TRACE_STEPS[si])
        }, 3000)

        try {
          const tid = tracers[0].id
          const traceResult = await traceTools(
            sessionId, 'google',
            hasEnvKey ? undefined : apiKey,
            tid,
          )
          setPolygons(traceResult.polygons)
          if (traceResult.mask_url) {
            setMaskUrl(traceResult.mask_url)
            setMaskVersion(v => v + 1)
          }
          setStep('edit')
        } finally {
          if (statusInterval.current) {
            clearInterval(statusInterval.current)
            statusInterval.current = null
          }
          setTraceStatus(null)
        }
        return
      }

      setStep('trace')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to process')
    } finally {
      setProcessing(false)
    }
  }

  async function handleTrace(tracerId?: string) {
    const tid = tracerId || selectedTracer
    if (tid === 'gemini' && !hasEnvKey && !apiKey.trim()) {
      setError('please enter your API key')
      return
    }

    setProcessing(true)
    setError(null)
    setTraceStatus(TRACE_STEPS[0])

    // cycle through status messages while waiting
    let stepIndex = 0
    statusInterval.current = setInterval(() => {
      stepIndex = Math.min(stepIndex + 1, TRACE_STEPS.length - 1)
      setTraceStatus(TRACE_STEPS[stepIndex])
    }, 3000)

    try {
      const result = await traceTools(
        sessionId,
        'google',
        hasEnvKey ? undefined : apiKey,
        tid || undefined,
      )
      setPolygons(result.polygons)
      if (result.mask_url) {
        setMaskUrl(result.mask_url)
        setMaskVersion((v) => v + 1)
      }
      setStep('edit')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'tracing failed')
    } finally {
      if (statusInterval.current) {
        clearInterval(statusInterval.current)
        statusInterval.current = null
      }
      setTraceStatus(null)
      setProcessing(false)
    }
  }

  async function handleMaskUpload(file: File) {
    setProcessing(true)
    setError(null)

    try {
      const result = await traceFromMask(sessionId, file)
      setPolygons(result.polygons)
      if (result.mask_url) {
        setMaskUrl(result.mask_url)
        setMaskVersion((v) => v + 1)
      }
      setStep('edit')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to process mask')
    } finally {
      setProcessing(false)
    }
  }

  function handleCopyPrompt() {
    navigator.clipboard.writeText(MASK_PROMPT)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  async function handleDownloadImage() {
    if (!correctedImageUrl) return
    try {
      const response = await fetch(getImageUrl(correctedImageUrl))
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `tracefinity-${sessionId.slice(0, 8)}.jpg`
      link.click()
      URL.revokeObjectURL(url)
    } catch {
      // fallback: open in new tab
      window.open(getImageUrl(correctedImageUrl), '_blank')
    }
  }

  const handlePolygonsChange = useCallback((updated: Polygon[]) => {
    setPolygons(updated)
  }, [])

  useDebouncedSave(
    () => updatePolygons(sessionId, polygons),
    [polygons, sessionId],
    300,
    { skipInitial: true }
  )

  // clear status interval on unmount (if user navigates away mid-trace)
  useEffect(() => {
    return () => {
      if (statusInterval.current) {
        clearInterval(statusInterval.current)
        statusInterval.current = null
      }
    }
  }, [])

  async function handleSaveToLibrary() {
    if (includedPolygons.size === 0) return
    setSaving(true)
    setError(null)
    try {
      await saveToolsFromSession(sessionId, Array.from(includedPolygons))
      router.push('/')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to save tools')
    } finally {
      setSaving(false)
    }
  }

  const canAutoName = namingAvailable || apiKey.trim().length > 0

  async function handleAutoName() {
    // name the selected tools, or all detected tools if none are selected
    const ids = includedPolygons.size > 0 ? Array.from(includedPolygons) : polygons.map(p => p.id)
    if (ids.length === 0) return
    setNaming(true)
    setError(null)
    try {
      const labels = await nameTools(sessionId, ids, hasEnvKey ? undefined : apiKey)
      if (Object.keys(labels).length > 0) {
        setPolygons(prev => prev.map(p => (labels[p.id] ? { ...p, label: labels[p.id] } : p)))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to name tools')
    } finally {
      setNaming(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 gap-2 text-text-muted">
        <Loader2 className="w-5 h-5 animate-spin" />
        <span>Loading session...</span>
      </div>
    )
  }

  if (error && !session) {
    return (
      <div className="max-w-md mx-auto py-12">
        <Alert variant="error">{error}</Alert>
      </div>
    )
  }

  const steps = singleTracer ? ['Corners', 'Save'] : ['Corners', 'Trace', 'Save']
  const stepIndex = singleTracer
    ? (step === 'corners' ? 0 : 1)
    : (step === 'corners' ? 0 : step === 'trace' ? 1 : 2)

  return (
    <div className="h-[calc(100dvh-44px)] flex flex-col w-full">
      <StepBar
        steps={steps}
        current={stepIndex}
        onStepClick={(i) => {
          if (i === 0) setStep('corners')
          else if (!singleTracer && i === 1 && correctedImageUrl) setStep('trace')
        }}
      />
      <div className="flex-1 flex flex-col-reverse md:flex-row min-h-0">
      {/* left sidebar - controls (below the canvas on mobile, left column on desktop) */}
      <div className="md:w-[240px] md:flex-shrink-0 bg-surface border-t md:border-t-0 md:border-r border-border overflow-y-auto flex flex-col max-h-[55vh] md:max-h-none">
        <div className="p-3 space-y-3">
          <div className="glass rounded-[10px] px-3 py-3">
            <h3 className="text-[10px] font-semibold text-text-muted uppercase tracking-widest mb-2">
              {step === 'corners' && (traceStatus ? 'Tracing...' : 'Adjust Corners')}
              {step === 'trace' && 'Trace Tools'}
              {step === 'edit' && 'Select Tools'}
            </h3>

          {step === 'corners' && (
            <div className="space-y-3">
              <CornersHint />
              {detectFailed ? (
                <div className="flex items-start gap-1.5 text-xs text-amber-300">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <p>
                    Couldn&apos;t find the paper automatically.{' '}
                    <span className="text-text-muted">Drag the corners to match it, or tap Re-detect to try other settings.</span>
                  </p>
                </div>
              ) : cornersAutoDetected ? (
                <div className="flex items-start gap-1.5 text-xs text-green-400">
                  <Check className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <p>
                    Paper edges detected automatically.{' '}
                    <span className="text-text-muted">Drag a handle only if a corner is off.</span>
                  </p>
                </div>
              ) : (
                <p className="text-xs text-text-muted">
                  Drag the corner handles to match the paper edges.
                </p>
              )}

              <div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-primary tracking-[0.3px]">Paper Size</span>
                  {redetecting && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-text-muted">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Re-detecting…
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-0.5 rounded-[10px] glass p-0.5 mt-1.5 w-full">
                  {PAPER_SIZE_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      onClick={() => handleSelectPaperSize(option.value)}
                      disabled={redetecting}
                      className={`h-7 px-2 rounded text-xs font-medium whitespace-nowrap disabled:opacity-60 ${
                        paperSize === option.value
                          ? 'bg-surface text-text-primary shadow-sm'
                          : 'text-text-muted hover:text-text-primary'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-text-muted leading-tight mt-1.5">
                  Picking your sheet re-detects the corners using its known proportions.
                </p>
              </div>

              <button
                onClick={handleRedetect}
                disabled={redetecting}
                className="btn-secondary w-full py-1.5 text-xs inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
                title="Try detecting the paper again with different settings"
              >
                {redetecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                Re-detect paper
              </button>
            </div>
          )}

          {step === 'trace' && (
            <div className="space-y-3">
              <TraceHint />
              {tracers.length > 1 && (
                <div className="relative" ref={methodRef}>
                  <span className="text-xs text-text-primary tracking-[0.3px]">Tracer</span>
                  <button
                    onClick={() => setMethodOpen(p => !p)}
                    className="w-full mt-1.5 px-3 py-1.5 rounded-[10px] glass text-xs font-medium text-text-primary flex items-center justify-between cursor-pointer"
                  >
                    <span>
                      {provider === 'manual'
                        ? 'Manual mask upload'
                        : tracers.find(t => t.id === selectedTracer)?.label || selectedTracer}
                    </span>
                    <ChevronDown className={`w-3 h-3 text-text-muted transition-transform ${methodOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {methodOpen && (
                    <div className="absolute left-0 right-0 mt-1 bg-surface border border-border rounded-lg py-1 z-40 shadow-xl">
                      {tracers.map(t => {
                        const active = provider !== 'manual' && selectedTracer === t.id
                        return (
                          <button
                            key={t.id}
                            onClick={() => { setSelectedTracer(t.id); setProvider('google'); setMethodOpen(false) }}
                            className={`w-full text-left px-3 py-1.5 text-xs transition-colors cursor-pointer flex items-center gap-2 ${
                              active ? 'text-accent' : 'text-text-secondary hover:bg-glass-hover hover:text-text-primary'
                            }`}
                          >
                            {active ? <Check className="w-3 h-3" /> : <span className="w-3" />}
                            {t.label}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}

              {provider === 'google' && (
                <>
                  {selectedTracer === 'gemini' && !hasEnvKey && (
                    <div>
                      <span className="text-xs text-text-primary tracking-[0.3px]">API Key</span>
                      <input
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        placeholder="AIza..."
                        className="w-full h-7 px-2 mt-1.5 text-xs border border-border-subtle rounded bg-elevated text-text-primary focus:outline-none focus:border-accent"
                      />
                      <p className="text-xs text-text-muted mt-1">
                        Sent directly to the API, not stored.
                      </p>
                    </div>
                  )}

                  {selectedTracer === 'gemini' && tracers.length > 1 && (
                    <div className="glass rounded-[10px] overflow-hidden">
                      <button
                        type="button"
                        onClick={() => setShowPrompt(!showPrompt)}
                        className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-text-secondary hover:bg-glass-hover transition-colors"
                      >
                        <span>What we send to the model</span>
                        {showPrompt ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                      </button>
                      {showPrompt && (
                        <div className="px-3 py-2 bg-elevated border-t border-border-subtle">
                          <pre className="text-xs text-text-secondary whitespace-pre-wrap">{MASK_PROMPT}</pre>
                        </div>
                      )}
                    </div>
                  )}

                  {traceStatus && (
                    <div className="flex items-center gap-2 text-xs text-text-muted">
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500" />
                      <span>{traceStatus}</span>
                    </div>
                  )}

                  {selectedTracer === 'gemini' && tracers.length > 1 && !processing && (
                    <button
                      onClick={() => setProvider('manual')}
                      className="text-xs text-accent/70 hover:text-accent underline underline-offset-2 decoration-accent/30 hover:decoration-accent transition-colors cursor-pointer"
                    >
                      Upload a mask manually
                    </button>
                  )}
                </>
              )}

              {provider === 'manual' && (
                <div className="space-y-3">
                  <div>
                    <p className="text-xs text-text-secondary mb-1.5">
                      1. Download the corrected image:
                    </p>
                    <button
                      onClick={handleDownloadImage}
                      className="btn-secondary w-full py-1.5 text-sm inline-flex items-center justify-center gap-1.5"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Download Image
                    </button>
                  </div>

                  <div>
                    <p className="text-xs text-text-secondary mb-1.5">
                      2. Copy this prompt:
                    </p>
                    <div className="relative">
                      <pre className="text-xs bg-elevated p-2 rounded border border-border-subtle whitespace-pre-wrap">
                        {MASK_PROMPT}
                      </pre>
                      <button
                        onClick={handleCopyPrompt}
                        className="absolute top-1.5 right-1.5 p-1 bg-elevated rounded border border-border-subtle hover:bg-border-subtle transition-colors"
                      >
                        {copied ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                      </button>
                    </div>
                  </div>

                  <div>
                    <p className="text-xs text-text-secondary mb-1.5">
                      3. Upload to <a href="https://gemini.google.com" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">gemini.google.com</a>, then upload the mask:
                    </p>
                    <input
                      ref={maskInputRef}
                      type="file"
                      accept="image/*"
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) handleMaskUpload(file)
                      }}
                      className="hidden"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 'edit' && (
            <div className="space-y-3">
              <EditHint />
              <p className="text-xs text-text-muted">
                {polygons.length === 0
                  ? 'No tools were detected.'
                  : includedPolygons.size === 0
                    ? 'Click outlines to select which tools to save.'
                    : `${includedPolygons.size} of ${polygons.length} selected. Click to add or remove.`}
              </p>

              {polygons.length > 0 && canAutoName && (
                <button
                  onClick={handleAutoName}
                  disabled={naming}
                  className="btn-secondary w-full py-1.5 text-xs inline-flex items-center justify-center gap-1.5"
                  title="Use AI to name the tools from their photos. You can edit names before saving."
                >
                  {naming ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                  {naming
                    ? 'Naming...'
                    : includedPolygons.size > 0
                      ? `Auto-name ${includedPolygons.size} selected`
                      : 'Auto-name tools'}
                </button>
              )}

              {polygons.length > 0 && !canAutoName && (
                <p className="text-[11px] text-text-muted leading-snug">
                  <Sparkles className="w-3 h-3 inline-block mr-1 -mt-0.5" />
                  Tip: set <code className="text-text-secondary">OPENROUTER_API_KEY</code>,{' '}
                  <code className="text-text-secondary">GOOGLE_API_KEY</code>, or{' '}
                  <code className="text-text-secondary">OLLAMA_BASE_URL</code> on the server to
                  auto-name tools with AI. You can also type names below.
                </p>
              )}

              {polygons.length > 0 && (
                <div className="text-xs space-y-0.5">
                  {polygons.map((p) => {
                    const isIncluded = includedPolygons.has(p.id)
                    return (
                      <div
                        key={p.id}
                        onClick={() => {
                          const next = new Set(includedPolygons)
                          if (next.has(p.id)) next.delete(p.id)
                          else next.add(p.id)
                          setIncludedPolygons(next)
                        }}
                        className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                          isIncluded
                            ? 'bg-accent-muted text-accent'
                            : hoveredPolygon === p.id
                              ? 'bg-elevated text-text-primary'
                              : 'text-text-muted hover:bg-elevated hover:text-text-secondary'
                        }`}
                      >
                        <div className={`w-3.5 h-3.5 rounded-sm border flex items-center justify-center flex-shrink-0 transition-colors ${
                          isIncluded ? 'bg-accent border-accent' : 'border-border-subtle'
                        }`}>
                          {isIncluded && <Check className="w-2.5 h-2.5 text-white" />}
                        </div>
                        <input
                          value={p.label}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            const value = e.target.value
                            setPolygons(prev => prev.map(q => (q.id === p.id ? { ...q, label: value } : q)))
                          }}
                          className="flex-1 min-w-0 bg-transparent outline-none truncate rounded px-1 focus:bg-elevated focus:text-text-primary"
                          aria-label={`Tool name for ${p.label}`}
                        />
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
          </div>

          {step === 'edit' && maskUrl && (
            <div className="glass rounded-[10px] px-3 py-3">
              <h3 className="text-[10px] font-semibold text-text-muted uppercase tracking-widest mb-2">Mask</h3>
              <img
                src={`${getImageUrl(maskUrl)}?v=${maskVersion}`}
                alt="Generated mask"
                className="w-full rounded-lg border border-border-subtle"
              />
            </div>
          )}

          {error && (
            <div className="relative">
              <Alert variant="error">
                <span className="pr-4 block">{error}</span>
              </Alert>
              <button
                onClick={() => setError(null)}
                aria-label="Dismiss"
                className="absolute top-1.5 right-1.5 text-text-muted hover:text-text-primary"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        <div className="p-3 space-y-2 sticky bottom-0 bg-surface border-t border-border md:static md:border-t-0 md:mt-auto">
          {step === 'corners' && (
            <button
              onClick={handleCornersSubmit}
              disabled={corners.length !== 4 || processing}
              className="btn-primary w-full py-2 text-sm inline-flex items-center justify-center gap-1.5"
            >
              {processing && <Loader2 className="w-4 h-4 animate-spin" />}
              {traceStatus || (processing ? 'Processing...' : 'Continue')}
            </button>
          )}

          {step === 'trace' && provider === 'google' && (tracers.length > 1 || processing) && (
            <button
              onClick={() => handleTrace()}
              disabled={(selectedTracer === 'gemini' && !hasEnvKey && !apiKey.trim()) || processing}
              className="btn-primary w-full py-2 text-sm inline-flex items-center justify-center gap-1.5"
            >
              {processing && <Loader2 className="w-4 h-4 animate-spin" />}
              {processing ? 'Tracing...' : 'Trace Tools'}
            </button>
          )}

          {step === 'trace' && provider === 'manual' && (
            <button
              onClick={() => maskInputRef.current?.click()}
              disabled={processing}
              className="btn-primary w-full py-2 text-sm inline-flex items-center justify-center gap-1.5"
            >
              {processing ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Processing...
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4" />
                  Upload Mask
                </>
              )}
            </button>
          )}

          {step === 'edit' && (
            <>
              <button
                onClick={handleSaveToLibrary}
                disabled={includedPolygons.size === 0 || saving}
                className="btn-primary w-full py-2 text-sm inline-flex items-center justify-center gap-1.5"
              >
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                {saving ? 'Saving...' : includedPolygons.size === 0 ? 'Select tools to save' : `Save ${includedPolygons.size} tool${includedPolygons.size === 1 ? '' : 's'}`}
              </button>
              <button
                onClick={() => setStep('trace')}
                className="btn-secondary w-full py-1.5 text-sm inline-flex items-center justify-center"
              >
                Re-trace
              </button>
            </>
          )}
        </div>
      </div>

      {/* image area */}
      <div className="flex-1 min-h-0 bg-base overflow-hidden p-3">
        {step === 'corners' && (
          <PaperCornerEditor
            imageUrl={imageUrl}
            corners={corners}
            onCornersChange={setLocalCorners}
          />
        )}

        {(step === 'trace' || step === 'edit') && correctedImageUrl && (
          <PolygonEditor
            key={`${correctedImageUrl}-${imageVersion}`}
            imageUrl={`${getImageUrl(correctedImageUrl)}?v=${imageVersion}`}
            polygons={polygons}
            onPolygonsChange={handlePolygonsChange}
            editable={step === 'edit'}
            included={step === 'edit' ? includedPolygons : undefined}
            onIncludedChange={step === 'edit' ? setIncludedPolygons : undefined}
            hovered={step === 'edit' ? hoveredPolygon : undefined}
            onHoveredChange={step === 'edit' ? setHoveredPolygon : undefined}
            scaleFactor={session?.scale_factor}
          />
        )}
      </div>
      </div>
    </div>
  )
}
