import { describe, expect, it } from "vitest"
import {
  buildSrt,
  fmtClock,
  fmtSrt,
  isThai,
  joinThaiWords,
  parseClock,
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

