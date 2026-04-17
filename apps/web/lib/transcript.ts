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

// Segmentation presets. "auto" uses whatever the backend (Gemini) produced.
// Numeric presets re-group client-side: each segment gets up to N "real" words
// — the Thai repetition mark ๆ and end particles (นะครับ, นะคะ, etc.) never
// count against the budget, so "เด็กๆ" and "นะครับ" stay with their host word.
export type WordCountPreset = 3 | 5 | 8
export type LengthPreset = "auto" | WordCountPreset
export const LENGTH_PRESETS: LengthPreset[] = ["auto", 3, 5, 8]
export const DEFAULT_PRESET: LengthPreset = "auto"

// Thai particles that mark the end of a clause — always emit a segment here.
const THAI_END_PARTICLES = new Set([
  "ครับ", "คับ", "ค่ะ", "คะ", "ครับผม",
])
// Tokens that must never start a new segment — they stick to the previous
// word (Thai repetition mark, trailing "นะ" before particle).
const STICKY_TRAILING = new Set(["ๆ", "นะ"])

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

/**
 * Group words into segments using a word-count budget. Hard-breaks at Thai
 * end particles (ครับ/ค่ะ/คะ) and sticks ๆ / นะ to the preceding word so
 * compounds like "เด็กๆ" and "นะครับ" stay intact.
 */
export function groupSegments(
  words: Word[],
  wordsPerSegment: WordCountPreset,
): Segment[] {
  const out: Segment[] = []
  let cur: Word[] = []
  let realCount = 0

  const emit = () => {
    if (!cur.length) return
    const text = joinThaiWords(cur.map((w) => w.word)).trim()
    if (text) {
      out.push({ start: cur[0]!.start, end: cur[cur.length - 1]!.end, text })
    }
    cur = []
    realCount = 0
  }

  for (const w of words) {
    const token = w.word.trim()
    const isSticky = STICKY_TRAILING.has(token)
    const isEndParticle = THAI_END_PARTICLES.has(token)
    // Emit BEFORE this word if the budget is full and this word starts a new
    // real chunk. Sticky trailers (ๆ, นะ) and end particles (ครับ/ค่ะ/คะ)
    // always attach to the current segment instead of starting a new one.
    if (
      cur.length > 0 &&
      realCount >= wordsPerSegment &&
      !isSticky &&
      !isEndParticle
    ) {
      emit()
    }
    cur.push(w)
    if (!isSticky && !isEndParticle) {
      realCount++
    }
    // Hard break after a sentence-ending particle.
    if (isEndParticle) {
      emit()
    }
  }
  emit()
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
