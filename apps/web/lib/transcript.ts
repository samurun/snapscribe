export interface Segment {
  start: number
  end: number
  text: string
}

export interface Word {
  start: number
  end: number
  word: string
}

export function isThai(ch: string): boolean {
  const code = ch.charCodeAt(0)
  return code >= 0x0e00 && code <= 0x0e7f
}

export function joinThaiWords(words: string[]): string {
  let out = ""
  for (const w of words) {
    if (!w) continue
    if (!out) {
      out = w
      continue
    }
    const prev = out[out.length - 1]!
    const cur = w[0]!
    if (",.!?;:)]}»。、！？：；".includes(cur)) out += w
    else if ("([{«".includes(prev)) out += w
    else if (isThai(prev) && isThai(cur)) out += w
    else out += " " + w
  }
  return out
}

export function fmtSrt(t: number): string {
  const ms = Math.round((t - Math.floor(t)) * 1000)
  const total = Math.floor(t)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`
}

export function fmtClock(t: number): string {
  if (!isFinite(t) || t < 0) t = 0
  const total = Math.floor(t)
  const m = Math.floor(total / 60)
  const s = total % 60
  const ms = Math.round((t - total) * 100)
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(2, "0")}`
}

export function parseClock(v: string): number | null {
  const trimmed = v.trim()
  if (!trimmed) return null
  if (trimmed.includes(":")) {
    const [m, rest] = trimmed.split(":")
    const mm = Number(m)
    const ss = Number(rest)
    if (Number.isNaN(mm) || Number.isNaN(ss)) return null
    return mm * 60 + ss
  }
  const n = Number(trimmed)
  return Number.isNaN(n) ? null : n
}

export function buildSrt(segments: Segment[]): string {
  return segments
    .map(
      (seg, i) =>
        `${i + 1}\n${fmtSrt(seg.start)} --> ${fmtSrt(seg.end)}\n${seg.text.trim()}\n`,
    )
    .join("\n")
}
