"""Ollama plus cloud connections behind one model picker (docs/design/local-ai.md §9).

Cloud models are named `<connection id>/<model>`; anything else goes to Ollama. A failing
Ollama does not hide the cloud models: its error is kept for the status page instead.
"""

from dataclasses import replace
from typing import Any

from .base import AiBackend, AiBadRequest, AiError, ChatStream, ModelInfo
from .openai_compat import OpenAICompatBackend


class MultiBackend:
    id = "multi"

    def __init__(self, ollama: AiBackend | None, clouds: list[OpenAICompatBackend]) -> None:
        self._ollama = ollama
        self._clouds = clouds
        #: Why Ollama's models are missing from the last list, if they are.
        self.last_error: str | None = None

    def list_models(self) -> list[ModelInfo]:
        models: list[ModelInfo] = []
        self.last_error = None
        if self._ollama is not None:
            try:
                models += [replace(m, connection="ollama") for m in self._ollama.list_models()]
            except AiError as exc:
                if not self._clouds:
                    raise
                self.last_error = f"Ollama: {exc}"
        for cloud in self._clouds:
            models += cloud.list_models()
        return models

    def open_chat(
        self,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        num_ctx: int | None = None,
    ) -> ChatStream:
        for cloud in self._clouds:
            prefix = f"{cloud.conn_id}/"
            if model.startswith(prefix):
                return cloud.open_chat(model[len(prefix) :], messages, tools, num_ctx)
        if self._ollama is None:
            raise AiBadRequest("unknown model")
        return self._ollama.open_chat(model, messages, tools, num_ctx)
