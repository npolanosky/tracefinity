"""Tests for the optional, pluggable tool namer."""
import asyncio

import pytest

from app.config import settings
from app.services.tool_namer import (
    GeminiToolNamer,
    OllamaToolNamer,
    ToolNamer,
    clean_name,
    get_tool_namer,
    tool_naming_available,
)


class TestCleanName:
    def test_strips_and_lowercases_passthrough(self):
        assert clean_name("wrench") == "wrench"

    def test_takes_first_line(self):
        assert clean_name("phillips screwdriver\n(a tool)") == "phillips screwdriver"

    def test_strips_quotes_and_punctuation(self):
        assert clean_name('"needle nose pliers."') == "needle nose pliers"

    def test_empty_is_none(self):
        assert clean_name("") is None
        assert clean_name("   ") is None
        assert clean_name(None) is None

    def test_truncates_to_max_len(self):
        long = "a" * 100
        assert len(clean_name(long)) == 40


class TestGetToolNamer:
    def test_none_when_no_backend(self, monkeypatch):
        monkeypatch.setattr(settings, "google_api_key", None)
        monkeypatch.setattr(settings, "openrouter_api_key", None)
        monkeypatch.setattr(settings, "ollama_base_url", None)
        assert get_tool_namer() is None
        assert tool_naming_available() is False

    def test_ollama_when_only_ollama(self, monkeypatch):
        monkeypatch.setattr(settings, "google_api_key", None)
        monkeypatch.setattr(settings, "openrouter_api_key", None)
        monkeypatch.setattr(settings, "ollama_base_url", "http://192.168.2.78:11434")
        monkeypatch.setattr(settings, "ollama_label_model", "llava")
        namer = get_tool_namer()
        assert isinstance(namer, OllamaToolNamer)
        assert namer.base_url == "http://192.168.2.78:11434"
        assert namer.model == "llava"
        assert tool_naming_available() is True

    def test_openrouter_preferred_over_ollama(self, monkeypatch):
        monkeypatch.setattr(settings, "google_api_key", None)
        monkeypatch.setattr(settings, "openrouter_api_key", "o")
        monkeypatch.setattr(settings, "ollama_base_url", "http://x:11434")
        namer = get_tool_namer()
        assert isinstance(namer, GeminiToolNamer)

    def test_explicit_api_key_takes_precedence(self, monkeypatch):
        monkeypatch.setattr(settings, "google_api_key", None)
        monkeypatch.setattr(settings, "openrouter_api_key", None)
        namer = get_tool_namer("user-key")
        assert isinstance(namer, GeminiToolNamer)
        assert namer.api_key == "user-key"
        assert namer.openrouter_key is None

    def test_openrouter_preferred_over_google(self, monkeypatch):
        monkeypatch.setattr(settings, "google_api_key", "g")
        monkeypatch.setattr(settings, "openrouter_api_key", "o")
        namer = get_tool_namer()
        assert isinstance(namer, GeminiToolNamer)
        assert namer.openrouter_key == "o"

    def test_google_when_only_google(self, monkeypatch):
        monkeypatch.setattr(settings, "google_api_key", "g")
        monkeypatch.setattr(settings, "openrouter_api_key", None)
        namer = get_tool_namer()
        assert isinstance(namer, GeminiToolNamer)
        assert namer.api_key == "g"
        assert tool_naming_available() is True


class TestProtocol:
    def test_stub_satisfies_protocol_and_swaps_in(self):
        class StubNamer:
            async def name(self, image_png: bytes):
                return "stub tool"

        stub = StubNamer()
        assert isinstance(stub, ToolNamer)
        assert asyncio.run(stub.name(b"x")) == "stub tool"


class TestGeminiToolNamerErrors:
    def test_name_returns_none_on_failure(self, monkeypatch):
        namer = GeminiToolNamer(api_key="bad", model="gemini-2.0-flash")

        async def boom(_):
            raise RuntimeError("network down")

        monkeypatch.setattr(namer, "_via_google", boom)
        result = asyncio.run(namer.name(b"img"))
        assert result is None
