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


_PROMPT = """You split Thai transcripts into very short TikTok-style subtitle lines.

You receive a list of words prefixed with their index (e.g. "[0]สวัสดี [1]ครับ").
Return ONLY {"break_after": [int,...]} — the 0-indexed word positions that END
each line. Do not include the last word's index (it's implicit).

CORE RULE: Each segment = ONE complete conversational unit — a full sentence,
a question, a list item with its verdict, or a short standalone phrase. Do NOT
break within a single thought. A list-item pattern `<place> <verdict>ครับ`
(e.g. `ห้องน้ำโรงเรียนตอนพักเที่ยงอันไว้ก่อนนะครับ`) is ONE segment.

HARD RULES:
1. ALWAYS break after every `ครับ`/`คับ`/`ค่ะ`/`คะ` that ends a sentence.
   Every such occurrence in the word list MUST appear in break_after (unless
   it's the very last word).
2. Never split mid-compound: keep เด็กๆ, ห้องน้ำ+<place>, อันดับแรก together.
3. Keep `ห้องน้ำ` together with its location noun(s) ON THE SAME segment:
     ห้องน้ำโรงเรียน / ห้องน้ำรถทัวร์ / ห้องน้ำวัดป่า / ห้องน้ำร้านเหล้า /
     ห้องน้ำบนทางด่วน / ห้องน้ำเขาชนไก่ / ห้องน้ำอาจารย์ / ห้องน้ำสวนสาธารณะ
4. Never split between `นะ` and `ครับ`/`ค่ะ`/`คะ` — they're one particle.

WHAT STAYS TOGETHER (do NOT break inside these):
- A full question ending in `ครับ`/`นะครับ` — keep the whole question in ONE.
- A `<place> + <verdict>ครับ` list item — one segment, even if it runs 30-50
  characters (`ห้องน้ำโรงเรียนตอนพักเที่ยงอันไว้ก่อนนะครับ` = ONE segment).
- A conditional clause + resolution: `ถ้า...ก็...นะครับ` → one segment.
- Adjacent noun modifiers: `ห้องน้ำห้องเพื่อน` is one unit.

LENGTH: no fixed target. Segments are as long as the sentence demands. A
typical list-item sentence ends up 20-50 Thai characters — don't force-split
to shorten. An "อันดับแรกครับ" (13 chars) standalone is fine. A long
`แต่นี่ถือว่า...พอได้ครับ` (38) is fine. Never shorter than a full clause.

WORKED EXAMPLE (sentence-level, not line-level)
Input:
  [0]จัด [1]เทียร์ [2]ลิสต์ [3]ขี้ [4]ที่ [5]ไหน [6]สบาย [7]ตูด [8]ที่ [9]สุด
  [10]นะ [11]ครับ [12]อันดับ [13]แรก [14]ครับ [15]ห้อง [16]น้ำ [17]โรง [18]เรียน
  [19]ตอน [20]พัก [21]เที่ยง [22]อัน [23]ไว้ [24]ก่อน [25]นะ [26]ครับ
  [27]ห้อง [28]น้ำ [29]ห้อง [30]เพื่อน [31]ถ้า [32]ไม่ [33]สนิท [34]จริง
  [35]นี่ [36]ต้อง [37]บอก [38]ว่า [39]เลี่ยง [40]ได้ [41]เลี่ยง [42]นะ [43]ครับ
Output:
  {"break_after": [11, 14, 26, 43]}
This yields FOUR complete sentences:
  จัดเทียร์ลิสต์ขี้ที่ไหนสบายตูดที่สุดนะครับ (title question)
  อันดับแรกครับ (intro)
  ห้องน้ำโรงเรียนตอนพักเที่ยงอันไว้ก่อนนะครับ (item + verdict, ONE segment)
  ห้องน้ำห้องเพื่อนถ้าไม่สนิทจริงนี่ต้องบอกว่าเลี่ยงได้เลี่ยงนะครับ (item + verdict)

Indices must be strictly increasing and each within [0, last-1].
"""


def _format_words(words: list[dict]) -> str:
    return " ".join(f"[{i}]{w['word']}" for i, w in enumerate(words))


def _join_thai_words(ws: list[str]) -> str:
    # Lazy import avoids a circular dep with chirp.py. Falls back to sibling
    # import when chirp.py is run as a subprocess (no package context).
    try:
        from transcriber.chirp import join_thai_words
    except ImportError:
        from chirp import join_thai_words
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


# Leading-word heuristics for the orphan merger.
# Particles → leftover from enforce_particle_breaks → merge BACKWARD.
_LEADING_PARTICLES = {"ครับ", "คับ", "ค่ะ", "คะ", "นะครับ", "นะคะ", "นะ"}
# Topic starters → a new clause is beginning → merge FORWARD with next.
_TOPIC_STARTERS = {
    "แต่", "และ", "หรือ", "ถ้า", "เมื่อ", "เดี๋ยว", "ต้อง", "ควร",
    "ผม", "คุณ", "ฉัน", "ผมคุณ",
}
_MIN_SEGMENT_CHARS = 7


def _merge_orphans(segments: list[dict]) -> list[dict]:
    """Post-process: absorb fragments shorter than _MIN_SEGMENT_CHARS and
    particle-only segments. Direction matters:
      - starts with a particle (e.g. "นะครับ" orphan) → merge BACKWARD
      - starts with a topic starter (e.g. "แต่นี่") → merge FORWARD
      - otherwise short → merge BACKWARD (safest default)
    Forward-merge needs a second pass because it can only resolve once the
    next segment has been admitted to the output.
    """
    if not segments:
        return []

    def first_word(text: str) -> str:
        return text.split()[0] if text else ""

    # Pass 1: decide merge direction for each segment
    out: list[dict] = []
    pending_forward: dict | None = None  # will attach to the NEXT segment
    for seg in segments:
        text = seg["text"].strip()
        fw = first_word(text)
        too_short = len(text) < _MIN_SEGMENT_CHARS
        is_orphan_particle = fw in _LEADING_PARTICLES
        is_topic_starter = fw in _TOPIC_STARTERS

        if pending_forward is not None:
            # Prepend the pending fragment to this segment
            seg = {
                "start": pending_forward["start"],
                "end": seg["end"],
                "text": _join_thai_words([pending_forward["text"].strip(), text]),
            }
            pending_forward = None
            text = seg["text"].strip()
            fw = first_word(text)
            too_short = len(text) < _MIN_SEGMENT_CHARS
            is_orphan_particle = fw in _LEADING_PARTICLES
            is_topic_starter = fw in _TOPIC_STARTERS

        # Don't merge BACKWARD into a segment that already ended on a
        # Thai end particle — that was a clean sentence boundary.
        prev_ends_closed = bool(out) and any(
            out[-1]["text"].rstrip().endswith(p)
            for p in ("ครับ", "ค่ะ", "คะ", "คับ")
        )
        if out and is_orphan_particle:
            prev = out[-1]
            prev["end"] = seg["end"]
            prev["text"] = _join_thai_words([prev["text"].strip(), text])
            continue
        if out and too_short and not is_topic_starter and not prev_ends_closed:
            prev = out[-1]
            prev["end"] = seg["end"]
            prev["text"] = _join_thai_words([prev["text"].strip(), text])
            continue

        if too_short and is_topic_starter:
            pending_forward = dict(seg)
            continue

        out.append(dict(seg))

    # Trailing fragment with nowhere to forward-merge → attach to previous
    if pending_forward is not None and out:
        prev = out[-1]
        prev["end"] = pending_forward["end"]
        prev["text"] = _join_thai_words(
            [prev["text"].strip(), pending_forward["text"].strip()]
        )
    elif pending_forward is not None:
        out.append(pending_forward)
    return out


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
    return _merge_orphans(segments)


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
    model = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

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
                # Disable "thinking" — for a structured index-list task we want
                # Flash's normal 2-5s latency, not 150s+ of chain-of-thought.
                thinking_config=types.ThinkingConfig(thinking_budget=0),
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
