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


def _ollama_mock_client(monkeypatch, handler):
    """patch httpx.AsyncClient so OllamaToolNamer talks to a MockTransport."""
    import functools
    import httpx

    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        httpx, "AsyncClient", functools.partial(httpx.AsyncClient, transport=transport)
    )


class TestOllamaToolNamer:
    def test_chat_success(self, monkeypatch):
        import httpx

        def handler(request):
            assert request.url.path == "/api/chat"
            return httpx.Response(200, json={"message": {"content": "wrench"}})

        _ollama_mock_client(monkeypatch, handler)
        namer = OllamaToolNamer("http://x:11434", "llava")
        assert asyncio.run(namer.name(b"img")) == "wrench"

    def test_falls_back_to_generate_on_error(self, monkeypatch):
        # /api/chat 500 (the llava-on-some-Ollama failure) must retry /api/generate
        import httpx

        def handler(request):
            if request.url.path == "/api/chat":
                return httpx.Response(500, text="llava runner crashed")
            assert request.url.path == "/api/generate"
            return httpx.Response(200, json={"response": "phillips screwdriver"})

        _ollama_mock_client(monkeypatch, handler)
        namer = OllamaToolNamer("http://x:11434", "llava")
        assert asyncio.run(namer.name(b"img")) == "phillips screwdriver"

    def test_returns_none_when_both_fail(self, monkeypatch):
        import httpx

        def handler(request):
            return httpx.Response(404, text="model not found")

        _ollama_mock_client(monkeypatch, handler)
        namer = OllamaToolNamer("http://x:11434", "llava")
        assert asyncio.run(namer.name(b"img")) is None

    def test_warm_posts_generate_without_prompt(self, monkeypatch):
        import httpx

        seen = {}

        def handler(request):
            import json
            seen["path"] = request.url.path
            seen["body"] = json.loads(request.content)
            return httpx.Response(200, json={"done": True})

        _ollama_mock_client(monkeypatch, handler)
        namer = OllamaToolNamer("http://x:11434", "qwen2.5vl:7b")
        asyncio.run(namer.warm())
        assert seen["path"] == "/api/generate"
        assert seen["body"]["model"] == "qwen2.5vl:7b"
        assert "prompt" not in seen["body"]  # load only, no inference
        assert "keep_alive" in seen["body"]

    def test_warm_swallows_errors(self, monkeypatch):
        import httpx

        def handler(request):
            raise httpx.ConnectError("no route to host")

        _ollama_mock_client(monkeypatch, handler)
        namer = OllamaToolNamer("http://x:11434", "qwen2.5vl:7b")
        # must not raise
        asyncio.run(namer.warm())
