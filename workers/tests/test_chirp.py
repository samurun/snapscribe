"""Unit tests for transcriber/chirp.py."""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from transcriber import chirp


class TestFmtTs:
    def test_zero(self):
        assert chirp.fmt_ts(0) == "00:00:00,000"

    def test_sub_second(self):
        assert chirp.fmt_ts(0.5) == "00:00:00,500"

    def test_minutes(self):
        assert chirp.fmt_ts(61) == "00:01:01,000"

    def test_hours_and_ms(self):
        assert chirp.fmt_ts(3661.123) == "01:01:01,123"

    def test_negative_clamps_to_zero(self):
        assert chirp.fmt_ts(-1) == "00:00:00,000"

    def test_rounds_up_at_ms_boundary(self):
        # 1.9999 → ms = 1000 → should roll over to "...02,000"
        assert chirp.fmt_ts(1.9999).endswith(",000")


class TestIsThaiAndJoin:
    def test_is_thai(self):
        assert chirp._is_thai("ก") is True
        assert chirp._is_thai("๙") is True
        assert chirp._is_thai("a") is False
        assert chirp._is_thai(" ") is False

    def test_join_thai_words_no_space(self):
        assert chirp.join_thai_words(["สวัสดี", "ครับ"]) == "สวัสดีครับ"

    def test_join_latin_with_space(self):
        assert chirp.join_thai_words(["hello", "world"]) == "hello world"

    def test_punctuation_attaches_to_prev(self):
        assert chirp.join_thai_words(["hi", ","]) == "hi,"

    def test_skips_empty(self):
        assert chirp.join_thai_words(["", "hi"]) == "hi"


class TestEnsureFfmpeg:
    def test_ok_when_ffmpeg_found(self, monkeypatch):
        monkeypatch.setattr(chirp.shutil, "which", lambda _: "/usr/bin/ffmpeg")
        chirp.ensure_ffmpeg()  # should not raise

    def test_raises_when_ffmpeg_missing(self, monkeypatch):
        monkeypatch.setattr(chirp.shutil, "which", lambda _: None)
        with pytest.raises(SystemExit):
            chirp.ensure_ffmpeg()


class TestProbeDuration:
    def test_parses_float_from_stdout(self, monkeypatch):
        monkeypatch.setattr(
            chirp.subprocess,
            "run",
            lambda *_a, **_kw: SimpleNamespace(
                returncode=0, stdout=b"12.34\n", stderr=b""
            ),
        )
        assert chirp.probe_duration(Path("fake.mp4")) == pytest.approx(12.34)

    def test_returns_zero_on_error(self, monkeypatch):
        monkeypatch.setattr(
            chirp.subprocess,
            "run",
            lambda *_a, **_kw: SimpleNamespace(
                returncode=1, stdout=b"", stderr=b"boom"
            ),
        )
        assert chirp.probe_duration(Path("fake.mp4")) == 0.0

    def test_returns_zero_on_unparseable_stdout(self, monkeypatch):
        monkeypatch.setattr(
            chirp.subprocess,
            "run",
            lambda *_a, **_kw: SimpleNamespace(
                returncode=0, stdout=b"not a float\n", stderr=b""
            ),
        )
        assert chirp.probe_duration(Path("fake.mp4")) == 0.0


class TestGroupSegments:
    def test_empty(self):
        assert chirp.group_segments([]) == []

    def test_splits_on_thai_end_particle(self):
        words = [
            {"word": "สวัสดี", "start": 0.0, "end": 0.5},
            {"word": "ครับ", "start": 0.5, "end": 1.0},
            {"word": "วันนี้", "start": 1.05, "end": 1.5},
            {"word": "ดีจัง", "start": 1.5, "end": 2.0},
        ]
        segs = chirp.group_segments(words, max_chars=50)
        assert len(segs) >= 2
        assert "ครับ" in segs[0]["text"]

    def test_monotonic_timestamps(self):
        words = [
            {"word": "a", "start": i * 0.3, "end": i * 0.3 + 0.25}
            for i in range(5)
        ]
        segs = chirp.group_segments(words, max_chars=5)
        for i in range(1, len(segs)):
            assert segs[i]["start"] >= segs[i - 1]["start"]

    def test_defers_soft_cap_until_particle(self):
        # Chirp returns word-level timings with ~0s gaps between Thai words,
        # so without look-ahead the old max_chars=28 cap would split mid-phrase
        # (e.g. "...ต้องอัน" / "ไวก่อนนะครับ"). With defaults, the sentence
        # should finish on "ครับ" instead.
        words = [
            {"word": "ห้อง", "start": 19.00, "end": 19.20},
            {"word": "น้ำ",  "start": 19.20, "end": 19.44},
            {"word": "เขา",  "start": 19.44, "end": 19.72},
            {"word": "ชน",   "start": 19.72, "end": 19.96},
            {"word": "ไก่",  "start": 19.96, "end": 20.48},
            {"word": "อัน",  "start": 20.52, "end": 20.60},
            {"word": "นี้",  "start": 20.60, "end": 20.76},
            {"word": "ต้อง", "start": 20.76, "end": 21.08},
            {"word": "อัน",  "start": 21.08, "end": 21.36},
            {"word": "ไว",   "start": 21.36, "end": 21.56},
            {"word": "ก่อน", "start": 21.56, "end": 21.84},
            {"word": "นะ",   "start": 21.84, "end": 21.96},
            {"word": "ครับ", "start": 21.96, "end": 22.32},
        ]
        # Give max_chars headroom so defer has room to reach the particle —
        # this test verifies the defer mechanism, not the short-subtitle defaults.
        segs = chirp.group_segments(words, max_chars=44, hard_max_chars=60, lookahead=4)
        assert len(segs) == 1
        assert segs[0]["text"].endswith("ครับ")
        assert "อันไว" in segs[0]["text"]

    def test_thai_repetition_mark_stays_with_prev(self):
        # "เด็กๆ" must not get split across a segment boundary.
        words = [
            {"word": "ห้อง",   "start": 10.04, "end": 10.28},
            {"word": "เรียน",  "start": 10.28, "end": 10.56},
            {"word": "ตอน",    "start": 10.56, "end": 10.76},
            {"word": "อนุบาล", "start": 10.76, "end": 11.32},
            {"word": "แหม",    "start": 11.32, "end": 11.60},
            {"word": "ตอน",    "start": 11.60, "end": 11.80},
            {"word": "เด็ก",   "start": 11.80, "end": 11.92},
            {"word": "ๆ",       "start": 11.92, "end": 12.12},
            {"word": "มึง",    "start": 12.12, "end": 12.28},
            {"word": "ก็",     "start": 12.28, "end": 12.40},
            {"word": "อั้น",   "start": 12.40, "end": 12.72},
            {"word": "ครับ",   "start": 12.72, "end": 13.00},
        ]
        segs = chirp.group_segments(words, max_chars=44, hard_max_chars=60, lookahead=4)
        assert len(segs) == 1
        assert "เด็กๆ" in segs[0]["text"]
