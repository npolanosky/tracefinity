"""Tests for GUI tracer selection + the Ollama GPU coordinator."""
import httpx

from app.config import settings
from app.services import app_config as app_config_mod
from app.services import gpu_coordinator as gc
from app.services.tracer_registry import effective_available_tracers, LOCAL_MODEL_LABELS


class TestU2netpRegistered:
    def test_u2netp_is_a_local_tracer(self):
        from app.services.tracer_registry import REMBG_MODELS, GPU_REQUIRED_TRACERS
        assert REMBG_MODELS["u2netp"] == "u2netp"
        assert "u2netp" in LOCAL_MODEL_LABELS
        assert "u2netp" not in GPU_REQUIRED_TRACERS  # CPU-friendly


class TestEffectiveTracers:
    def test_config_selection_wins(self, monkeypatch):
        monkeypatch.setattr(app_config_mod.app_config, "_data", {"tracers": "u2netp,isnet"})
        assert effective_available_tracers() == ["u2netp", "isnet"]

    def test_invalid_config_falls_back_to_auto(self, monkeypatch):
        monkeypatch.setattr(app_config_mod.app_config, "_data", {"tracers": "not-a-real-tracer"})
        monkeypatch.setattr(settings, "tracers", None)
        monkeypatch.setattr(settings, "google_api_key", None)
        monkeypatch.setattr(settings, "openrouter_api_key", None)
        monkeypatch.setattr(settings, "replicate_api_token", None)
        monkeypatch.setattr(settings, "fal_key", None)
        # invalid selection -> auto-detection (default local tracers)
        assert "isnet" in effective_available_tracers()


class TestTruthy:
    def test_variants(self):
        assert gc.truthy("true") and gc.truthy("1") and gc.truthy("YES") and gc.truthy("on")
        assert not gc.truthy("false") and not gc.truthy("0") and not gc.truthy("") and not gc.truthy(None)


class TestOllamaHoldsGpu:
    def test_disabled_returns_false(self, monkeypatch):
        monkeypatch.setattr(app_config_mod.app_config, "_data", {"gpu_share_with_ollama": "false"})
        assert gc.ollama_holds_gpu() is False

    def test_enabled_no_base_url_false(self, monkeypatch):
        monkeypatch.setattr(app_config_mod.app_config, "_data", {"gpu_share_with_ollama": "true"})
        monkeypatch.setattr(settings, "ollama_base_url", None)
        assert gc.ollama_holds_gpu() is False

    def test_enabled_and_ollama_busy_true(self, monkeypatch):
        monkeypatch.setattr(
            app_config_mod.app_config, "_data",
            {"gpu_share_with_ollama": "true", "ollama_base_url": "http://x:11434"},
        )
        monkeypatch.setattr(gc.httpx, "get", lambda *a, **k: httpx.Response(200, json={"models": [{"name": "qwen"}]}))
        assert gc.ollama_holds_gpu() is True

    def test_enabled_and_ollama_idle_false(self, monkeypatch):
        monkeypatch.setattr(
            app_config_mod.app_config, "_data",
            {"gpu_share_with_ollama": "true", "ollama_base_url": "http://x:11434"},
        )
        monkeypatch.setattr(gc.httpx, "get", lambda *a, **k: httpx.Response(200, json={"models": []}))
        assert gc.ollama_holds_gpu() is False

    def test_unreachable_fails_open(self, monkeypatch):
        monkeypatch.setattr(
            app_config_mod.app_config, "_data",
            {"gpu_share_with_ollama": "true", "ollama_base_url": "http://x:11434"},
        )
        def boom(*a, **k):
            raise httpx.ConnectError("no route")
        monkeypatch.setattr(gc.httpx, "get", boom)
        assert gc.ollama_holds_gpu() is False  # fail-open -> use GPU
