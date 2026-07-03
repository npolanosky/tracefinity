"""Cooperative GPU sharing with a co-located Ollama server.

Before Tracefinity loads a tracer on the GPU it can ask Ollama whether it is
currently holding a model (i.e. using the shared VRAM). If so, Tracefinity
yields: it loads the tracer on CPU for that run instead of fighting over the
GPU. Combined with prompt idle-unloading on both sides, the two services take
turns on one card.

We yield to CPU rather than block-and-wait because tracer inference runs on the
event loop; a multi-second wait here would freeze the whole server. Enabled by
gpu_share_with_ollama; a no-op (fail-open -> use GPU) when disabled,
unconfigured, or when Ollama is unreachable.
"""
from __future__ import annotations

import logging

import httpx

logger = logging.getLogger(__name__)

PS_TIMEOUT = 5  # seconds; a single quick check, never a polling wait


def truthy(v) -> bool:
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def ollama_holds_gpu() -> bool:
    """True if a co-located Ollama currently has a model resident. Fail-open
    (returns False) when the feature is off, no Ollama is configured, or the
    server can't be reached -- callers then use the GPU as normal."""
    from app.services.app_config import app_config

    if not truthy(app_config.effective("gpu_share_with_ollama")):
        return False
    base = app_config.effective("ollama_base_url")
    if not base:
        return False
    try:
        resp = httpx.get(f"{str(base).rstrip('/')}/api/ps", timeout=PS_TIMEOUT)
        if resp.status_code >= 400:
            return False
        models = resp.json().get("models") or []
    except Exception as e:
        logger.info("gpu-coord: Ollama /api/ps check failed (%s); assuming GPU free", type(e).__name__)
        return False
    if models:
        logger.info(
            "gpu-coord: Ollama holds %d model(s); yielding GPU (running tracer on CPU)",
            len(models),
        )
    return bool(models)
