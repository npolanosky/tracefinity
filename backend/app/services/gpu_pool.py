"""Lazy-loaded, idle-unloaded GPU model pool.

Heavy segmentation models (onnxruntime / torch) otherwise sit in (V)RAM for the
life of the process. This pool loads them on first use, keeps them warm while
they're being used, and a background reaper frees them after a configurable
idle timeout -- so when Tracefinity is idle the GPU is available to other
processes (e.g. a local Ollama server). A bounded semaphore serialises GPU
inference to cap peak memory and queue work under contention.

Usage:
    model = gpu_pool.register("u2netp", loader_fn, unloader_fn)
    with model.use() as handle:      # loads if cold, blocks the reaper
        run_inference(handle)        # semaphore-gated

Config is read live from app_config each reap, so changing the idle timeout in
the UI takes effect without a restart. Concurrency is fixed at startup.
"""
from __future__ import annotations

import gc
import logging
import threading
import time
from contextlib import contextmanager
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

DEFAULT_IDLE_TIMEOUT = 60.0  # seconds -- free VRAM promptly once idle
DEFAULT_CONCURRENCY = 1
REAP_INTERVAL = 10.0  # seconds between idle sweeps (keeps unload prompt)


def _cfg(field: str, fallback: float) -> float:
    """read a numeric setting from app_config, tolerating str/None."""
    try:
        from app.services.app_config import app_config
        v = app_config.effective(field)
        return float(v) if v not in (None, "") else fallback
    except Exception:
        return fallback


def idle_timeout() -> float:
    return max(0.0, _cfg("gpu_idle_timeout", DEFAULT_IDLE_TIMEOUT))


def _empty_torch_cache() -> None:
    """release torch's cached CUDA blocks, if torch is present and on CUDA."""
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


class ManagedModel:
    """A single lazily-loaded model whose handle is freed when idle."""

    def __init__(self, name: str, loader: Callable[[], Any], unloader: Optional[Callable[[Any], None]] = None):
        self.name = name
        self._loader = loader
        self._unloader = unloader
        self._handle: Any = None
        self._lock = threading.RLock()
        self._in_use = 0
        self._last_used = 0.0

    @property
    def loaded(self) -> bool:
        return self._handle is not None

    @contextmanager
    def use(self):
        """Yield the (loaded) handle. Bounds concurrency via the pool semaphore
        and prevents the reaper from unloading the model mid-inference."""
        with _pool.semaphore():
            with self._lock:
                if self._handle is None:
                    logger.info("gpu-pool: loading %s", self.name)
                    self._handle = self._loader()
                self._in_use += 1
            try:
                yield self._handle
            finally:
                with self._lock:
                    self._in_use -= 1
                    self._last_used = time.monotonic()

    def reap(self, timeout: float) -> bool:
        """Unload if loaded, not in use, and idle past `timeout`. Returns True
        if it unloaded."""
        with self._lock:
            if self._handle is None or self._in_use > 0:
                return False
            if time.monotonic() - self._last_used < timeout:
                return False
            handle, self._handle = self._handle, None
            logger.info("gpu-pool: unloading idle %s (idle > %.0fs)", self.name, timeout)
        try:
            if self._unloader is not None:
                self._unloader(handle)
        except Exception:
            logger.warning("gpu-pool: unloader for %s failed", self.name, exc_info=True)
        del handle
        gc.collect()
        _empty_torch_cache()
        return True

    def status(self) -> dict:
        with self._lock:
            return {
                "name": self.name,
                "loaded": self._handle is not None,
                "in_use": self._in_use,
                "idle_seconds": round(time.monotonic() - self._last_used, 1) if self._handle is not None else None,
            }


class GpuPool:
    def __init__(self):
        self._models: dict[str, ManagedModel] = {}
        self._models_lock = threading.Lock()
        self._concurrency = max(1, int(_cfg("gpu_max_concurrency", DEFAULT_CONCURRENCY)))
        self._sem = threading.BoundedSemaphore(self._concurrency)
        self._reaper: Optional[threading.Thread] = None

    def register(self, name: str, loader: Callable[[], Any], unloader: Optional[Callable[[Any], None]] = None) -> ManagedModel:
        """Register (idempotently) a lazily-loaded model. Does not load it."""
        with self._models_lock:
            model = self._models.get(name)
            if model is None:
                model = ManagedModel(name, loader, unloader)
                self._models[name] = model
            return model

    @contextmanager
    def semaphore(self):
        self._sem.acquire()
        try:
            yield
        finally:
            self._sem.release()

    def reap_once(self) -> int:
        timeout = idle_timeout()
        if timeout <= 0:
            return 0  # 0 disables idle unloading
        return sum(1 for m in list(self._models.values()) if m.reap(timeout))

    def start_reaper(self, interval: float = REAP_INTERVAL) -> None:
        if self._reaper is not None and self._reaper.is_alive():
            return

        def _loop():
            while True:
                time.sleep(interval)
                try:
                    self.reap_once()
                except Exception:
                    logger.warning("gpu-pool: reaper sweep failed", exc_info=True)

        self._reaper = threading.Thread(target=_loop, name="gpu-pool-reaper", daemon=True)
        self._reaper.start()
        logger.info("gpu-pool: reaper started (interval=%.0fs, concurrency=%d)", interval, self._concurrency)

    def status(self) -> dict:
        return {
            "idle_timeout": idle_timeout(),
            "max_concurrency": self._concurrency,
            "models": [m.status() for m in list(self._models.values())],
        }


_pool = GpuPool()
gpu_pool = _pool
