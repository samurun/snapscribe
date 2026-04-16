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

export type LengthPreset = "auto" | "short" | "medium" | "long"

// "auto" is a sentinel — the edit page uses the server's segments field
// (Gemini-refined when LLM_SEGMENT_REFINER=1, otherwise rule-based) instead
// of re-grouping from words. The other presets override on the client.
export const LENGTH_PRESETS: Record<
  Exclude<LengthPreset, "auto">,
  { maxChars: number; maxDur: number; pauseSplit: number }
> = {
  short: { maxChars: 18, maxDur: 1.4, pauseSplit: 0.18 },
  medium: { maxChars: 28, maxDur: 2.2, pauseSplit: 0.22 },
  long: { maxChars: 48, maxDur: 4.0, pauseSplit: 0.4 },
}

export const THAI_END_PARTICLES = new Set([
  "ครับ", "คับ", "ค่ะ", "คะ", "นะครับ", "นะคะ", "นะค่ะ",
  "ครับผม", "ค่ะคุณ", "เลยครับ", "เลยค่ะ",
  "ก็ได้", "ก็แล้วกัน", "ละ", "แล้ว",
])

export const MIN_CHARS = 6
const MIN_SPLIT_GAP = 0.06

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

export function groupSegments(
  words: Word[],
  preset: Exclude<LengthPreset, "auto">,
): Segment[] {
  const { maxChars, maxDur, pauseSplit } = LENGTH_PRESETS[preset]
  const out: Segment[] = []
  let cur: Word[] = []

  const curText = () => joinThaiWords(cur.map((w) => w.word))

  const emit = (end: number) => {
    if (!cur.length) return
    const text = curText().trim()
    if (text) out.push({ start: cur[0]!.start, end, text })
    cur = []
  }

  const splitAt = (idx: number) => {
    if (idx <= 0 || idx >= cur.length) {
      emit(cur[cur.length - 1]!.end)
      return
    }
    const head = cur.slice(0, idx)
    const tail = cur.slice(idx)
    const text = joinThaiWords(head.map((w) => w.word)).trim()
    if (text) {
      out.push({
        start: head[0]!.start,
        end: head[head.length - 1]!.end,
        text,
      })
    }
    cur = tail
  }

  const bestGapIndex = (): [number, number] => {
    let bestI = 0
    let bestGap = -1
    for (let i = 1; i < cur.length; i++) {
      const gap = cur[i]!.start - cur[i - 1]!.end
      if (gap > bestGap) {
        bestI = i
        bestGap = gap
      }
    }
    return [bestI, bestGap]
  }

  for (const w of words) {
    if (cur.length) {
      const gap = w.start - cur[cur.length - 1]!.end
      if (gap >= pauseSplit && curText().length >= MIN_CHARS) {
        emit(cur[cur.length - 1]!.end)
      }
    }
    cur.push(w)
    const token = w.word.trim()
    const last = token.slice(-1)
    if (".?!。？！".includes(last)) {
      emit(w.end)
      continue
    }
    if (THAI_END_PARTICLES.has(token) && curText().length >= MIN_CHARS) {
      emit(w.end)
      continue
    }
    const tooLong = curText().length >= maxChars
    const tooSlow = w.end - cur[0]!.start >= maxDur
    if (tooLong || tooSlow) {
      const [idx, gap] = bestGapIndex()
      if (idx >= 1 && gap >= MIN_SPLIT_GAP) splitAt(idx)
      else emit(w.end)
    }
  }
  if (cur.length) emit(cur[cur.length - 1]!.end)

  const merged: Segment[] = []
  for (const seg of out) {
    const prev = merged[merged.length - 1]
    if (prev && seg.text.length < MIN_CHARS) {
      prev.end = seg.end
      prev.text = joinThaiWords([prev.text, seg.text])
    } else {
      merged.push(seg)
    }
  }
  return merged
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
