"""Точка входа FastAPI."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select

from . import models, realtime
from .config import settings
from .database import Base, SessionLocal, engine
from .routers import auth, brigades, media, projects, sectors, users
from .security import decode_access_token, hash_password

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("app")


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as db:
        has_admin = db.scalar(
            select(models.User).where(models.User.role == models.UserRole.admin)
        )
        if has_admin is None:
            admin = models.User(
                username=settings.seed_admin_username,
                password_hash=hash_password(settings.seed_admin_password),
                role=models.UserRole.admin,
                allowed_project_ids=[],
            )
            db.add(admin)
            db.commit()
            log.info(
                "Создан администратор по умолчанию: %s / %s — смените пароль!",
                settings.seed_admin_username,
                settings.seed_admin_password,
            )


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    realtime.bind_loop(asyncio.get_running_loop())
    yield


app = FastAPI(
    title="3D Мониторинг строительства",
    version="1.0.0",
    description="Внутренняя платформа визуализации и контроля хода строительства.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(users.router)
app.include_router(projects.router)
app.include_router(brigades.router)
app.include_router(sectors.router)
# Загруженные .glb раздаются с проверкой прав, а не как открытая статика.
app.include_router(media.router)


@app.get("/api/health", tags=["service"])
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.websocket("/ws/projects/{project_id}")
async def project_socket(websocket: WebSocket, project_id: int, token: str = "") -> None:
    """Канал реального времени: обновления сектора приходят всем зрителям проекта."""
    payload = decode_access_token(token) if token else None
    if not payload or "sub" not in payload:
        await websocket.close(code=4401)
        return

    with SessionLocal() as db:
        user = db.get(models.User, int(payload["sub"]))
        project = db.get(models.Project, project_id)
        if user is None or project is None or not user.can_access(project_id):
            await websocket.close(code=4403)
            return

    await realtime.manager.connect(project_id, websocket)
    try:
        await websocket.send_json({"event": "connected", "project_id": project_id, "payload": None})
        while True:
            # Клиент шлёт ping; данные нам не нужны — соединение держим открытым.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        pass
    finally:
        await realtime.manager.disconnect(project_id, websocket)
