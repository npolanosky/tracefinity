"""Optional, pluggable automatic naming for traced tools.

A ``ToolNamer`` takes a single cropped tool image and returns a short name
(or ``None`` if it cannot name it). Naming is opportunistic and user-triggered:
the trace UI calls the ``/name-tools`` endpoint on demand, so there is no
background task, warm-up, or polling. ``get_tool_namer`` reads the app config
(pydantic-settings) as the single source of truth for which backend, if any,
is available.

The only implementation today reuses the same Gemini / OpenRouter label model
the Gemini tracer already uses, but any object satisfying the ``ToolNamer``
protocol (e.g. a local VLM, a filename heuristic, a stub for tests) can be
plugged in without touching callers.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Optional, Protocol, runtime_checkable

logger = logging.getLogger(__name__)

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
MAX_NAME_LEN = 40
REQUEST_TIMEOUT = 30

NAME_PROMPT = (
    "This image shows a single hand tool on a plain background. "
    'Reply with ONLY a short name for the tool: 1-3 words, lowercase, no '
    'punctuation or quotes (e.g. "wrench", "phillips screwdriver", '
    '"needle nose pliers"). If you cannot tell, reply "tool".'
)

# Small local vision models (llava, moondream, ...) treat an explicit
# "reply 'tool' if unsure" escape hatch as a free pass and return the generic
# word instead of committing. This variant removes the easy-out and forces a
# concrete single guess, which yields far more useful names from weak models.
LOCAL_NAME_PROMPT = (
    "What hand tool is shown in this photo? Identify it as specifically as you "
    "can. Reply with ONLY its common name in 1-3 lowercase words (for example: "
    "wrench, phillips screwdriver, needle nose pliers, ball peen hammer, "
    "socket wrench, tape measure). Always give your single best guess even if "
    "you are unsure. Output only the name, nothing else."
)


@runtime_checkable
class ToolNamer(Protocol):
    """Anything that can name a single cropped tool image."""

    async def name(self, image_png: bytes) -> Optional[str]:
        ...


def clean_name(text: Optional[str]) -> Optional[str]:
    """Normalise a raw model response into a short tool name, or None."""
    if not text or not text.strip():
        return None
    name = text.strip().splitlines()[0].strip().strip('."\'').strip()
    if not name:
        return None
    return name[:MAX_NAME_LEN]


class GeminiToolNamer:
    """Names a tool crop using the configured Gemini (or OpenRouter) label model."""

    def __init__(
        self,
        *,
        api_key: Optional[str] = None,
        model: str,
        openrouter_key: Optional[str] = None,
        openrouter_model: Optional[str] = None,
    ):
        self.api_key = api_key
        self.model = model
        self.openrouter_key = openrouter_key
        self.openrouter_model = openrouter_model or f"google/{model}"

    async def name(self, image_png: bytes) -> Optional[str]:
        try:
            if self.openrouter_key:
                text = await self._via_openrouter(image_png)
            else:
                text = await self._via_google(image_png)
            return clean_name(text)
        except Exception as e:  # naming is best-effort; never break the caller
            logger.warning("tool naming failed: %s", e)
            return None

    async def _via_google(self, image_png: bytes) -> str:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=self.api_key)
        response = await asyncio.wait_for(
            asyncio.to_thread(
                client.models.generate_content,
                model=self.model,
                contents=[
                    NAME_PROMPT,
                    types.Part.from_bytes(data=image_png, mime_type="image/png"),
                ],
            ),
            timeout=REQUEST_TIMEOUT,
        )
        return response.text

    async def _via_openrouter(self, image_png: bytes) -> str:
        import base64
        import httpx

        b64 = base64.b64encode(image_png).decode()
        payload = {
            "model": self.openrouter_model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": NAME_PROMPT},
                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                    ],
                }
            ],
        }
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
            resp = await client.post(
                OPENROUTER_URL,
                json=payload,
                headers={
                    "Authorization": f"Bearer {self.openrouter_key}",
                    "Content-Type": "application/json",
                },
            )
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"]


class OllamaToolNamer:
    """Names a tool crop using a local Ollama vision model (e.g. llava)."""

    def __init__(self, base_url: str, model: str):
        self.base_url = base_url.rstrip("/")
        self.model = model

    async def name(self, image_png: bytes) -> Optional[str]:
        import base64
        import httpx

        b64 = base64.b64encode(image_png).decode()

        async def post(client, path, payload):
            return await client.post(f"{self.base_url}{path}", json=payload)

        # temperature 0 for a deterministic, low-waffle answer from small models
        options = {"temperature": 0}
        try:
            async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
                # modern Ollama (>=0.1.14): /api/chat. Some Ollama/model combos
                # (older builds, certain llava packagings) 404 when the model
                # isn't pulled or 500 on a chat request with images, yet serve
                # the same request fine via the legacy /api/generate endpoint --
                # so fall back to it on ANY error and surface the body either way.
                resp = await post(client, "/api/chat", {
                    "model": self.model,
                    "messages": [{"role": "user", "content": LOCAL_NAME_PROMPT, "images": [b64]}],
                    "stream": False,
                    "options": options,
                })
                if resp.status_code >= 400:
                    logger.warning(
                        "ollama /api/chat HTTP %s (%s); retrying /api/generate (model=%r)",
                        resp.status_code, resp.text[:200], self.model,
                    )
                    resp = await post(client, "/api/generate", {
                        "model": self.model,
                        "prompt": LOCAL_NAME_PROMPT,
                        "images": [b64],
                        "stream": False,
                        "options": options,
                    })
                if resp.status_code >= 400:
                    logger.warning(
                        "ollama tool naming failed: HTTP %s from %s (model=%r): %s",
                        resp.status_code, self.base_url, self.model, resp.text[:300],
                    )
                    return None
                data = resp.json()
                # /api/chat -> message.content ; /api/generate -> response
                text = (data.get("message") or {}).get("content") or data.get("response", "")
                name = clean_name(text)
                # surface what the model actually said -- a generic "tool" (or
                # empty) usually means the model can't identify it, not a bug.
                logger.info("ollama %r named tool: %r (raw=%r)", self.model, name, (text or "")[:120])
                return name
        except Exception as e:  # best-effort; never break the caller
            logger.warning("ollama tool naming failed: %s", e)
            return None


def get_tool_namer(api_key: Optional[str] = None) -> Optional[ToolNamer]:
    """Return a ToolNamer if a naming backend is configured, else None.

    Prefers an explicit per-request ``api_key`` (the key the user typed into
    the trace UI when there is no server key), then the configured OpenRouter
    or Google key. Returns None when no backend is available, so callers can
    treat naming as strictly optional.
    """
    from app.config import settings
    from app.services.app_config import app_config

    label_model = app_config.effective("gemini_label_model")
    if api_key:
        return GeminiToolNamer(api_key=api_key, model=label_model)
    if app_config.effective("openrouter_api_key"):
        return GeminiToolNamer(
            model=label_model,
            openrouter_key=app_config.effective("openrouter_api_key"),
            openrouter_model=settings.openrouter_label_model,
        )
    if app_config.effective("google_api_key"):
        return GeminiToolNamer(api_key=app_config.effective("google_api_key"), model=label_model)
    if app_config.effective("ollama_base_url"):
        return OllamaToolNamer(
            app_config.effective("ollama_base_url"),
            app_config.effective("ollama_label_model"),
        )
    return None


def tool_naming_available() -> bool:
    """True when the server can name tools without a user-supplied key."""
    from app.services.app_config import app_config

    return bool(
        app_config.effective("google_api_key")
        or app_config.effective("openrouter_api_key")
        or app_config.effective("ollama_base_url")
    )
