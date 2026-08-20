from models.schemas import Room, User
from datetime import datetime, timezone


class RoomManager:
    def __init__(self):
        # { room_id: Room }
        self._rooms: dict[str, Room] = {}

    # ------------------------------------------------------------------ #
    #  Rooms                                                               #
    # ------------------------------------------------------------------ #

    def create_room(self, room_id: str) -> Room:
        room = Room(
            room_id=room_id,
            created_at=datetime.now(timezone.utc).isoformat()
        )
        self._rooms[room_id] = room
        return room

    def get_room(self, room_id: str) -> Room | None:
        return self._rooms.get(room_id)

    def get_or_create_room(self, room_id: str) -> Room:
        return self._rooms.get(room_id) or self.create_room(room_id)

    def delete_room(self, room_id: str) -> None:
        self._rooms.pop(room_id, None)

    def list_rooms(self) -> list[Room]:
        return list(self._rooms.values())

    # ------------------------------------------------------------------ #
    #  Users                                                               #
    # ------------------------------------------------------------------ #

    def add_user(self, room_id: str, user: User) -> None:
        room = self.get_or_create_room(room_id)
        room.users[user.user_id] = user

    def remove_user(self, room_id: str, user_id: str) -> User | None:
        room = self.get_room(room_id)
        if not room:
            return None

        user = room.users.pop(user_id, None)

        # Remove sala se ficou vazia
        if not room.users:
            self.delete_room(room_id)

        return user

    def get_user(self, room_id: str, user_id: str) -> User | None:
        room = self.get_room(room_id)
        return room.users.get(user_id) if room else None

    def set_sharing(self, room_id: str, user_id: str, sharing: bool) -> bool:
        user = self.get_user(room_id, user_id)
        if not user:
            return False
        user.sharing = sharing
        return True

    def get_users(self, room_id: str) -> dict[str, User]:
        room = self.get_room(room_id)
        return room.users if room else {}

    def room_exists(self, room_id: str) -> bool:
        return room_id in self._rooms