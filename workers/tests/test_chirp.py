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
