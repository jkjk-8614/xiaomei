"""Deliver workspace events to local clients and canvas share viewers."""

from dataclasses import dataclass
import json
import logging
from time import time_ns


_LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class Subscriber:
    client_id: str
    canvas_id: str

    def receives(self, scope):
        return scope is None or not self.canvas_id or self.canvas_id == scope


class WorkspaceEvents:
    def __init__(self):
        self._subscribers = {}

    async def connect(self, websocket, client_id=None, canvas_scope=""):
        await websocket.accept()
        self._subscribers[websocket] = Subscriber(client_id or f"anon-{id(websocket)}", str(canvas_scope or ""))
        await self.broadcast_count()

    async def disconnect(self, websocket):
        self._subscribers.pop(websocket, None)
        await self.broadcast_count()

    def online_count(self):
        clients = {subscriber.client_id for subscriber in self._subscribers.values()}
        return sum(not client.startswith("canvas_") for client in clients)

    async def _deliver(self, message, scope=None):
        text = json.dumps(message)
        for websocket, subscriber in tuple(self._subscribers.items()):
            if self._subscribers.get(websocket) is not subscriber or not subscriber.receives(scope):
                continue
            try:
                await websocket.send_text(text)
            except Exception:
                if self._subscribers.get(websocket) is subscriber:
                    self._subscribers.pop(websocket)
                _LOGGER.debug("Workspace WebSocket closed while sending %s", message["type"], exc_info=True)

    async def broadcast_count(self):
        count = self.online_count()
        await self._deliver(dict(type="stats", online_count=count))
        current_count = self.online_count()
        if current_count != count:
            await self._deliver(dict(type="stats", online_count=current_count))

    async def broadcast_new_image(self, image_data):
        await self._deliver(dict(type="new_image", data=image_data), scope="")

    async def broadcast_canvas_updated(self, canvas_id, updated_at, client_id=""):
        await self._deliver(
            dict(type="canvas_updated", canvas_id=canvas_id, updated_at=updated_at, client_id=client_id or ""),
            scope=str(canvas_id or ""),
        )

    async def broadcast_asset_library_updated(self, updated_at=0):
        await self._deliver(dict(
            type="asset_library_updated", updated_at=updated_at or time_ns() // 1_000_000,
        ), scope="")
