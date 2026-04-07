"""
Phase 2 (alt) — Transcription via Google Cloud Speech-to-Text v2 (Chirp).

Drop-in replacement for transcribe.py from the worker's perspective.
Same CLI surface (--srt, --json, --language) plus Chirp-specific flags.
Output JSON adds a `words[]` array so the web editor can re-group
segments by sentence length on the client without another API call.

Usage (same as Whisper version):
    python chirp.py input.mp4 --srt out.srt --json out.json
    python chirp.py input.mp4 --language th-TH --model chirp_2

Auth: uses Application Default Credentials. Run `gcloud auth
application-default login` once on the host.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

SAMPLE_RATE = 16000
AUDIO_EXTS = {".wav", ".flac"}
SYNC_MAX_SECONDS = 55  # sync recognize hard-cap


def ensure_ffmpeg() -> None:
    if shutil.which("ffmpeg") is None:
        raise SystemExit("ffmpeg not found on PATH — install FFmpeg first")


def extract_wav(src: Path, dst: Path) -> None:
    proc = subprocess.run(
        ["ffmpeg", "-y", "-i", str(src), "-vn", "-ac", "1",
         "-ar", str(SAMPLE_RATE), "-c:a", "pcm_s16le", str(dst)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr.decode("utf-8", "replace"))
        raise SystemExit("ffmpeg audio extraction failed")


def probe_duration(path: Path) -> float:
    proc = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if proc.returncode != 0:
        return 0.0
    try:
        return float(proc.stdout.decode().strip())
    except ValueError:
        return 0.0


def fmt_ts(seconds: float) -> str:
    if seconds < 0:
        seconds = 0
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int(round((seconds - int(seconds)) * 1000))
    if ms == 1000:
        s += 1
        ms = 0
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def write_srt(segments: list[dict], path: Path) -> None:
    lines = []
    for i, seg in enumerate(segments, 1):
        lines.append(str(i))
        lines.append(f"{fmt_ts(seg['start'])} --> {fmt_ts(seg['end'])}")
        lines.append(seg["text"].strip())
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


# ---------- text grouping (mirrors web client logic) ----------

def _is_thai(ch: str) -> bool:
    return "\u0e00" <= ch <= "\u0e7f"


def join_thai_words(words: list[str]) -> str:
    out = ""
    for w in words:
        if not w:
            continue
        if not out:
            out = w
            continue
        prev_last = out[-1]
        cur_first = w[0]
        if cur_first in ",.!?;:)]}»。、！？：；":
            out += w
        elif prev_last in "([{«":
            out += w
        elif _is_thai(prev_last) and _is_thai(cur_first):
            out += w
        else:
            out += " " + w
    return out


# Thai sentence-ending particles. After any of these, we force a break —
# Chirp doesn't add Thai punctuation so this is the only natural cue.
THAI_END_PARTICLES = {
    "ครับ", "คับ", "ค่ะ", "คะ", "นะครับ", "นะคะ", "นะค่ะ",
    "ครับผม", "ค่ะคุณ", "เลยครับ", "เลยค่ะ",
    "ก็ได้", "ก็แล้วกัน", "ละ", "แล้ว",
}


def group_segments(words: list[dict], max_chars: int = 28,
                   max_dur: float = 2.2,
                   pause_split: float = 0.22,
                   min_chars: int = 6,
                   min_split_gap: float = 0.06) -> list[dict]:
    """Group words into subtitle segments.

    Hard breaks: ASCII punctuation, Thai end particles, or pauses >= pause_split.
    Soft breaks (length/duration cap): instead of cutting at the last word,
    look back through the buffer and split at the word with the largest
    preceding gap — gives much more natural sentence boundaries when the
    speaker pauses mid-thought.
    """
    out: list[dict] = []
    cur: list[dict] = []

    def cur_text() -> str:
        return join_thai_words([w["word"] for w in cur])

    def emit(end: float) -> None:
        nonlocal cur
        if not cur:
            return
        text = cur_text().strip()
        if text:
            out.append({"start": cur[0]["start"], "end": end, "text": text})
        cur = []

    def split_at(idx: int) -> None:
        """Emit cur[:idx] as a segment, keep cur[idx:] as the new cur."""
        nonlocal cur
        if idx <= 0 or idx >= len(cur):
            emit(cur[-1]["end"])
            return
        head, tail = cur[:idx], cur[idx:]
        text = join_thai_words([w["word"] for w in head]).strip()
        if text:
            out.append({
                "start": head[0]["start"],
                "end": head[-1]["end"],
                "text": text,
            })
        cur = tail

    def best_gap_index() -> tuple[int, float]:
        """Index inside cur where the preceding gap is largest."""
        best_i, best_gap = 0, -1.0
        for i in range(1, len(cur)):
            gap = cur[i]["start"] - cur[i - 1]["end"]
            if gap > best_gap:
                best_i, best_gap = i, gap
        return best_i, best_gap

    for w in words:
        # Hard pause break (between previous word and this one)
        if cur:
            gap = w["start"] - cur[-1]["end"]
            if gap >= pause_split and len(cur_text()) >= min_chars:
                emit(cur[-1]["end"])

        cur.append(w)
        token = w["word"].strip()

        # ASCII punctuation → hard break
        if token.endswith((".", "?", "!", "。", "？", "！")):
            emit(w["end"])
            continue
        # Thai end particle → break if we have enough text
        if token in THAI_END_PARTICLES and len(cur_text()) >= min_chars:
            emit(w["end"])
            continue
        # Soft cap: too long → split at the BEST internal gap
        too_long = len(cur_text()) >= max_chars
        too_slow = w["end"] - cur[0]["start"] >= max_dur
        if too_long or too_slow:
            idx, gap = best_gap_index()
            if idx >= 1 and gap >= min_split_gap:
                split_at(idx)
            else:
                emit(w["end"])

    if cur:
        emit(cur[-1]["end"])

    # Merge tiny tail fragments back into the previous segment
    merged: list[dict] = []
    for seg in out:
        if merged and len(seg["text"]) < min_chars:
            prev = merged[-1]
            prev["end"] = seg["end"]
            prev["text"] = join_thai_words([prev["text"], seg["text"]])
        else:
            merged.append(seg)
    return merged


# ---------- Chirp recognize ----------

def _build_config(language: str, model: str):
    from google.cloud.speech_v2.types import cloud_speech
    return cloud_speech.RecognitionConfig(
        auto_decoding_config=cloud_speech.AutoDetectDecodingConfig(),
        language_codes=[language],
        model=model,
        features=cloud_speech.RecognitionFeatures(
            enable_word_time_offsets=True,
            enable_automatic_punctuation=True,
        ),
    )


def recognize_sync(client, recognizer: str, audio_path: Path,
                   language: str, model: str) -> list:
    from google.cloud.speech_v2.types import cloud_speech
    config = _build_config(language, model)
    content = audio_path.read_bytes()
    request = cloud_speech.RecognizeRequest(
        recognizer=recognizer, config=config, content=content,
    )
    return list(client.recognize(request=request).results)


def recognize_batch(client, recognizer: str, audio_path: Path,
                    language: str, model: str, project: str,
                    bucket: str) -> list:
    from google.cloud import storage
    from google.cloud.speech_v2.types import cloud_speech

    blob_name = f"chirp/{uuid.uuid4()}{audio_path.suffix}"
    storage_client = storage.Client(project=project)
    bkt = storage_client.bucket(bucket)
    blob = bkt.blob(blob_name)
    print(f"[chirp] uploading to gs://{bucket}/{blob_name}", flush=True)
    blob.upload_from_filename(str(audio_path))
    gcs_uri = f"gs://{bucket}/{blob_name}"

    request = cloud_speech.BatchRecognizeRequest(
        recognizer=recognizer,
        config=_build_config(language, model),
        files=[cloud_speech.BatchRecognizeFileMetadata(uri=gcs_uri)],
        recognition_output_config=cloud_speech.RecognitionOutputConfig(
            inline_response_config=cloud_speech.InlineOutputConfig(),
        ),
    )
    print("[chirp] submitting batchRecognize…", flush=True)
    operation = client.batch_recognize(request=request)
    response = operation.result(timeout=3600)

    results: list = []
    for _uri, file_result in response.results.items():
        if file_result.error and file_result.error.code:
            raise RuntimeError(f"chirp error: {file_result.error.message}")
        if file_result.transcript:
            results.extend(file_result.transcript.results)

    try:
        blob.delete()
    except Exception:
        pass
    return results


def words_from_results(results) -> list[dict]:
    out: list[dict] = []
    for result in results:
        if not result.alternatives:
            continue
        alt = result.alternatives[0]
        for w in getattr(alt, "words", []) or []:
            out.append({
                "start": w.start_offset.total_seconds(),
                "end": w.end_offset.total_seconds(),
                "word": w.word,
            })
    return out


def main() -> None:
    p = argparse.ArgumentParser(description="Chirp transcriber")
    p.add_argument("input", type=Path)
    p.add_argument("--language", default="th-TH",
                   help="BCP-47 code (default: th-TH)")
    p.add_argument("--model", default="chirp_2",
                   help="chirp_2 (default) | chirp_3 | long")
    p.add_argument("--location", default="us-central1",
                   help="recognizer location (default: us-central1)")
    p.add_argument("--project", default=os.environ.get("GCP_PROJECT"),
                   help="GCP project ID (or env GCP_PROJECT)")
    p.add_argument("--bucket", default=os.environ.get("GCP_BUCKET"),
                   help="GCS bucket for batchRecognize (or env GCP_BUCKET)")
    p.add_argument("--srt", type=Path)
    p.add_argument("--json", dest="json_out", type=Path)
    args = p.parse_args()

    if not args.project:
        raise SystemExit("--project (or env GCP_PROJECT) is required")

    ensure_ffmpeg()
    if not args.input.exists():
        raise SystemExit(f"input not found: {args.input}")

    srt_path = args.srt or args.input.with_suffix(".srt")
    json_path = args.json_out or args.input.with_suffix(".json")

    try:
        from google.cloud.speech_v2 import SpeechClient
        from google.api_core.client_options import ClientOptions
    except ImportError:
        raise SystemExit(
            "google-cloud-speech not installed. Run:\n"
            "  cd workers && uv pip install google-cloud-speech google-cloud-storage"
        )

    if args.location == "global":
        client = SpeechClient()
    else:
        client = SpeechClient(client_options=ClientOptions(
            api_endpoint=f"{args.location}-speech.googleapis.com",
        ))
    recognizer = (
        f"projects/{args.project}/locations/{args.location}/recognizers/_"
    )

    with tempfile.TemporaryDirectory() as td:
        if args.input.suffix.lower() in AUDIO_EXTS:
            audio_path = args.input
        else:
            audio_path = Path(td) / "audio.wav"
            print(f"[chirp 1/3] extracting audio → {audio_path.name}", flush=True)
            extract_wav(args.input, audio_path)

        duration = probe_duration(audio_path)
        print(f"[chirp 2/3] duration={duration:.1f}s lang={args.language} "
              f"model={args.model} location={args.location}", flush=True)

        use_batch = duration > SYNC_MAX_SECONDS
        if use_batch and not args.bucket:
            raise SystemExit(
                f"audio is {duration:.0f}s — needs batchRecognize. "
                "Pass --bucket or set env GCP_BUCKET."
            )

        if use_batch:
            results = recognize_batch(
                client, recognizer, audio_path, args.language, args.model,
                args.project, args.bucket,
            )
        else:
            results = recognize_sync(
                client, recognizer, audio_path, args.language, args.model,
            )

    words = words_from_results(results)
    segments = group_segments(words)
    print(f"[chirp 3/3] {len(words)} words → {len(segments)} segments",
          flush=True)

    write_srt(segments, srt_path)
    json_path.write_text(json.dumps({
        "backend": f"chirp/{args.model}",
        "language": args.language,
        "duration": duration,
        "words": words,
        "segments": segments,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    # Cost report — batch ≈ $0.016/min, sync ≈ $0.024/min
    rate_per_min = 0.016 if use_batch else 0.024
    cost_usd = (duration / 60.0) * rate_per_min
    cost_thb = cost_usd * 36
    mode = "batch" if use_batch else "sync"
    print(
        f"[chirp $] {duration:.1f}s @ {mode} rate ${rate_per_min:.3f}/min "
        f"= ${cost_usd:.4f} USD (~฿{cost_thb:.2f})",
        flush=True,
    )
    print(f"done. → {srt_path.name}, {json_path.name}", flush=True)


if __name__ == "__main__":
    main()
