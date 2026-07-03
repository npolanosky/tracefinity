from __future__ import annotations

from pydantic_settings import BaseSettings
from pathlib import Path
from typing import Optional

from app.services.tracer_registry import DEFAULT_LOCAL_TRACERS, validate_tracer_ids


class Settings(BaseSettings):
    storage_path: Path = Path("./storage")
    google_api_key: Optional[str] = None
    openrouter_api_key: Optional[str] = None
    openrouter_image_model: str = "google/gemini-3.1-flash-image-preview"
    openrouter_label_model: str = "google/gemini-2.0-flash-001"
    gemini_image_model: str = "gemini-3.1-flash-image-preview"
    gemini_label_model: str = "gemini-2.0-flash"
    # optional local Ollama for tool naming (vision model). qwen2.5vl reads
    # brand text well and IDs tools specifically: :7b ~6GB VRAM (default),
    # :32b ~21GB for a bigger GPU. llava also works but is weaker.
    ollama_base_url: Optional[str] = None  # e.g. http://192.168.2.78:11434
    ollama_label_model: str = "qwen2.5vl:7b"
    # how long Ollama keeps the naming model in (V)RAM after the last request.
    # Accepts an Ollama duration ("5m", "300s", "0" = unload immediately,
    # "-1" = keep forever). Default 5m so VRAM frees up a few minutes after use.
    ollama_keep_alive: str = "5m"
    # GPU model lifecycle: local tracer + paper-detector models load on demand
    # and are freed after this many seconds idle so the GPU can be shared (0
    # disables idle unloading). max_concurrency caps simultaneous GPU inference.
    gpu_idle_timeout: int = 60
    gpu_max_concurrency: int = 1
    max_upload_mb: int = 20
    log_level: str = "INFO"
    proxy_secret: Optional[str] = None
    cors_origins: list[str] = ["http://localhost:3000", "http://localhost:4001"]
    tracers: Optional[str] = None
    replicate_api_token: Optional[str] = None
    fal_key: Optional[str] = None
    replicate_model: str = "men1scus/birefnet"
    fal_model: str = "fal-ai/birefnet/v2"
    replicate_resolution: Optional[str] = None  # "WxH"; None => model default
    fal_operating_resolution: str = "1024x1024"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8", "extra": "ignore"}

    @property
    def available_tracers(self) -> list[str]:
        """list of tracer IDs available to users.

        set TRACERS env var to a comma-separated list, e.g. "birefnet-lite,isnet"
        or "gemini,birefnet-lite". if not set, auto-detects: an LLM key picks
        gemini, else a remote token picks that provider, else local models.
        """
        if self.tracers:
            return validate_tracer_ids([t.strip() for t in self.tracers.split(",") if t.strip()])
        if self.google_api_key or self.openrouter_api_key:
            return ["gemini"]
        remote = []
        if self.replicate_api_token:
            remote.append("replicate")
        if self.fal_key:
            remote.append("fal")
        if remote:
            return remote
        return list(DEFAULT_LOCAL_TRACERS)

    @property
    def primary_tracer(self) -> str | None:
        """the primary (first) available tracer id, or none."""
        tracers = self.available_tracers
        return tracers[0] if tracers else None

    @property
    def primary_is_saliency(self) -> bool:
        """true when the primary tracer uses the saliency pipeline (local or
        remote), not the gemini llm path."""
        primary = self.primary_tracer
        return primary is not None and primary != "gemini"


settings = Settings()


def ensure_user_dirs(user_path: Path):
    """create storage subdirs for a user"""
    user_path.mkdir(parents=True, exist_ok=True)
    for sub in ("uploads", "processed", "outputs", "tools", "bins"):
        (user_path / sub).mkdir(exist_ok=True)


# ensure default user dirs exist
settings.storage_path.mkdir(parents=True, exist_ok=True)
ensure_user_dirs(settings.storage_path / "default")
