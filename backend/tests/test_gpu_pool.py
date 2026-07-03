"""Tests for the lazy-load / idle-unload GPU model pool."""
import threading
import time

from app.services import gpu_pool as gp
from app.services.gpu_pool import GpuPool


class TestManagedModel:
    def test_lazy_load_on_first_use(self, monkeypatch):
        monkeypatch.setattr(gp, "_pool", GpuPool())
        calls = {"load": 0}

        def loader():
            calls["load"] += 1
            return {"session": True}

        m = gp._pool.register("m", loader)
        assert not m.loaded and calls["load"] == 0  # registration doesn't load
        with m.use() as h:
            assert h == {"session": True}
        assert m.loaded and calls["load"] == 1

    def test_reuse_does_not_reload(self, monkeypatch):
        monkeypatch.setattr(gp, "_pool", GpuPool())
        calls = {"load": 0}
        m = gp._pool.register("m", lambda: calls.__setitem__("load", calls["load"] + 1) or object())
        with m.use():
            pass
        with m.use():
            pass
        assert calls["load"] == 1

    def test_reap_unloads_when_idle(self, monkeypatch):
        monkeypatch.setattr(gp, "_pool", GpuPool())
        unloaded = {"n": 0}
        m = gp._pool.register("m", lambda: object(), unloader=lambda h: unloaded.__setitem__("n", unloaded["n"] + 1))
        with m.use():
            pass
        assert m.loaded
        # not yet idle
        assert m.reap(timeout=999) is False and m.loaded
        # idle past a zero-ish timeout
        time.sleep(0.01)
        assert m.reap(timeout=0.0) is True
        assert not m.loaded and unloaded["n"] == 1

    def test_reap_skips_in_use(self, monkeypatch):
        monkeypatch.setattr(gp, "_pool", GpuPool())
        m = gp._pool.register("m", lambda: object())
        started = threading.Event()
        release = threading.Event()

        def hold():
            with m.use():
                started.set()
                release.wait(2)

        t = threading.Thread(target=hold)
        t.start()
        started.wait(2)
        # in use -> reaper must not unload even with a 0 timeout
        assert m.reap(timeout=0.0) is False
        assert m.loaded
        release.set()
        t.join(2)

    def test_reload_after_unload(self, monkeypatch):
        monkeypatch.setattr(gp, "_pool", GpuPool())
        calls = {"load": 0}
        m = gp._pool.register("m", lambda: calls.__setitem__("load", calls["load"] + 1) or object())
        with m.use():
            pass
        m.reap(timeout=0.0)
        with m.use():
            pass
        assert calls["load"] == 2


class TestGpuPool:
    def test_register_is_idempotent(self, monkeypatch):
        pool = GpuPool()
        a = pool.register("x", lambda: 1)
        b = pool.register("x", lambda: 2)
        assert a is b

    def test_reap_once_respects_zero_timeout_disable(self, monkeypatch):
        monkeypatch.setattr(gp, "_pool", GpuPool())
        monkeypatch.setattr(gp, "idle_timeout", lambda: 0.0)
        m = gp._pool.register("m", lambda: object())
        with m.use():
            pass
        # timeout 0 disables idle unloading entirely
        assert gp._pool.reap_once() == 0
        assert m.loaded

    def test_semaphore_serialises(self, monkeypatch):
        pool = GpuPool()
        pool._concurrency = 1
        pool._sem = threading.BoundedSemaphore(1)
        m = pool.register("m", lambda: object())
        active = {"now": 0, "max": 0}
        lock = threading.Lock()

        def worker():
            with m.use():
                with lock:
                    active["now"] += 1
                    active["max"] = max(active["max"], active["now"])
                time.sleep(0.05)
                with lock:
                    active["now"] -= 1

        threads = [threading.Thread(target=worker) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(3)
        assert active["max"] == 1  # never more than one concurrent GPU op

    def test_status_shape(self, monkeypatch):
        monkeypatch.setattr(gp, "_pool", GpuPool())
        gp._pool.register("m", lambda: object())
        s = gp._pool.status()
        assert "idle_timeout" in s and "max_concurrency" in s
        assert s["models"][0]["name"] == "m" and s["models"][0]["loaded"] is False
