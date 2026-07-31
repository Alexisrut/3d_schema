"""Проекты: список, создание, загрузка .glb, полный слепок сцены."""
from __future__ import annotations

import re
import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Request, UploadFile, status
from sqlalchemy import select

from .. import models, schemas, services
from ..config import settings
from ..deps import AccessibleProject, AdminUser, CurrentUser, DbSession, EditorGuard
from ..realtime import notify

router = APIRouter(prefix="/api/projects", tags=["projects"], dependencies=[EditorGuard])

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
    # Файлы всех слоёв, а не только первого: остальные иначе остались бы
    # на диске навсегда — записи о них уходят каскадом.
    doomed = [m.model_url for m in _layers(db, project.id)]
    if project.model_url:
        doomed.append(project.model_url)
    db.delete(project)
    db.commit()
    for url in doomed:
        _remove_model_file(url)


# ------------------------------------------------------------- слои моделей
@router.get("/{project_id}/models", response_model=list[schemas.ProjectModelOut])
def list_models(project: AccessibleProject, db: DbSession) -> list[models.ProjectModel]:
    """Слои сцены для панели «Слои»."""
    return _layers(db, project.id)


@router.post(
    "/{project_id}/models",
    response_model=schemas.ProjectModelOut,
    status_code=status.HTTP_201_CREATED,
)
def upload_model(
    request: Request,
    project: AccessibleProject,
    db: DbSession,
    _: AdminUser,
    file: UploadFile = File(...),  # noqa: B008
) -> models.ProjectModel:
    """Добавить в сцену ещё один .glb, выгруженный из САПР (Revit и т. п.).

    Каждая загрузка создаёт новый слой и не затрагивает уже загруженные:
    на одном объекте это, как правило, разные разделы проекта (АР, КЖ, ОВ).
    """
    filename = _store_upload(request, project.id, file)

    layer = models.ProjectModel(
        project_id=project.id,
        name=_display_name(file.filename),
        model_url=f"/media/models/{filename}",
        sort_order=_next_sort_order(db, project.id),
    )
    db.add(layer)
    db.flush()
    services.sync_primary_model(db, project)
    db.commit()
    db.refresh(layer)
    notify(
        project.id,
        "project.models_changed",
        {"model_id": layer.id, "model_url": layer.model_url},
    )
    return layer


@router.patch("/{project_id}/models/{model_id}", response_model=schemas.ProjectModelOut)
def update_model(
    model_id: int,
    payload: schemas.ProjectModelUpdate,
    project: AccessibleProject,
    db: DbSession,
    _: AdminUser,
) -> models.ProjectModel:
    layer = _get_layer(db, project.id, model_id)
    if payload.name is not None:
        layer.name = payload.name
    if payload.sort_order is not None:
        layer.sort_order = payload.sort_order
    db.flush()
    services.sync_primary_model(db, project)
    db.commit()
    db.refresh(layer)
    notify(project.id, "project.models_changed", {"model_id": layer.id})
    return layer


@router.delete("/{project_id}/models/{model_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_model(
    model_id: int, project: AccessibleProject, db: DbSession, _: AdminUser
):
    layer = _get_layer(db, project.id, model_id)
    doomed = layer.model_url
    db.delete(layer)
    db.flush()
    services.sync_primary_model(db, project)
    db.commit()
    # Файл удаляем только после успешной фиксации в БД.
    _remove_model_file(doomed)
    notify(project.id, "project.models_changed", {"model_id": model_id})


@router.get("/{project_id}/snapshot", response_model=schemas.ProjectSnapshot)
def project_snapshot(project: AccessibleProject, db: DbSession) -> schemas.ProjectSnapshot:
    """Всё, что нужно 3D-виду: проект + бригады + секторы с готовыми сводками."""
    return services.build_project_snapshot(db, project)


def _layers(db, project_id: int) -> list[models.ProjectModel]:  # noqa: ANN001
    return list(
        db.scalars(
            select(models.ProjectModel)
            .where(models.ProjectModel.project_id == project_id)
            .order_by(models.ProjectModel.sort_order, models.ProjectModel.id)
        ).all()
    )


def _get_layer(db, project_id: int, model_id: int) -> models.ProjectModel:  # noqa: ANN001
    layer = db.get(models.ProjectModel, model_id)
    if layer is None or layer.project_id != project_id:
        raise HTTPException(status_code=404, detail="Слой модели не найден")
    return layer


def _next_sort_order(db, project_id: int) -> int:  # noqa: ANN001
    current = db.scalar(
        select(models.ProjectModel.sort_order)
        .where(models.ProjectModel.project_id == project_id)
        .order_by(models.ProjectModel.sort_order.desc())
        .limit(1)
    )
    return int(current or 0) + 1


def _display_name(filename: str | None) -> str:
    """Имя слоя = имя файла без расширения. Показывается в панели «Слои»."""
    stem = Path(filename or "model.glb").name
    for suffix in (".glb", ".gltf"):
        if stem.lower().endswith(suffix):
            stem = stem[: -len(suffix)]
            break
    return stem.strip()[:255] or "Модель"


def _store_upload(request: Request, project_id: int, file: UploadFile) -> str:
    """Проверить и сохранить .glb на диск. Возвращает имя файла в хранилище."""
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
    filename = f"p{project_id}_{uuid.uuid4().hex[:8]}_{stem}{suffix}"
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

    return filename


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
