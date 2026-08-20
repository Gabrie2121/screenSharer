import uuid
import json
import logging
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from models.schemas import SignalType, User
from core.room_manager import RoomManager
from core.connection_manager import ConnectionManager

logger = logging.getLogger("ws")
router = APIRouter(tags=["WebSocket"])


def get_ws_router(
    room_manager: RoomManager,
    conn_manager: ConnectionManager
) -> APIRouter:

    @router.websocket("/ws/{room_id}")
    async def websocket_endpoint(websocket: WebSocket, room_id: str):

        user_id = str(uuid.uuid4())
        await conn_manager.connect(user_id, websocket)

        try:
            while True:
                raw = await websocket.receive_text()

                try:
                    data = json.loads(raw)
                except json.JSONDecodeError:
                    await conn_manager.send_error(user_id, "JSON inválido")
                    continue

                msg_type = data.get("type")

                # -------------------------------------------------- #
                # JOIN                                                 #
                # -------------------------------------------------- #
                if msg_type == SignalType.JOIN:
                    username = data.get("username", f"User-{user_id[:4]}")

                    user = User(user_id=user_id, username=username)
                    room_manager.add_user(room_id, user)
                    conn_manager.register_room(user_id, room_id)

                    # Confirma para quem entrou
                    await conn_manager.send(user_id, {
                        "type":    SignalType.ROOM_INFO,
                        "room_id": room_id,
                        "user_id": user_id,
                        "users":   {
                            uid: u.model_dump()
                            for uid, u in room_manager.get_users(room_id).items()
                        }
                    })

                    # Avisa os outros
                    await conn_manager.broadcast_room(room_id, {
                        "type":     SignalType.USER_JOIN,
                        "user_id":  user_id,
                        "username": username,
                    }, exclude=user_id)

                    logger.info(f"👤 {username} ({user_id}) entrou em {room_id}")

                # -------------------------------------------------- #
                # OFFER / ANSWER / ICE / SET_QUALITY (sinalização WebRTC) #
                # SET_QUALITY: quem assiste pede uma resolução (ver #
                # context.MD) — é só um relay ponto-a-ponto igual aos    #
                # outros, quem aplica é o app de quem está compartilhando #
                # -------------------------------------------------- #
                elif msg_type in (
                    SignalType.OFFER,
                    SignalType.ANSWER,
                    SignalType.ICE,
                    SignalType.SET_QUALITY,
                ):
                    to = data.get("to")
                    if not to:
                        await conn_manager.send_error(user_id, "Campo 'to' obrigatório")
                        continue

                    if not conn_manager.is_connected(to):
                        await conn_manager.send_error(user_id, f"Usuário {to} não encontrado")
                        continue

                    await conn_manager.send(to, {
                        "type":    msg_type,
                        "from":    user_id,
                        "payload": data.get("payload")
                    })

                # -------------------------------------------------- #
                # START SHARING                                        #
                # -------------------------------------------------- #
                elif msg_type == SignalType.START:
                    room_manager.set_sharing(room_id, user_id, True)
                    user = room_manager.get_user(room_id, user_id)

                    await conn_manager.broadcast_room(room_id, {
                        "type":     SignalType.USER_SHARE,
                        "user_id":  user_id,
                        "username": user.username if user else "?",
                    }, exclude=user_id)

                    logger.info(f"🖥️  {user_id} começou a compartilhar em {room_id}")

                # -------------------------------------------------- #
                # PING (latência para o indicador de conexão)          #
                # -------------------------------------------------- #
                elif msg_type == SignalType.PING:
                    await conn_manager.send(user_id, {
                        "type":    SignalType.PONG,
                        "payload": data.get("payload"),
                    })

                # -------------------------------------------------- #
                # STOP SHARING                                         #
                # -------------------------------------------------- #
                elif msg_type == SignalType.STOP:
                    room_manager.set_sharing(room_id, user_id, False)

                    await conn_manager.broadcast_room(room_id, {
                        "type":    SignalType.USER_STOP,
                        "user_id": user_id,
                    }, exclude=user_id)

                    logger.info(f"⏹️  {user_id} parou de compartilhar em {room_id}")

                else:
                    await conn_manager.send_error(user_id, f"Tipo '{msg_type}' desconhecido")

        except WebSocketDisconnect:
            room_id_stored = conn_manager.get_room_of(user_id)
            conn_manager.disconnect(user_id)

            if room_id_stored:
                user = room_manager.remove_user(room_id_stored, user_id)
                await conn_manager.broadcast_room(room_id_stored, {
                    "type":     SignalType.USER_LEFT,
                    "user_id":  user_id,
                    "username": user.username if user else "?",
                })

            logger.info(f"❌ Desconectado: {user_id}")

    return router