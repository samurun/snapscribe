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
  const mkWord = (word: string, start: number, end: number): Word => ({
    word,
    start,
    end,
  })

  it("returns empty for no words", () => {
    expect(groupSegments([], "short")).toEqual([])
  })

  it("splits on sentence-ending punctuation", () => {
    const words = [
      mkWord("hello", 0, 0.5),
      mkWord("world.", 0.5, 1),
      mkWord("next", 1, 1.5),
      mkWord("sentence", 1.5, 2),
    ]
    const segs = groupSegments(words, "long")
    expect(segs.length).toBe(2)
    expect(segs[0]!.text).toContain("hello")
    expect(segs[0]!.text).toContain("world")
    expect(segs[1]!.text).toContain("next")
  })

  it("splits on large pauses (pauseSplit threshold)", () => {
    const words = [
      mkWord("สวัสดีครับ", 0, 1),
      mkWord("วันนี้อากาศดี", 2, 3),
    ]
    const segs = groupSegments(words, "short")
    expect(segs.length).toBe(2)
  })

  it("splits on Thai end particle", () => {
    const words = [
      mkWord("สวัสดี", 0, 0.5),
      mkWord("ครับ", 0.5, 1),
      mkWord("วันนี้", 1.05, 1.5),
      mkWord("ดีจัง", 1.5, 2),
    ]
    const segs = groupSegments(words, "long")
    expect(segs.length).toBeGreaterThanOrEqual(2)
    expect(segs[0]!.text).toContain("ครับ")
  })

  it("respects maxChars on short preset", () => {
    const words = Array.from({ length: 20 }, (_, i) =>
      mkWord(`word${i}`, i * 0.1, i * 0.1 + 0.09),
    )
    const segs = groupSegments(words, "short")
    // short preset maxChars = 18 — should split multiple times
    expect(segs.length).toBeGreaterThan(1)
  })

  it("segments have monotonically non-decreasing start times", () => {
    const words = [
      mkWord("a", 0, 0.3),
      mkWord("b", 0.3, 0.6),
      mkWord("c.", 0.6, 0.9),
      mkWord("d", 0.9, 1.2),
      mkWord("e", 1.2, 1.5),
    ]
    const segs = groupSegments(words, "medium")
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i]!.start).toBeGreaterThanOrEqual(segs[i - 1]!.start)
    }
  })
})
