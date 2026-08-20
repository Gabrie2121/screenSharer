import logging
import os
from logging.handlers import RotatingFileHandler
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from core.room_manager import RoomManager
from core.connection_manager import ConnectionManager
from routes.rooms import get_room_router
from routes.ws import get_ws_router

# ------------------------------------------------------------------ #
#  Logging básico — console + arquivo com rotação                     #
# ------------------------------------------------------------------ #
LOG_DIR = os.path.join(os.path.dirname(__file__), "logs")
os.makedirs(LOG_DIR, exist_ok=True)

_formatter = logging.Formatter(
    "%(asctime)s [%(name)s] %(levelname)s - %(message)s"
)

_console_handler = logging.StreamHandler()
_console_handler.setFormatter(_formatter)

_file_handler = RotatingFileHandler(
    os.path.join(LOG_DIR, "backend.log"),
    maxBytes=1_000_000,   # ~1MB por arquivo
    backupCount=3,
    encoding="utf-8",
)
_file_handler.setFormatter(_formatter)

logging.basicConfig(
    level=logging.INFO,
    handlers=[_console_handler, _file_handler],
)

logger = logging.getLogger("main")

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


@app.on_event("startup")
def on_startup():
    logger.info("🚀 Backend iniciado — logs em %s", LOG_DIR)


@app.on_event("shutdown")
def on_shutdown():
    logger.info("🛑 Backend encerrado")