"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Badge } from "@workspace/ui/components/badge"
import { Progress } from "@workspace/ui/components/progress"
import {
  STATUS_VARIANT,
  deleteJob,
  fetchJob,
  fetchJobs,
  runStep,
  type JobView,
} from "@/lib/api"

export default function Page() {
  const [history, setHistory] = useState<JobView[]>([])
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [pendingJobId, setPendingJobId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const router = useRouter()
  const autoOpenedRef = useRef<string | null>(null)

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await fetchJobs())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    refreshHistory()
    const t = setInterval(refreshHistory, 3000)
    return () => clearInterval(t)
  }, [refreshHistory])

  // Auto-open editor when the job we kicked off finishes
  useEffect(() => {
    if (!pendingJobId) return
    const job = history.find((j) => j.id === pendingJobId)
    if (
      job &&
      job.transcribe.status === "done" &&
      job.outputs.json &&
      autoOpenedRef.current !== job.id
    ) {
      autoOpenedRef.current = job.id
      router.push(`/jobs/${job.id}/edit`)
    }
  }, [history, pendingJobId, router])

  async function handleUpload(f: File) {
    setError(null)
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append(
        "file",
        f,
      )
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001"}/jobs`,
        { method: "POST", body: fd },
      )
      if (!res.ok) throw new Error(`upload failed: ${res.status}`)
      const created = (await res.json()) as JobView
      setPendingJobId(created.id)
      autoOpenedRef.current = null
      refreshHistory()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ""
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this job and its files?")) return
    setError(null)
    // Optimistic remove
    setHistory((prev) => prev.filter((j) => j.id !== id))
    if (pendingJobId === id) setPendingJobId(null)
    try {
      await deleteJob(id)
      refreshHistory()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      refreshHistory()
    }
  }

  async function rerun(id: string) {
    setError(null)
    try {
      const job = await runStep(id, "transcribe")
      setPendingJobId(job.id)
      autoOpenedRef.current = null
      refreshHistory()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // Light polling for the active job
  useEffect(() => {
    if (!pendingJobId) return
    const job = history.find((j) => j.id === pendingJobId)
    const inFlight =
      job?.transcribe.status === "queued" ||
      job?.transcribe.status === "running"
    if (!inFlight) return
    const t = setInterval(async () => {
      try {
        const fresh = await fetchJob(pendingJobId)
        setHistory((prev) =>
          prev.map((j) => (j.id === fresh.id ? fresh : j)),
        )
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    }, 1500)
    return () => clearInterval(t)
  }, [pendingJobId, history])

  return (
    <div className="min-h-svh bg-background">
      <header className="sticky top-0 z-20 border-b border-border/60 bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
          <Link
            href="/"
            className="flex items-center gap-2 font-semibold tracking-tight"
          >
            <span className="inline-block h-6 w-6 rounded-md bg-gradient-to-br from-primary to-primary/40" />
            SnapScribe
          </Link>
          <Badge variant="outline" className="text-xs">
            {process.env.NEXT_PUBLIC_APP_VERSION || "dev"}
          </Badge>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        <section className="mb-8 flex flex-col items-center gap-3 text-center">
          <Badge variant="secondary" className="text-xs">
            AI video editor
          </Badge>
          <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
            Transcribe.{" "}
            <span className="bg-gradient-to-br from-primary to-primary/50 bg-clip-text text-transparent">
              Edit. Ship.
            </span>
          </h1>
          <p className="max-w-xl text-sm text-muted-foreground sm:text-base">
            Drop a video and we&apos;ll transcribe it with Chirp. Re-run any
            past job from the history below.
          </p>
        </section>

        {/* Upload — fixed height so layout never jumps */}
        <section className="mb-6">
          <label
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              const f = e.dataTransfer.files?.[0]
              if (f) handleUpload(f)
            }}
            className={`flex h-44 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed text-center transition-colors ${
              dragOver
                ? "border-primary bg-primary/5"
                : "border-border/70 bg-card hover:bg-muted/30"
            }`}
          >
            <div className="rounded-full bg-primary/10 p-3 text-xl text-primary">
              ↑
            </div>
            <p className="text-sm font-medium">
              {uploading
                ? "Uploading…"
                : "Drop a video here or click to browse"}
            </p>
            <p className="text-xs text-muted-foreground">
              MP4 · MOV · WebM — press Transcribe in History when ready
            </p>
            <Input
              ref={inputRef}
              type="file"
              accept="video/*"
              disabled={uploading}
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) handleUpload(f)
              }}
            />
          </label>
          {uploading && <Progress value={50} className="mt-3" />}
        </section>

        {error && (
          <div className="mb-6 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* History */}
        <section
          id="history"
          className="rounded-xl border border-border/60 bg-card shadow-sm"
        >
          <div className="flex items-center justify-between border-b border-border/60 px-5 py-3">
            <h2 className="text-sm font-semibold">History</h2>
            <span className="text-xs text-muted-foreground">
              {history.length} job{history.length === 1 ? "" : "s"}
            </span>
          </div>
          {history.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              No jobs yet. Drop a video above to get started.
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {history.map((j) => (
                <HistoryRow
                  key={j.id}
                  job={j}
                  highlight={j.id === pendingJobId}
                  onRerun={() => rerun(j.id)}
                  onDelete={() => remove(j.id)}
                />
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  )
}

function HistoryRow({
  job,
  highlight,
  onRerun,
  onDelete,
}: {
  job: JobView
  highlight: boolean
  onRerun: () => void
  onDelete: () => void
}) {
  const status = job.transcribe.status
  const inFlight = status === "queued" || status === "running"
  const done = status === "done" && !!job.outputs.json
  return (
    <li
      className={`flex items-center gap-4 px-5 py-3 transition-colors ${
        highlight ? "bg-primary/5" : ""
      }`}
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{job.inputName}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {job.id.slice(0, 8)} · {new Date(job.createdAt).toLocaleString()}
        </span>
        {inFlight && (
          <Progress value={job.transcribe.progress} className="mt-2 h-1" />
        )}
        {status === "error" && job.transcribe.error && (
          <span className="mt-1 text-xs text-destructive">
            {job.transcribe.error}
          </span>
        )}
      </div>

      <Badge variant={STATUS_VARIANT[status]} className="text-[10px]">
        {inFlight ? `${job.transcribe.progress}%` : status}
      </Badge>

      <div className="flex shrink-0 gap-2">
        {done && (
          <Button asChild size="sm">
            <Link href={`/jobs/${job.id}/edit`}>Open</Link>
          </Button>
        )}
        <Button
          size="sm"
          variant={done ? "outline" : "default"}
          onClick={onRerun}
          disabled={inFlight}
        >
          {inFlight ? "…" : done ? "Re-run" : "Transcribe"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onDelete}
          disabled={inFlight}
          className="text-muted-foreground hover:text-destructive"
          aria-label="Delete job"
          title="Delete"
        >
          ✕
        </Button>
      </div>
    </li>
  )
}
