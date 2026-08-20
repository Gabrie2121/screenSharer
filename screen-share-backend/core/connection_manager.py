import json
import logging
from fastapi import WebSocket
from models.schemas import SignalMessage, SignalType

logger = logging.getLogger("connection_manager")


class ConnectionManager:
    def __init__(self):
        # { user_id: WebSocket }
        self._connections: dict[str, WebSocket] = {}
        # { user_id: room_id }
        self._user_room: dict[str, str] = {}

    # ------------------------------------------------------------------ #
    #  Conexão / Desconexão                                                #
    # ------------------------------------------------------------------ #

    async def connect(self, user_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections[user_id] = websocket
        logger.info(f"✅ Conectado: {user_id}")

    def register_room(self, user_id: str, room_id: str) -> None:
        self._user_room[user_id] = room_id

    def disconnect(self, user_id: str) -> str | None:
        self._connections.pop(user_id, None)
        return self._user_room.pop(user_id, None)

    def get_room_of(self, user_id: str) -> str | None:
        return self._user_room.get(user_id)

    def is_connected(self, user_id: str) -> bool:
        return user_id in self._connections

    # ------------------------------------------------------------------ #
    #  Envio de mensagens                                                  #
    # ------------------------------------------------------------------ #

    async def send(self, user_id: str, message: dict) -> None:
        ws = self._connections.get(user_id)
        if ws:
            try:
                await ws.send_text(json.dumps(message))
            except Exception as e:
                logger.warning(f"⚠️  Falha ao enviar para {user_id}: {e}")

    async def broadcast_room(
        self,
        room_id: str,
        message: dict,
        exclude: str | None = None
    ) -> None:
        """Envia para todos na sala, opcionalmente excluindo um usuário."""
        targets = [
            uid for uid, rid in self._user_room.items()
            if rid == room_id and uid != exclude
        ]
        for user_id in targets:
            await self.send(user_id, message)

    async def send_error(self, user_id: str, detail: str) -> None:
        await self.send(user_id, {
            "type":    SignalType.ERROR,
            "payload": {"detail": detail}
        })