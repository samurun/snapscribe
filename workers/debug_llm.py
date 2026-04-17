"""Diagnostic: show Gemini's raw output vs each post-processing stage.

Usage:
    GCP_PROJECT=... GCP_LOCATION=us-central1 \
    GOOGLE_APPLICATION_CREDENTIALS=./secrets/gcp-sa.json \
    uv run python debug_llm.py path/to/cut.json

Prints 4 stages side-by-side so you can see exactly which step each
segment change comes from:
  1. Gemini raw break_after indices
  2. Segments from Gemini alone (no enforce/merge)
  3. + enforce_particle_breaks (force break after every ครับ/ค่ะ/คะ)
  4. + _merge_orphans (final output)
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    cut_path = Path(sys.argv[1])
    data = json.loads(cut_path.read_text())
    words = data["words"]

    from google import genai
    from google.genai import types
    from pydantic import BaseModel
    from transcriber.llm_refiner import (
        _PROMPT,
        _enforce_particle_breaks,
        _format_words,
        _join_thai_words,
        _merge_orphans,
    )

    project = os.environ["GCP_PROJECT"]
    location = os.environ.get("GCP_LOCATION", "us-central1")
    model = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

    class BreakList(BaseModel):
        break_after: list[int]

    print(f"=== INPUT: {cut_path.name} — {len(words)} words ===\n")
    t = time.time()
    client = genai.Client(vertexai=True, project=project, location=location)
    resp = client.models.generate_content(
        model=model,
        contents=[_PROMPT, _format_words(words)],
        config=types.GenerateContentConfig(
            temperature=0.0,
            response_mime_type="application/json",
            response_schema=BreakList,
            thinking_config=types.ThinkingConfig(thinking_budget=0),
        ),
    )
    dt = time.time() - t
    raw = json.loads(resp.text)
    breaks = raw["break_after"]
    print(f"=== STEP 1: Gemini raw ({model}, {dt:.1f}s) — {len(breaks)} breaks ===")
    print(f"  {breaks}\n")

    def rebuild(cuts: list[int]) -> list[dict]:
        out: list[dict] = []
        start = 0
        for end in cuts:
            chunk = words[start : end + 1]
            if chunk:
                text = _join_thai_words([w["word"] for w in chunk]).strip()
                if text:
                    out.append(
                        {
                            "start": chunk[0]["start"],
                            "end": chunk[-1]["end"],
                            "text": text,
                        }
                    )
            start = end + 1
        return out

    last = len(words) - 1
    cuts1 = sorted({i for i in breaks if 0 <= i < last}) + [last]
    segs1 = rebuild(cuts1)
    print(f"=== STEP 2: Gemini only → {len(segs1)} segments ===")
    for s in segs1:
        print(f"  [{len(s['text']):>2}]  {s['text']}")
    print()

    enforced = _enforce_particle_breaks(words, {i for i in breaks if 0 <= i < last})
    cuts2 = sorted(enforced) + [last]
    segs2 = rebuild(cuts2)
    added = set(cuts2) - set(cuts1)
    print(f"=== STEP 3: + enforce_particle_breaks → {len(segs2)} segments ===")
    print(f"  (added {len(added)} forced break(s) at indices {sorted(added)})")
    for s in segs2:
        print(f"  [{len(s['text']):>2}]  {s['text']}")
    print()

    final = _merge_orphans(segs2)
    print(f"=== STEP 4: + _merge_orphans → {len(final)} segments (FINAL) ===")
    for s in final:
        print(f"  [{len(s['text']):>2}]  {s['text']}")
    print()
    print(
        f"Summary: {len(breaks)} breaks → {len(segs1)} → +enforce "
        f"→ {len(segs2)} → +merge → {len(final)}"
    )

    # Save each stage so you can diff them in the IDE.
    out_path = cut_path.with_name(cut_path.stem + "_stages.json")
    out_path.write_text(
        json.dumps(
            {
                "model": model,
                "latency_seconds": round(dt, 2),
                "word_count": len(words),
                "gemini_raw_breaks": breaks,
                "step2_gemini_only": segs1,
                "step3_after_enforce_particles": segs2,
                "step4_final": final,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"\nwrote → {out_path.name}")


if __name__ == "__main__":
    main()
