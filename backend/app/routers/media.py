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

router = APIRouter(prefix="/media", tags=["media"])


def _user_from_token(db, token: str) -> models.User:  # noqa: ANN001
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
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Пользователь не найден"
        )
    return user


@router.get("/models/{filename}")
def get_model(filename: str, db: DbSession, token: str = "") -> FileResponse:
    user = _user_from_token(db, token)

    # Никаких путей — только имя файла внутри каталога моделей.
    safe_name = FilePath(filename).name
    target = (settings.models_dir / safe_name).resolve()
    if target.parent != settings.models_dir.resolve() or not target.is_file():
        raise HTTPException(status_code=404, detail="Файл модели не найден")

    model_url = f"/media/models/{safe_name}"
    # Файл ищется среди слоёв. Запасной путь через projects.model_url оставлен
    # для базы, которую ещё не тронула миграция слоёв.
    layer = db.scalar(
        select(models.ProjectModel).where(models.ProjectModel.model_url == model_url)
    )
    if layer is not None:
        project = db.get(models.Project, layer.project_id)
    else:
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


@router.get("/attachments/{filename}")
def get_attachment(filename: str, db: DbSession, token: str = "") -> FileResponse:
    """Вложение карточки — с той же проверкой доступа, что и модели.

    Токен идёт query-параметром: ссылка на файл открывается обычным переходом
    браузера, а заголовок Authorization туда не подставить.
    """
    user = _user_from_token(db, token)

    safe_name = FilePath(filename).name
    target = (settings.attachments_dir / safe_name).resolve()
    if target.parent != settings.attachments_dir.resolve() or not target.is_file():
        raise HTTPException(status_code=404, detail="Файл не найден")

    row = db.scalar(
        select(models.Attachment).where(models.Attachment.stored_name == safe_name)
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Вложение не найдено")

    # Проект вложения определяется через зону, которой принадлежит карточка.
    project_id = _project_of_card(db, row.card_kind, row.card_id)
    if project_id is None:
        raise HTTPException(status_code=404, detail="Вложение не привязано к проекту")
    if not user.can_access(project_id):
        raise HTTPException(status_code=403, detail="Нет доступа к этому проекту")

    return FileResponse(
        target,
        media_type=row.content_type or "application/octet-stream",
        filename=row.filename,
    )


def _project_of_card(db, kind: models.CardKind, card_id: int) -> int | None:  # noqa: ANN001
    """Проект карточки: связь живёт в JSON-массивах зон, ищем перебором."""
    field = models.Sector.task_ids if kind == models.CardKind.task else models.Sector.problem_ids
    for sector in db.scalars(select(models.Sector)).all():
        raw = sector.task_ids if field is models.Sector.task_ids else sector.problem_ids
        if card_id in [int(i) for i in (raw or []) if str(i).lstrip("-").isdigit()]:
            return sector.project_id
    return None
