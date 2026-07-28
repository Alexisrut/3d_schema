"""Проекты: список, создание, загрузка .glb, полный слепок сцены."""
from __future__ import annotations

import re
import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Request, UploadFile, status
from sqlalchemy import select

from .. import models, schemas, services
from ..config import settings
from ..deps import AccessibleProject, AdminUser, CurrentUser, DbSession
from ..realtime import notify

router = APIRouter(prefix="/api/projects", tags=["projects"])

_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


@router.get("", response_model=list[schemas.ProjectOut])
def list_projects(db: DbSession, user: CurrentUser) -> list[models.Project]:
    stmt = select(models.Project).order_by(models.Project.id.desc())
    if user.role != models.UserRole.admin:
        allowed = [int(i) for i in (user.allowed_project_ids or [])]
        if not allowed:
            return []
        stmt = stmt.where(models.Project.id.in_(allowed))
    return list(db.scalars(stmt).all())


@router.post("", response_model=schemas.ProjectOut, status_code=status.HTTP_201_CREATED)
def create_project(
    payload: schemas.ProjectCreate, db: DbSession, _: AdminUser
) -> models.Project:
    project = models.Project(name=payload.name)
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


@router.get("/{project_id}", response_model=schemas.ProjectOut)
def get_project(project: AccessibleProject) -> models.Project:
    return project


@router.patch("/{project_id}", response_model=schemas.ProjectOut)
def update_project(
    payload: schemas.ProjectUpdate,
    project: AccessibleProject,
    db: DbSession,
    _: AdminUser,
) -> models.Project:
    if payload.name is not None:
        project.name = payload.name
    db.commit()
    db.refresh(project)
    return project


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(project: AccessibleProject, db: DbSession, _: AdminUser):
    # Секторы уходят каскадом, но задачи и проблемы связаны с ними лишь
    # JSON-массивами ID — их надо удалить явно, иначе останутся сиротами.
    sectors = db.scalars(
        select(models.Sector).where(models.Sector.project_id == project.id)
    ).all()
    for sector in sectors:
        services.purge_sector_children(db, sector)
    _remove_model_file(project.model_url)
    db.delete(project)
    db.commit()


@router.post("/{project_id}/model", response_model=schemas.ProjectOut)
def upload_model(
    request: Request,
    project: AccessibleProject,
    db: DbSession,
    _: AdminUser,
    file: UploadFile = File(...),  # noqa: B008
) -> models.Project:
    """Загрузка .glb, выгруженного из САПР (Revit и т. п.)."""
    limit = settings.max_model_mb * 1024 * 1024

    # Отсекаем великанов по заголовку — тело запроса иначе успевает целиком
    # осесть во временном файле до входа в обработчик.
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise HTTPException(status_code=413, detail=f"Файл больше {settings.max_model_mb} МБ")

    original = Path(file.filename or "model.glb").name
    suffix = Path(original).suffix.lower()
    if suffix not in {".glb", ".gltf"}:
        raise HTTPException(status_code=400, detail="Поддерживаются только файлы .glb / .gltf")

    stem = _SAFE_NAME.sub("_", Path(original).stem)[:60] or "model"
    filename = f"p{project.id}_{uuid.uuid4().hex[:8]}_{stem}{suffix}"
    target = settings.models_dir / filename

    written = 0
    first_chunk = b""
    try:
        with target.open("wb") as out:
            while chunk := file.file.read(1024 * 1024):
                if not first_chunk:
                    first_chunk = chunk[:16]
                written += len(chunk)
                if written > limit:
                    raise HTTPException(
                        status_code=413,
                        detail=f"Файл больше {settings.max_model_mb} МБ",
                    )
                out.write(chunk)
    except Exception:
        target.unlink(missing_ok=True)
        raise
    finally:
        file.file.close()

    if not _looks_like_gltf(first_chunk, suffix):
        target.unlink(missing_ok=True)
        raise HTTPException(
            status_code=400,
            detail="Файл не похож на glTF: у .glb должна быть сигнатура 'glTF'",
        )

    previous = project.model_url
    project.model_url = f"/media/models/{filename}"
    db.commit()
    db.refresh(project)
    # Старый файл удаляем только после успешной фиксации в БД.
    _remove_model_file(previous)
    notify(project.id, "project.model_updated", {"model_url": project.model_url})
    return project


@router.get("/{project_id}/snapshot", response_model=schemas.ProjectSnapshot)
def project_snapshot(project: AccessibleProject, db: DbSession) -> schemas.ProjectSnapshot:
    """Всё, что нужно 3D-виду: проект + бригады + секторы с готовыми сводками."""
    return services.build_project_snapshot(db, project)


def _looks_like_gltf(head: bytes, suffix: str) -> bool:
    if suffix == ".glb":
        return head[:4] == b"glTF"
    # .gltf — это JSON; достаточно убедиться, что начинается с объекта.
    return head.lstrip()[:1] == b"{"


def _remove_model_file(model_url: str | None) -> None:
    if not model_url:
        return
    name = Path(model_url).name
    candidate = settings.models_dir / name
    try:
        if candidate.is_file() and candidate.parent == settings.models_dir:
            candidate.unlink()
    except OSError:
        pass
