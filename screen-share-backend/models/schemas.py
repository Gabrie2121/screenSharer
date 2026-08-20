from pydantic import BaseModel
from typing import Optional
from enum import Enum


class SignalType(str, Enum):
    OFFER       = "offer"
    ANSWER      = "answer"
    ICE         = "ice-candidate"
    SET_QUALITY = "set-quality"
    START       = "start-sharing"
    STOP        = "stop-sharing"
    JOIN        = "join-room"
    LEAVE       = "leave-room"
    ROOM_INFO   = "room-info"
    USER_JOIN   = "user-joined"
    USER_LEFT   = "user-left"
    USER_SHARE  = "user-sharing"
    USER_STOP   = "user-stopped-sharing"
    PING        = "ping"
    PONG        = "pong"
    ERROR       = "error"


class User(BaseModel):
    user_id:  str
    username: str
    sharing:  bool = False


class Room(BaseModel):
    room_id:    str
    users:      dict[str, User] = {}
    created_at: Optional[str]   = None


class SignalMessage(BaseModel):
    type:      SignalType
    room_id:   Optional[str]  = None
    to:        Optional[str]  = None
    from_id:   Optional[str]  = None
    username:  Optional[str]  = None
    payload:   Optional[dict] = None