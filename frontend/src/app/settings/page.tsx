'use client'

import { useState, useEffect } from 'react'
import { Loader2, Check, KeyRound, Sliders } from 'lucide-react'
import { getConfig, updateConfig, type AppConfig } from '@/lib/api'
import { getSettings, saveSettings } from '@/lib/settings'
import { PAPER_SIZE_OPTIONS } from '@/lib/paper'
import { SLICERS, type SlicerId } from '@/lib/slicers'
import type { PaperSize } from '@/types'
import { Alert } from '@/components/Alert'
import { NumberField } from '@/components/NumberField'

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <span className="text-xs text-text-primary tracking-[0.3px]">{label}</span>
      {children}
      {hint && <p className="text-[11px] text-text-muted leading-tight">{hint}</p>}
    </div>
  )
}

const inputCls =
  'w-full h-8 px-2 text-xs bg-elevated border border-border-subtle rounded text-text-primary outline-none focus:border-accent'

export default function SettingsPage() {
  // --- server config (persisted in config.json) ---
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [openrouterKey, setOpenrouterKey] = useState('')
  const [googleKey, setGoogleKey] = useState('')
  const [ollamaUrl, setOllamaUrl] = useState('')
  const [ollamaModel, setOllamaModel] = useState('')
  const [geminiModel, setGeminiModel] = useState('')
  const [savingAi, setSavingAi] = useState(false)
  const [aiStatus, setAiStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // --- client defaults (localStorage) ---
  const [bedSize, setBedSize] = useState(256)
  const [paperSize, setPaperSize] = useState<PaperSize>('a4')
  const [slicer, setSlicer] = useState<SlicerId>('orcaslicer')

  useEffect(() => {
    getConfig()
      .then((c) => {
        setConfig(c)
        setOllamaUrl(c.ollama_base_url ?? '')
        setOllamaModel(c.ollama_label_model ?? '')
        setGeminiModel(c.gemini_label_model ?? '')
      })
      .catch(() => setError('Could not load server config'))
    const s = getSettings()
    setBedSize(s.bedSize)
    setPaperSize(s.defaultPaperSize)
    setSlicer(s.slicer)
  }, [])

  async function saveAi() {
    setSavingAi(true)
    setError(null)
    // only send secret keys when typed; always send the non-secret fields
    const patch: Record<string, string> = {
      ollama_base_url: ollamaUrl,
      ollama_label_model: ollamaModel,
      gemini_label_model: geminiModel,
    }
    if (openrouterKey.trim()) patch.openrouter_api_key = openrouterKey.trim()
    if (googleKey.trim()) patch.google_api_key = googleKey.trim()
    try {
      await updateConfig(patch)
      setOpenrouterKey('')
      setGoogleKey('')
      setConfig(await getConfig())
      setAiStatus('Saved')
      setTimeout(() => setAiStatus(null), 2000)
    } catch {
      setError('Failed to save server config')
    } finally {
      setSavingAi(false)
    }
  }

  async function clearKey(field: 'openrouter_api_key' | 'google_api_key') {
    try {
      await updateConfig({ [field]: '' })
      setConfig(await getConfig())
    } catch {
      setError('Failed to clear key')
    }
  }

  function KeyStatus({ configured }: { configured: boolean }) {
    return configured ? (
      <span className="inline-flex items-center gap-1 text-[11px] text-green-400">
        <Check className="w-3 h-3" /> configured
      </span>
    ) : (
      <span className="text-[11px] text-text-muted">not set</span>
    )
  }

  return (
    <div className="max-w-2xl mx-auto py-2 space-y-6">
      <h1 className="text-lg font-bold text-text-primary">Settings</h1>
      {error && <Alert variant="error">{error}</Alert>}

      {/* AI & naming -> server config.json */}
      <section className="glass rounded-[10px] p-4 space-y-4">
        <div className="flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold text-text-primary">AI &amp; Naming</h2>
        </div>
        <p className="text-[11px] text-text-muted leading-snug">
          Stored on the server (config.json), overriding environment variables. Enables
          automatic tool naming and Gemini tracing. Keys are write-only — they&apos;re never sent back.
        </p>

        <Field label="OpenRouter API key" hint="Used for tool naming via OpenRouter.">
          <div className="flex items-center gap-2">
            <input type="password" className={inputCls} placeholder={config?.openrouter_api_key_configured ? '•••••••• (set)' : 'sk-or-...'}
              value={openrouterKey} onChange={(e) => setOpenrouterKey(e.target.value)} autoComplete="off" />
            {config && <KeyStatus configured={config.openrouter_api_key_configured} />}
            {config?.openrouter_api_key_configured && (
              <button onClick={() => clearKey('openrouter_api_key')} className="text-[11px] text-text-muted hover:text-red-400">clear</button>
            )}
          </div>
        </Field>

        <Field label="Google (Gemini) API key" hint="Used for naming and the Gemini tracer.">
          <div className="flex items-center gap-2">
            <input type="password" className={inputCls} placeholder={config?.google_api_key_configured ? '•••••••• (set)' : 'AIza...'}
              value={googleKey} onChange={(e) => setGoogleKey(e.target.value)} autoComplete="off" />
            {config && <KeyStatus configured={config.google_api_key_configured} />}
            {config?.google_api_key_configured && (
              <button onClick={() => clearKey('google_api_key')} className="text-[11px] text-text-muted hover:text-red-400">clear</button>
            )}
          </div>
        </Field>

        <Field label="Ollama base URL" hint="Local Ollama for naming, e.g. http://192.168.2.78:11434 (needs a vision model).">
          <input type="text" className={inputCls} placeholder="http://host:11434" value={ollamaUrl} onChange={(e) => setOllamaUrl(e.target.value)} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Ollama model"><input type="text" className={inputCls} placeholder="llava" value={ollamaModel} onChange={(e) => setOllamaModel(e.target.value)} /></Field>
          <Field label="Naming model (Gemini/OpenRouter)"><input type="text" className={inputCls} placeholder="gemini-2.0-flash" value={geminiModel} onChange={(e) => setGeminiModel(e.target.value)} /></Field>
        </div>

        <div className="flex items-center gap-3">
          <button onClick={saveAi} disabled={savingAi} className="btn-primary px-4 py-1.5 text-xs inline-flex items-center gap-1.5">
            {savingAi && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Save
          </button>
          {aiStatus && <span className="text-[11px] text-green-400">{aiStatus}</span>}
        </div>
      </section>

      {/* defaults -> localStorage */}
      <section className="glass rounded-[10px] p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Sliders className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold text-text-primary">Defaults</h2>
        </div>
        <p className="text-[11px] text-text-muted leading-snug">Saved in this browser.</p>

        <Field label="Default bed size (mm)" hint="Bins wider than this are split into printable pieces.">
          <NumberField min={150} max={400} step={1} value={bedSize}
            onCommit={(v) => { setBedSize(v); saveSettings({ bedSize: v }) }}
            className="w-24 h-8 px-2 text-xs bg-elevated border border-border-subtle rounded text-text-primary text-right outline-none focus:border-accent" />
        </Field>

        <Field label="Default paper size">
          <div className="grid grid-cols-4 gap-0.5 rounded-[10px] glass p-0.5 max-w-xs">
            {PAPER_SIZE_OPTIONS.map((o) => (
              <button key={o.value} onClick={() => { setPaperSize(o.value); saveSettings({ defaultPaperSize: o.value }) }}
                className={`h-7 px-2 rounded text-xs font-medium ${paperSize === o.value ? 'bg-surface text-text-primary shadow-sm' : 'text-text-muted hover:text-text-primary'}`}>
                {o.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Preferred slicer" hint='Used by "Send to slicer" on the bin export menu.'>
          <div className="grid grid-cols-3 gap-0.5 rounded-[10px] glass p-0.5 max-w-xs">
            {SLICERS.map((s) => (
              <button key={s.id} onClick={() => { setSlicer(s.id); saveSettings({ slicer: s.id }) }}
                className={`h-7 px-1 rounded text-[11px] font-medium ${slicer === s.id ? 'bg-surface text-text-primary shadow-sm' : 'text-text-muted hover:text-text-primary'}`}>
                {s.label.replace(' Studio', '')}
              </button>
            ))}
          </div>
        </Field>
      </section>
    </div>
  )
}
