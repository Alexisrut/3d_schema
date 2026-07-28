"""WebSocket-шина: рассылка изменений всем, кто смотрит на проект.

Роутеры — синхронные (`def`), поэтому FastAPI выполняет их в threadpool.
Из потока нельзя просто вызвать `create_task`, поэтому главный event loop
запоминается на старте приложения и используется через
`run_coroutine_threadsafe`.
"""
from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from typing import Any

from fastapi import WebSocket

log = logging.getLogger("realtime")

_main_loop: asyncio.AbstractEventLoop | None = None


def bind_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Вызывается один раз при старте приложения."""
    global _main_loop  # noqa: PLW0603
    _main_loop = loop


class ConnectionManager:
    def __init__(self) -> None:
        self._rooms: dict[int, set[WebSocket]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def connect(self, project_id: int, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._rooms[project_id].add(ws)

    async def disconnect(self, project_id: int, ws: WebSocket) -> None:
        async with self._lock:
            self._rooms[project_id].discard(ws)
            if not self._rooms[project_id]:
                self._rooms.pop(project_id, None)

    async def broadcast(self, project_id: int, message: dict[str, Any]) -> None:
        async with self._lock:
            targets = list(self._rooms.get(project_id, ()))
        dead: list[WebSocket] = []
        for ws in targets:
            try:
                await ws.send_json(message)
            except Exception:  # noqa: BLE001 — сокет мог отвалиться между итерациями
                dead.append(ws)
        if dead:
            async with self._lock:
                room = self._rooms.get(project_id)
                if room is not None:
                    for ws in dead:
                        room.discard(ws)

    def room_size(self, project_id: int) -> int:
        return len(self._rooms.get(project_id, ()))


manager = ConnectionManager()


def notify(project_id: int, event: str, payload: Any = None) -> None:
    """Разослать событие подписчикам проекта. Безопасно вызывать из sync-кода."""
    message = {"event": event, "project_id": project_id, "payload": payload}

    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None

    if running is not None:
        running.create_task(manager.broadcast(project_id, message))
        return

    if _main_loop is None or _main_loop.is_closed():
        log.debug("notify(%s) пропущено: event loop недоступен", event)
        return

    asyncio.run_coroutine_threadsafe(manager.broadcast(project_id, message), _main_loop)
