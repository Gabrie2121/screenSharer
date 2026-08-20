import uuid
from fastapi import APIRouter
from models.schemas import Room
from core.room_manager import RoomManager

router = APIRouter(prefix="/api/rooms", tags=["Rooms"])


def get_room_router(room_manager: RoomManager) -> APIRouter:

    @router.post("/", response_model=Room, summary="Criar sala")
    def create_room():
        room_id = uuid.uuid4().hex[:8]
        return room_manager.create_room(room_id)

    @router.get("/", response_model=list[Room], summary="Listar salas")
    def list_rooms():
        return room_manager.list_rooms()

    @router.get("/{room_id}", response_model=Room, summary="Detalhes da sala")
    def get_room(room_id: str):
        room = room_manager.get_room(room_id)
        if not room:
            from fastapi import HTTPException
            raise HTTPException(status_code=404, detail="Sala não encontrada")
        return room

    return router