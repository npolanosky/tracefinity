from __future__ import annotations

DEFAULT_LOCAL_TRACERS = ["isnet", "birefnet-lite", "inspyrenet"]

REMBG_MODELS = {
    "birefnet-general": "birefnet-general",
    "birefnet-lite": "birefnet-general-lite",
    "isnet": "isnet-general-use",
    "u2netp": "u2netp",
}

LOCAL_MODEL_LABELS = {
    "inspyrenet": "InSPyReNet",
    "birefnet-general": "BiRefNet General",
    "birefnet-lite": "BiRefNet Lite",
    "isnet": "IS-Net",
    "u2netp": "U2-Net Lite (fast, CPU-friendly)",
}

GPU_REQUIRED_TRACERS = frozenset({"birefnet-general"})

REMOTE_TRACERS = frozenset({"replicate", "fal"})

REMOTE_TRACER_LABELS = {
    "replicate": "Replicate",
    "fal": "fal.ai",
}

TRACER_LABELS = {
    "gemini": "Gemini API",
    **LOCAL_MODEL_LABELS,
    **REMOTE_TRACER_LABELS,
}

SUPPORTED_TRACERS = frozenset(TRACER_LABELS)


def tracer_kind(tracer_id: str) -> str:
    """classify a tracer id: gemini, remote, or local."""
    if tracer_id == "gemini":
        return "gemini"
    if tracer_id in REMOTE_TRACERS:
        return "remote"
    return "local"


def effective_available_tracers() -> list[str]:
    """Tracers offered to users: the GUI/config selection (config.json 'tracers'
    or TRACERS env) when set and valid, else auto-detection from keys/tokens."""
    from app.services.app_config import app_config
    from app.config import settings
    cfg = app_config.effective("tracers")
    if cfg:
        ids = [t.strip() for t in str(cfg).split(",") if t.strip()]
        if ids:
            try:
                return validate_tracer_ids(ids)
            except ValueError:
                pass
    return settings.available_tracers


def validate_tracer_ids(tracers: list[str]) -> list[str]:
    unknown = [tracer for tracer in tracers if tracer not in SUPPORTED_TRACERS]
    if unknown:
        supported = ", ".join(sorted(SUPPORTED_TRACERS))
        invalid = ", ".join(unknown)
        raise ValueError(
            f"TRACERS contains unsupported tracer(s): {invalid}. "
            f"Supported tracers: {supported}"
        )
    return tracers
