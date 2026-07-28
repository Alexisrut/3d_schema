"""Раздача загруженных .glb — только тем, у кого есть доступ к проекту.

Модель здания заказчика не должна лежать по угадываемому публичному URL,
поэтому статика не монтируется, а отдаётся через проверку прав. Токен
приходит query-параметром: GLTFLoader в three.js не умеет добавлять
заголовок Authorization к своим запросам.
"""
from __future__ import annotations

from pathlib import Path as FilePath

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import FileResponse
from sqlalchemy import select

from .. import models
from ..config import settings
from ..deps import DbSession
from ..security import decode_access_token

router = APIRouter(prefix="/media/models", tags=["media"])


@router.get("/{filename}")
def get_model(filename: str, db: DbSession, token: str = "") -> FileResponse:
    payload = decode_access_token(token) if token else None
    if not payload or "sub" not in payload:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Требуется авторизация",
        )

    try:
        user = db.get(models.User, int(payload["sub"]))
    except (TypeError, ValueError):
        user = None
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Пользователь не найден")

    # Никаких путей — только имя файла внутри каталога моделей.
    safe_name = FilePath(filename).name
    target = (settings.models_dir / safe_name).resolve()
    if target.parent != settings.models_dir.resolve() or not target.is_file():
        raise HTTPException(status_code=404, detail="Файл модели не найден")

    model_url = f"/media/models/{safe_name}"
    project = db.scalar(select(models.Project).where(models.Project.model_url == model_url))
    if project is None:
        raise HTTPException(status_code=404, detail="Модель не привязана ни к одному проекту")
    if not user.can_access(project.id):
        raise HTTPException(status_code=403, detail="Нет доступа к этому проекту")

    return FileResponse(
        target,
        media_type="model/gltf-binary" if safe_name.endswith(".glb") else "model/gltf+json",
        filename=safe_name,
    )
