"""Unit tests for worker.py — no external services required."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

import worker


class TestEnv:
    def test_returns_value_when_set(self, monkeypatch):
        monkeypatch.setenv("TEST_KEY", "hello")
        assert worker.env("TEST_KEY") == "hello"

    def test_returns_default_when_missing(self, monkeypatch):
        monkeypatch.delenv("TEST_KEY", raising=False)
        assert worker.env("TEST_KEY", "fallback") == "fallback"

    def test_exits_when_missing_and_no_default(self, monkeypatch):
        monkeypatch.delenv("TEST_KEY", raising=False)
        with pytest.raises(SystemExit):
            worker.env("TEST_KEY")


class TestRetryCount:
    def test_zero_when_properties_none(self):
        assert worker.retry_count(None) == 0

    def test_zero_when_headers_none(self):
        props = SimpleNamespace(headers=None)
        assert worker.retry_count(props) == 0

    def test_zero_when_header_missing(self):
        props = SimpleNamespace(headers={})
        assert worker.retry_count(props) == 0

    def test_reads_x_retry_count_header(self):
        props = SimpleNamespace(headers={"x-retry-count": 2})
        assert worker.retry_count(props) == 2

    def test_coerces_string_header_to_int(self):
        props = SimpleNamespace(headers={"x-retry-count": "5"})
        assert worker.retry_count(props) == 5


class TestLoadDotenv:
    def test_loads_keys_from_dotenv(self, tmp_path, monkeypatch):
        env_file = tmp_path / ".env"
        env_file.write_text("NEW_KEY=value\n# comment\nQUOTED=\"hi\"\n")
        monkeypatch.setattr(worker, "HERE", tmp_path)
        monkeypatch.delenv("NEW_KEY", raising=False)
        monkeypatch.delenv("QUOTED", raising=False)

        worker._load_dotenv()

        import os
        assert os.environ["NEW_KEY"] == "value"
        assert os.environ["QUOTED"] == "hi"

    def test_existing_env_takes_precedence(self, tmp_path, monkeypatch):
        env_file = tmp_path / ".env"
        env_file.write_text("ALREADY_SET=fromfile\n")
        monkeypatch.setattr(worker, "HERE", tmp_path)
        monkeypatch.setenv("ALREADY_SET", "fromenv")

        worker._load_dotenv()

        import os
        assert os.environ["ALREADY_SET"] == "fromenv"

    def test_ignores_malformed_lines(self, tmp_path, monkeypatch):
        env_file = tmp_path / ".env"
        env_file.write_text("GOOD=1\nno_equals_line\n# comment\n\n")
        monkeypatch.setattr(worker, "HERE", tmp_path)
        monkeypatch.delenv("GOOD", raising=False)

        worker._load_dotenv()

        import os
        assert os.environ["GOOD"] == "1"
