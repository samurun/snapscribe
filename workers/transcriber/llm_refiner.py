"""Gemini-based re-segmentation pass for Chirp transcripts.

Given word-level timings from Chirp, this asks Gemini to choose where to
break the text into subtitle-style segments at natural phrase boundaries.
The LLM only returns the INDEX of the last word in each segment — timestamps
are always reconstructed from the actual word timings to avoid hallucination.

Uses Vertex AI so the existing GCP service account is reused (no new key).
Toggled on via env LLM_SEGMENT_REFINER=1.
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
1. ALWAYS break after every occurrence of: ครับ, คับ, ค่ะ, คะ, นะครับ, นะคะ.
   If you see ครับ in the middle of the word list, that position MUST be in break_after.
2. Never let a single line exceed ~35 Thai characters. If a phrase is long,
   split it at a sub-phrase boundary (topic shift, conjunction, conditional).
3. Never split mid-compound: keep เด็กๆ, ห้องน้ำ, อันดับแรก, นะครับ together.
4. Break BEFORE new-topic starters when they begin a new thought:
   ห้อง, ตอน, ถ้า, เมื่อ, แต่, อันดับ, เดี๋ยว.

SOFT PREFERENCES:
- Aim for 10-25 characters per line. Very short titles (like "อันดับแรกครับ") are OK.
- Every line should be a self-contained phrase, readable in 1-2 seconds.

WORKED EXAMPLE
Input:
  [0]จัด [1]เทียร์ [2]ลิสต์ [3]ขี้ [4]ที่ [5]ไหน [6]สบาย [7]ตูด [8]ที่ [9]สุด
  [10]นะ [11]ครับ [12]อันดับ [13]แรก [14]ครับ [15]ห้อง [16]น้ำ [17]โรง [18]เรียน
  [19]ตอน [20]พัก [21]เที่ยง [22]อัน [23]ไว้ [24]ก่อน [25]นะ [26]ครับ
  [27]ห้อง [28]น้ำ [29]ห้อง [30]เพื่อน [31]ถ้า [32]ไม่ [33]สนิท [34]จริง
  [35]นี่ [36]ต้อง [37]บอก [38]ว่า [39]เลี่ยง [40]ได้ [41]เลี่ยง [42]นะ [43]ครับ
Output:
  {"break_after": [2, 11, 14, 18, 21, 26, 30, 35, 43]}
This yields lines:
  จัดเทียร์ลิสต์ / ขี้ที่ไหนสบายตูดที่สุดนะครับ / อันดับแรกครับ / ห้องน้ำโรงเรียน /
  ตอนพักเที่ยง / อันไว้ก่อนนะครับ / ห้องน้ำห้องเพื่อน / ถ้าไม่สนิทจริงนี่ /
  ต้องบอกว่าเลี่ยงได้เลี่ยงนะครับ

Indices must be strictly increasing and each within [0, last-1].
"""


def _format_words(words: list[dict]) -> str:
    return " ".join(f"[{i}]{w['word']}" for i, w in enumerate(words))


def _join_thai_words(ws: list[str]) -> str:
    # Lazy import to avoid a circular import with chirp.py
    from transcriber.chirp import join_thai_words
    return join_thai_words(ws)


# Hard-enforced particle breaks — Gemini sometimes skips these.
_HARD_BREAK_PARTICLES = {
    "ครับ", "คับ", "ค่ะ", "คะ", "นะครับ", "นะคะ", "นะค่ะ", "ครับผม",
}


def _enforce_particle_breaks(words: list[dict], cuts: set[int]) -> set[int]:
    """Ensure every Thai end particle is a break boundary. The LLM occasionally
    forgets one, so we enforce it deterministically as a safety net."""
    last = len(words) - 1
    for i, w in enumerate(words):
        if i >= last:
            continue
        if w["word"].strip() in _HARD_BREAK_PARTICLES:
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
        chunk = words[start:end + 1]
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


def refine_segments(words: list[dict]) -> Optional[list[dict]]:
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
        print(f"[llm_refiner] missing dependency: {e}", flush=True)
        return None

    project = os.environ.get("GCP_PROJECT")
    if not project:
        print("[llm_refiner] GCP_PROJECT not set; skipping", flush=True)
        return None
    location = os.environ.get("GCP_LOCATION", "us-central1")
    model = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash-lite")

    class BreakList(BaseModel):
        break_after: list[int]

    try:
        client = genai.Client(vertexai=True, project=project, location=location)
        response = client.models.generate_content(
            model=model,
            contents=[_PROMPT, _format_words(words)],
            config=types.GenerateContentConfig(
                temperature=0.0,
                response_mime_type="application/json",
                response_schema=BreakList,
            ),
        )
    except Exception as e:
        print(f"[llm_refiner] Gemini call failed: {e}", flush=True)
        return None

    try:
        data = json.loads(response.text)
        break_after = [int(i) for i in data.get("break_after", [])]
    except (json.JSONDecodeError, AttributeError, TypeError, ValueError) as e:
        print(f"[llm_refiner] invalid JSON from Gemini: {e}", flush=True)
        return None

    return _rebuild(words, break_after)
