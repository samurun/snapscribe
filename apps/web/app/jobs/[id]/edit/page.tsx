"use client"

import Link from "next/link"
import { use, useEffect, useRef, useState } from "react"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Textarea } from "@workspace/ui/components/textarea"
import { Badge } from "@workspace/ui/components/badge"
import { useApi, type JobView } from "@/lib/api"
import {
  DEFAULT_PRESET,
  LENGTH_PRESETS,
  buildSrt,
  fmtClock,
  groupSegments,
  parseClock,
  type LengthPreset,
  type Segment,
  type Word,
} from "@/lib/transcript"

interface CutJson {
  language?: string
  duration?: number
  segments: Segment[]
  words?: Word[]
}

function download(name: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

export default function EditPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = use(params)
  const [job, setJob] = useState<JobView | null>(null)
  const [data, setData] = useState<CutJson | null>(null)
  const [segments, setSegments] = useState<Segment[]>([])
  const [error, setError] = useState<string | null>(null)
  const [activeIdx, setActiveIdx] = useState<number | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [preset, setPreset] = useState<LengthPreset>(DEFAULT_PRESET)
  const videoRef = useRef<HTMLVideoElement>(null)
  const rowRefs = useRef<Array<HTMLDivElement | null>>([])
  const api = useApi()
  const [cutVideoUrl, setCutVideoUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const j = await api.fetchJob(id)
        if (cancelled) return
        setJob(j)
        if (!j.outputs.json) {
          setError("transcript not ready yet — run transcribe first")
          return
        }
        const res = await api.fetchArtifact(j.outputs.json)
        const cut = (await res.json()) as CutJson
        if (cancelled) return
        setData(cut)
        setSegments(
          cut.segments?.length
            ? cut.segments
            : cut.words?.length
              ? groupSegments(cut.words, 5)
              : [],
        )
        setPreset(cut.segments?.length ? "auto" : 5)
        setDirty(false)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id, api])

  // Sync video → active segment + currentTime
  useEffect(() => {
    if (!cutVideoUrl) return
    const v = videoRef.current
    if (!v) return
    const onTime = () => {
      const t = v.currentTime
      setCurrentTime(t)
      const idx = segments.findIndex((s) => t >= s.start && t < s.end)
      setActiveIdx(idx === -1 ? null : idx)
    }
    v.addEventListener("timeupdate", onTime)
    return () => v.removeEventListener("timeupdate", onTime)
  }, [segments, cutVideoUrl])

  // Auto-scroll active row into view
  useEffect(() => {
    if (activeIdx == null) return
    const el = rowRefs.current[activeIdx]
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [activeIdx])

  useEffect(() => {
    const path = job?.outputs.inputVideo
    if (!path) {
      setCutVideoUrl(null)
      return
    }
    let url: string | null = null
    let cancelled = false
    ;(async () => {
      try {
        const res = await api.fetchArtifact(path)
        const blob = await res.blob()
        if (cancelled) return
        url = URL.createObjectURL(blob)
        setCutVideoUrl(url)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [job, api])

  function applyPreset(next: LengthPreset) {
    if (
      dirty &&
      !confirm("Re-grouping will discard your text edits. Continue?")
    ) {
      return
    }
    setPreset(next)
    if (next === "auto") {
      setSegments(data?.segments ?? [])
    } else if (data?.words?.length) {
      setSegments(groupSegments(data.words, next))
    }
    setDirty(false)
  }

  const liveCaption = activeIdx != null ? segments[activeIdx]?.text : ""

  function patchSegment(i: number, patch: Partial<Segment>) {
    setSegments((prev) =>
      prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
    )
    setDirty(true)
  }

  function deleteSegment(i: number) {
    setSegments((prev) => prev.filter((_, idx) => idx !== i))
    setDirty(true)
  }

  function jumpTo(t: number) {
    const v = videoRef.current
    if (!v) return
    v.currentTime = Math.max(0, t)
  }

  function exportSrt() {
    download(`${id}.srt`, buildSrt(segments), "application/x-subrip")
  }

  function exportJson() {
    const out = { ...(data ?? {}), segments }
    download(`${id}.json`, JSON.stringify(out, null, 2), "application/json")
  }

  if (error) {
    return (
      <div className="bg-background min-h-svh">
        <div className="mx-auto max-w-3xl p-6">
          <p className="text-destructive">{error}</p>
          <Button asChild variant="link">
            <Link href="/">← back</Link>
          </Button>
        </div>
      </div>
    )
  }

  if (!job || !data) {
    return (
      <div className="bg-background min-h-svh">
        <div className="mx-auto max-w-3xl p-6">
          <p className="text-muted-foreground text-sm">Loading…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-background min-h-svh">
      <header className="border-border/60 bg-background/80 sticky top-0 z-20 border-b backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="flex items-center gap-2 font-semibold tracking-tight"
            >
              <span className="from-primary to-primary/40 inline-block h-6 w-6 rounded-md bg-gradient-to-br" />
              SnapScribe
            </Link>
            <span className="text-muted-foreground text-xs">/ editor</span>
          </div>
          <div className="flex items-center gap-2">
            {data?.words?.length || data?.segments?.length ? (
              <div className="border-border/60 flex items-center gap-0 rounded-md border p-0.5">
                {LENGTH_PRESETS.map((p) => {
                  const disabled =
                    p === "auto"
                      ? !data?.segments?.length
                      : !data?.words?.length
                  return (
                    <button
                      key={p}
                      onClick={() => applyPreset(p)}
                      disabled={disabled}
                      className={`rounded px-2 py-1 text-xs transition-colors ${
                        preset === p
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      } disabled:opacity-40`}
                    >
                      {p === "auto" ? "Auto" : `${p} words`}
                    </button>
                  )
                })}
              </div>
            ) : null}
            {dirty && (
              <Badge variant="outline" className="text-xs">
                unsaved
              </Badge>
            )}
            <Button asChild variant="ghost" size="sm">
              <Link href="/">← back</Link>
            </Button>
            <Button onClick={exportSrt} size="sm">
              Export SRT
            </Button>
            <Button onClick={exportJson} variant="secondary" size="sm">
              Export JSON
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-6 py-6 lg:grid-cols-[1.2fr_1fr]">
        <section className="flex min-w-0 flex-col gap-4">
          <div className="border-border/60 bg-card relative overflow-hidden rounded-xl border shadow-sm">
            {cutVideoUrl && (
              <video
                ref={videoRef}
                src={cutVideoUrl}
                controls
                className="aspect-video w-full bg-black"
              />
            )}
            {liveCaption && (
              <div className="pointer-events-none absolute inset-x-0 bottom-10 flex justify-center px-4">
                <div className="max-w-[85%] rounded-md bg-black/75 px-4 py-2 text-center text-base font-medium text-white shadow-lg backdrop-blur-sm">
                  {liveCaption}
                </div>
              </div>
            )}
          </div>

          <div className="border-border/60 bg-card rounded-xl border p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-sm font-semibold" title={job.inputName}>{job.inputName}</h2>
                <p className="text-muted-foreground text-xs">
                  {data.language ?? "?"} ·{" "}
                  {data.duration ? `${data.duration.toFixed(1)}s` : "?"} ·{" "}
                  {segments.length} segments
                </p>
              </div>
              <Badge variant="secondary" className="font-mono text-xs">
                {fmtClock(currentTime)}
              </Badge>
            </div>
            <p className="text-muted-foreground text-xs leading-relaxed">
              Edit text on the right — the caption above updates instantly.
              Adjust start/end to fine-tune timing, then export.
            </p>
          </div>
        </section>

        <section className="border-border/60 bg-card flex max-h-[calc(100svh-7rem)] flex-col overflow-hidden rounded-xl border shadow-sm">
          <div className="border-border/60 border-b px-4 py-3">
            <h3 className="text-sm font-semibold">Transcript</h3>
            <p className="text-muted-foreground text-xs">
              Click # to jump. Edits stay in your browser until you export.
            </p>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            <div className="flex flex-col gap-2">
              {segments.map((seg, i) => {
                const active = activeIdx === i
                return (
                  <div
                    key={i}
                    ref={(el) => {
                      rowRefs.current[i] = el
                    }}
                    onClick={() => jumpTo(seg.start)}
                    className={`cursor-pointer rounded-lg border p-3 transition-colors ${
                      active
                        ? "border-primary/50 bg-primary/5"
                        : "border-border/60 hover:bg-muted/40"
                    }`}
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <button
                        onClick={() => jumpTo(seg.start)}
                        className="text-muted-foreground hover:text-foreground font-mono text-xs"
                        title="jump to start"
                      >
                        #{i + 1}
                      </button>
                      <Input
                        defaultValue={fmtClock(seg.start)}
                        onBlur={(e) => {
                          const t = parseClock(e.target.value)
                          if (t != null) patchSegment(i, { start: t })
                          else e.target.value = fmtClock(seg.start)
                        }}
                        className="h-7 w-20 font-mono text-xs"
                      />
                      <span className="text-muted-foreground text-xs">→</span>
                      <Input
                        defaultValue={fmtClock(seg.end)}
                        onBlur={(e) => {
                          const t = parseClock(e.target.value)
                          if (t != null) patchSegment(i, { end: t })
                          else e.target.value = fmtClock(seg.end)
                        }}
                        className="h-7 w-20 font-mono text-xs"
                      />
                      <div className="flex-1" />
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2"
                        onClick={() => deleteSegment(i)}
                      >
                        ✕
                      </Button>
                    </div>
                    <Textarea
                      value={seg.text}
                      onChange={(e) =>
                        patchSegment(i, { text: e.target.value })
                      }
                      onFocus={() => jumpTo(seg.start)}
                      className="min-h-[52px] w-full resize-none text-sm field-sizing-fixed wrap-anywhere"
                    />
                  </div>
                )
              })}
            </div>
          </div>
        </section>
      </main>
    </div>
  )
}
