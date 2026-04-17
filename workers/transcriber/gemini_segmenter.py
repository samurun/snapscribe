"""Gemini-based sentence segmenter for Thai transcripts.

Given word-level timings from Chirp, asks Gemini 2.5 Pro (Vertex AI) where
to break the transcript into TikTok-style subtitle lines. The LLM only
returns indices — timestamps are reconstructed from actual word timings.

Toggle off via env SEGMENTER=rules to fall back to group_segments.
"""
from __future__ import annotations

import json
import os
from typing import Optional


_PROMPT = """You split Thai transcripts into TikTok-style subtitle lines.

You receive a list of words prefixed with their index (e.g. "[0]สวัสดี [1]ครับ").
Return ONLY {"break_after": [int,...]} — the 0-indexed word positions that END
each line. Do not include the last word's index (it's implicit).

HARD RULES (do not violate):
1. ALWAYS break after every occurrence of: ครับ, คับ, ค่ะ, คะ, นะครับ, นะคะ, ครับผม.
2. EXCEPTION to rule 1: if the word AFTER ครับ is ผม, that ผม belongs to the
   PREVIOUS line as "ครับผม" (a compound end particle). Do NOT break between
   ครับ and a following ผม — break AFTER the ผม instead.
3. Never let a single line exceed ~35 Thai characters. If longer, split at
   the nearest natural boundary (topic shift / conjunction / pause).
4. Never split mid-compound: keep เด็กๆ, ห้องน้ำ, อันดับแรก, นะครับ, ครับผม,
   ไม่น่าจะ, อันไว together.
5. Break BEFORE new-topic starters when they begin a new thought:
   ห้อง, ตอน, ถ้า, เมื่อ, แต่, อันดับ, เดี๋ยว, คุณ.
6. Standalone interjections like แหม, โอ้, เอ๊ะ should be their own short line
   or attach to the following phrase — never tacked onto the end of a prior line.

SOFT PREFERENCES:
- Aim for 10-30 characters per line. Very short titles are OK.
- Every line should be a self-contained phrase, readable in 1-2 seconds.

Indices must be strictly increasing and each within [0, last-1].
"""


_THAI_NO_SPACE_BEFORE = set("ๆฯ")


def _join_thai_words(words: list[str]) -> str:
    out: list[str] = []
    for w in words:
        if not out:
            out.append(w)
            continue
        if w and w[0] in _THAI_NO_SPACE_BEFORE:
            out[-1] = out[-1] + w
        else:
            out.append(w)
    return "".join(out)


_HARD_BREAK_PARTICLES = {
    "ครับ", "คับ", "ค่ะ", "คะ", "นะครับ", "นะคะ", "นะค่ะ", "ครับผม",
}


def _enforce_particle_breaks(words: list[dict], cuts: set[int]) -> set[int]:
    """Ensure every Thai end particle is a break boundary, except when the
    next word is ผม (then the ผม becomes the break point, giving ครับผม)."""
    last = len(words) - 1
    for i, w in enumerate(words):
        if i >= last:
            continue
        token = w["word"].strip()
        if token not in _HARD_BREAK_PARTICLES:
            continue
        if token == "ครับ" and i + 1 <= last and words[i + 1]["word"].strip() == "ผม":
            cuts.add(i + 1)
            cuts.discard(i)
        else:
            cuts.add(i)
    return cuts


def _rebuild(words: list[dict], break_after: list[int]) -> list[dict]:
    last = len(words) - 1
    cuts = {i for i in break_after if 0 <= i < last}
    cuts = _enforce_particle_breaks(words, cuts)
    cuts = sorted(cuts)
    cuts.append(last)
    segments: list[dict] = []
    start = 0
    for end in cuts:
        chunk = words[start : end + 1]
        if not chunk:
            start = end + 1
            continue
        text = _join_thai_words([w["word"] for w in chunk]).strip()
        if text:
            segments.append({
                "start": chunk[0]["start"],
                "end": chunk[-1]["end"],
                "text": text,
            })
        start = end + 1
    return segments


def segment_with_gemini(words: list[dict]) -> Optional[list[dict]]:
    """Ask Gemini for phrase-boundary breaks over word timings.

    Returns refined segments, or None if the LLM is unreachable / fails —
    the caller should fall back to the rule-based grouping in that case.
    """
    if not words:
        return []

    try:
        from google import genai
        from google.genai import types
        from pydantic import BaseModel
    except ImportError as e:
        print(f"[segmenter] missing dependency: {e}", flush=True)
        return None

    project = os.environ.get("GCP_PROJECT")
    if not project:
        print("[segmenter] GCP_PROJECT not set; skipping Gemini pass", flush=True)
        return None
    location = os.environ.get("GCP_LOCATION", "us-central1")
    model = os.environ.get("GEMINI_SEGMENTER_MODEL", "gemini-2.5-pro")

    class BreakList(BaseModel):
        break_after: list[int]

    prefix = " ".join(f"[{i}]{w['word']}" for i, w in enumerate(words))
    try:
        client = genai.Client(vertexai=True, project=project, location=location)
        response = client.models.generate_content(
            model=model,
            contents=[_PROMPT, prefix],
            config=types.GenerateContentConfig(
                temperature=0.0,
                response_mime_type="application/json",
                response_schema=BreakList,
            ),
        )
    except Exception as e:
        print(f"[segmenter] Gemini call failed: {e}", flush=True)
        return None

    try:
        data = json.loads(response.text)
        breaks = [int(i) for i in data.get("break_after", [])]
    except (json.JSONDecodeError, AttributeError, TypeError, ValueError) as e:
        print(f"[segmenter] invalid JSON from Gemini: {e}", flush=True)
        return None

    return _rebuild(words, breaks)
