import { describe, expect, it } from "vitest"
import {
  buildSrt,
  fmtClock,
  fmtSrt,
  groupSegments,
  isThai,
  joinThaiWords,
  parseClock,
  type Word,
} from "../lib/transcript"

describe("isThai", () => {
  it("detects Thai characters", () => {
    expect(isThai("ก")).toBe(true)
    expect(isThai("๙")).toBe(true)
  })
  it("rejects latin + digits", () => {
    expect(isThai("a")).toBe(false)
    expect(isThai("1")).toBe(false)
    expect(isThai(" ")).toBe(false)
  })
})

describe("joinThaiWords", () => {
  it("joins thai characters without space", () => {
    expect(joinThaiWords(["สวัสดี", "ครับ"])).toBe("สวัสดีครับ")
  })
  it("adds space between latin words", () => {
    expect(joinThaiWords(["hello", "world"])).toBe("hello world")
  })
  it("attaches punctuation to previous token without space", () => {
    expect(joinThaiWords(["hello", ",", "world"])).toBe("hello, world")
  })
  it("attaches opening bracket to next token without space", () => {
    expect(joinThaiWords(["(", "hello"])).toBe("(hello")
  })
  it("skips empty entries", () => {
    expect(joinThaiWords(["", "hi", ""])).toBe("hi")
  })
})

describe("fmtSrt", () => {
  it("formats seconds to SRT timestamp", () => {
    expect(fmtSrt(0)).toBe("00:00:00,000")
    expect(fmtSrt(1.5)).toBe("00:00:01,500")
    expect(fmtSrt(61)).toBe("00:01:01,000")
    expect(fmtSrt(3661.123)).toBe("01:01:01,123")
  })
})

describe("fmtClock", () => {
  it("formats seconds to mm:ss.cs", () => {
    expect(fmtClock(0)).toBe("00:00.00")
    expect(fmtClock(5.25)).toBe("00:05.25")
    expect(fmtClock(125.5)).toBe("02:05.50")
  })
  it("clamps invalid input to zero", () => {
    expect(fmtClock(NaN)).toBe("00:00.00")
    expect(fmtClock(-1)).toBe("00:00.00")
    expect(fmtClock(Infinity)).toBe("00:00.00")
  })
})

describe("parseClock", () => {
  it("parses mm:ss format", () => {
    expect(parseClock("01:30")).toBe(90)
    expect(parseClock("00:05.5")).toBe(5.5)
  })
  it("parses raw seconds", () => {
    expect(parseClock("42")).toBe(42)
    expect(parseClock("3.14")).toBe(3.14)
  })
  it("returns null for invalid", () => {
    expect(parseClock("")).toBeNull()
    expect(parseClock("abc")).toBeNull()
    expect(parseClock("01:xx")).toBeNull()
  })
})

describe("buildSrt", () => {
  it("builds SRT from segments", () => {
    const srt = buildSrt([
      { start: 0, end: 1.5, text: "hello" },
      { start: 1.5, end: 3, text: "world" },
    ])
    expect(srt).toContain("1\n00:00:00,000 --> 00:00:01,500\nhello")
    expect(srt).toContain("2\n00:00:01,500 --> 00:00:03,000\nworld")
  })
  it("trims whitespace in text", () => {
    const srt = buildSrt([{ start: 0, end: 1, text: "  hi  " }])
    expect(srt).toContain("hi")
    expect(srt).not.toContain("  hi  ")
  })
})

describe("groupSegments", () => {
  const mk = (word: string, start: number, end: number): Word => ({
    word,
    start,
    end,
  })

  it("returns empty for no words", () => {
    expect(groupSegments([], 5)).toEqual([])
  })

  it("splits after every ครับ regardless of word count", () => {
    const words = [
      mk("สวัสดี", 0, 0.3),
      mk("ครับ", 0.3, 0.5),
      mk("วันนี้", 0.5, 0.8),
      mk("ดี", 0.8, 1),
      mk("ครับ", 1, 1.2),
    ]
    const segs = groupSegments(words, 8)
    expect(segs).toHaveLength(2)
    expect(segs[0]!.text).toBe("สวัสดีครับ")
    expect(segs[1]!.text).toBe("วันนี้ดีครับ")
  })

  it("breaks at the word-count budget", () => {
    const words = [
      mk("หนึ่ง", 0, 0.2),
      mk("สอง", 0.2, 0.4),
      mk("สาม", 0.4, 0.6),
      mk("สี่", 0.6, 0.8),
      mk("ห้า", 0.8, 1),
      mk("หก", 1, 1.2),
    ]
    const segs = groupSegments(words, 3)
    expect(segs).toHaveLength(2)
    expect(segs[0]!.text).toBe("หนึ่งสองสาม")
    expect(segs[1]!.text).toBe("สี่ห้าหก")
  })

  it("keeps ๆ glued to the previous word", () => {
    const words = [
      mk("เด็ก", 0, 0.2),
      mk("ๆ", 0.2, 0.3),
      mk("น่ารัก", 0.3, 0.6),
    ]
    // Budget of 3 — ๆ doesn't count against the budget, so all three
    // tokens fit in one segment with "เด็กๆ" kept intact.
    const segs = groupSegments(words, 3)
    expect(segs).toHaveLength(1)
    expect(segs[0]!.text).toContain("เด็กๆ")
  })

  it("timestamps come from the words at segment boundaries", () => {
    const words = [
      mk("หนึ่ง", 0.1, 0.3),
      mk("สอง", 0.3, 0.6),
      mk("ครับ", 0.6, 0.9),
    ]
    const segs = groupSegments(words, 5)
    expect(segs).toHaveLength(1)
    expect(segs[0]!.start).toBe(0.1)
    expect(segs[0]!.end).toBe(0.9)
  })
})

