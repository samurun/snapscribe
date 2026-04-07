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

export async function fetchJobs(): Promise<JobView[]> {
  const res = await fetch(`${API_BASE}/jobs`, { cache: "no-store" })
  if (!res.ok) throw new Error(`fetchJobs ${res.status}`)
  const data = (await res.json()) as { jobs: JobView[] }
  return data.jobs
}

export async function fetchJob(id: string): Promise<JobView> {
  const res = await fetch(`${API_BASE}/jobs/${id}`, { cache: "no-store" })
  if (!res.ok) throw new Error(`fetchJob ${res.status}`)
  return (await res.json()) as JobView
}

export async function deleteJob(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/jobs/${id}`, { method: "DELETE" })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `delete failed: ${res.status}`)
  }
}

export async function runStep(
  id: string,
  step: "transcribe",
): Promise<JobView> {
  const res = await fetch(`${API_BASE}/jobs/${id}/${step}`, { method: "POST" })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `${step} failed: ${res.status}`)
  }
  return (await res.json()) as JobView
}
