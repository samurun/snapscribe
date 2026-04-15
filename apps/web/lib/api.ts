"use client"

import { useAuth } from "@clerk/nextjs"
import { useMemo } from "react"

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001"

export type StepStatus = "pending" | "queued" | "running" | "done" | "error"

export interface StepView {
  status: StepStatus
  progress: number
  error: string | null
  startedAt: string | null
  finishedAt: string | null
}

export interface JobView {
  id: string
  inputName: string
  createdAt: string
  transcribe: StepView
  outputs: {
    inputVideo: string | null
    srt: string | null
    json: string | null
  }
}

export const STATUS_VARIANT: Record<
  StepStatus,
  "secondary" | "default" | "destructive" | "outline"
> = {
  pending: "outline",
  queued: "outline",
  running: "secondary",
  done: "default",
  error: "destructive",
}

export type GetToken = () => Promise<string | null>

async function authHeaders(getToken: GetToken): Promise<HeadersInit> {
  const token = await getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export interface Api {
  fetchJobs(): Promise<JobView[]>
  fetchJob(id: string): Promise<JobView>
  deleteJob(id: string): Promise<void>
  runStep(id: string, step: "transcribe"): Promise<JobView>
  uploadJob(file: File): Promise<JobView>
  fetchArtifact(path: string): Promise<Response>
}

export function makeApi(getToken: GetToken): Api {
  return {
    async fetchJobs() {
      const res = await fetch(`${API_BASE}/jobs`, {
        cache: "no-store",
        headers: await authHeaders(getToken),
      })
      if (!res.ok) throw new Error(`fetchJobs ${res.status}`)
      const data = (await res.json()) as { jobs: JobView[] }
      return data.jobs
    },
    async fetchJob(id) {
      const res = await fetch(`${API_BASE}/jobs/${id}`, {
        cache: "no-store",
        headers: await authHeaders(getToken),
      })
      if (!res.ok) throw new Error(`fetchJob ${res.status}`)
      return (await res.json()) as JobView
    },
    async deleteJob(id) {
      const res = await fetch(`${API_BASE}/jobs/${id}`, {
        method: "DELETE",
        headers: await authHeaders(getToken),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `delete failed: ${res.status}`)
      }
    },
    async runStep(id, step) {
      const res = await fetch(`${API_BASE}/jobs/${id}/${step}`, {
        method: "POST",
        headers: await authHeaders(getToken),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `${step} failed: ${res.status}`)
      }
      return (await res.json()) as JobView
    },
    async uploadJob(file) {
      const fd = new FormData()
      fd.append("file", file)
      const res = await fetch(`${API_BASE}/jobs`, {
        method: "POST",
        body: fd,
        headers: await authHeaders(getToken),
      })
      if (!res.ok) throw new Error(`upload failed: ${res.status}`)
      return (await res.json()) as JobView
    },
    async fetchArtifact(path) {
      const res = await fetch(`${API_BASE}${path}`, {
        headers: await authHeaders(getToken),
      })
      if (!res.ok) throw new Error(`artifact ${res.status}`)
      return res
    },
  }
}

export function useApi(): Api {
  const { getToken } = useAuth()
  return useMemo(() => makeApi(() => getToken()), [getToken])
}
