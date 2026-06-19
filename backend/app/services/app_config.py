"""Persistent app configuration (config.json on the storage volume).

Holds server-side settings that should survive restarts/updates and be editable
in the UI without redeploying — currently the AI keys and naming models. Each
field falls back to the matching environment variable when unset, so existing
env-based deployments keep working. Secrets are never returned to the UI; only
a "configured" boolean is exposed.
"""
from __future__ import annotations

import json
import tempfile
import threading
from pathlib import Path
from typing import Any

from app.config import settings

# fields persisted in config.json
FIELDS = [
    "google_api_key",
    "openrouter_api_key",
    "ollama_base_url",
    "ollama_label_model",
    "gemini_label_model",
]
SECRET_FIELDS = {"google_api_key", "openrouter_api_key"}
# config field -> Settings attribute used as the env fallback
_ENV_FALLBACK = {f: f for f in FIELDS}
_DEFAULTS = {
    "ollama_label_model": "qwen2.5vl:7b",
    "gemini_label_model": "gemini-2.0-flash",
}


class AppConfigStore:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self._data: dict[str, Any] = self._load()

    def _load(self) -> dict[str, Any]:
        if self.path.exists():
            try:
                return json.loads(self.path.read_text())
            except Exception:
                return {}
        return {}

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=".config_", suffix=".tmp")
        try:
            with open(fd, "w") as f:
                json.dump(self._data, f, indent=2)
            Path(tmp).replace(self.path)
        except Exception:
            Path(tmp).unlink(missing_ok=True)
            raise

    def effective(self, field: str) -> Any:
        """config.json value if set, else the env var, else a default."""
        v = self._data.get(field)
        if v not in (None, ""):
            return v
        env_attr = _ENV_FALLBACK.get(field)
        if env_attr:
            ev = getattr(settings, env_attr, None)
            if ev:
                return ev
        return _DEFAULTS.get(field)

    def update(self, partial: dict[str, Any]) -> None:
        """set provided fields. An explicit empty value clears a field (so it
        reverts to the env/default); omitted fields are left untouched."""
        with self._lock:
            for k, v in partial.items():
                if k not in FIELDS:
                    continue
                if v in (None, ""):
                    self._data.pop(k, None)
                else:
                    self._data[k] = v
            self._save()

    def public(self) -> dict[str, Any]:
        """effective config for the UI; secrets reduced to a configured flag."""
        out: dict[str, Any] = {}
        for f in FIELDS:
            if f in SECRET_FIELDS:
                out[f + "_configured"] = bool(self.effective(f))
            else:
                out[f] = self.effective(f)
        return out


app_config = AppConfigStore(settings.storage_path / "config.json")
