from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


class Plugin(Protocol):
    name: str

    def setup(self, context: dict[str, Any]) -> None:
        ...


@dataclass
class PluginRegistry:
    _plugins: dict[str, Plugin]

    def __init__(self) -> None:
        self._plugins = {}

    def register(self, plugin: Plugin) -> None:
        self._plugins[plugin.name] = plugin

    def get(self, name: str) -> Plugin | None:
        return self._plugins.get(name)

    def setup_all(self, context: dict[str, Any]) -> None:
        for plugin in self._plugins.values():
            plugin.setup(context)
