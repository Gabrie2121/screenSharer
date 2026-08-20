import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from core.room_manager import RoomManager
from core.connection_manager import ConnectionManager
from routes.rooms import get_room_router
from routes.ws import get_ws_router

# ------------------------------------------------------------------ #
#  Logging                                                             #
# ------------------------------------------------------------------ #
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s - %(message)s"
)

# ------------------------------------------------------------------ #
#  App                                                                 #
# ------------------------------------------------------------------ #
app = FastAPI(
    title="Screen Share API",
    description="Backend de sinalização WebRTC para compartilhamento de tela",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],      # ajuste para produção
    allow_methods=["*"],
    allow_headers=["*"],
)

# ------------------------------------------------------------------ #
#  Instâncias compartilhadas                                           #
# ------------------------------------------------------------------ #
room_manager = RoomManager()
conn_manager = ConnectionManager()

# ------------------------------------------------------------------ #
#  Rotas                                                               #
# ------------------------------------------------------------------ #
app.include_router(get_room_router(room_manager))
app.include_router(get_ws_router(room_manager, conn_manager))


@app.get("/", tags=["Health"])
def health():
    return {"status": "ok", "message": "Screen Share backend rodando 🚀"}