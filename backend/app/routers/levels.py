"""Этажи (уровни) объекта: горизонтальные отметки по оси Y.

Отметка снимается с выбранной детали модели, поэтому уровень — это одно
число и название. Всё остальное (плоскость, фильтрация «выше/ниже/между»)
считает фронтенд: это состояние просмотра, а не данные объекта.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from .. import models, schemas
from ..deps import AccessibleProject, DbSession, EditorGuard
from ..realtime import notify

router = APIRouter(
    prefix="/api/projects/{project_id}/levels",
    tags=["levels"],
    dependencies=[EditorGuard],
)


@router.get("", response_model=list[schemas.LevelOut])
def list_levels(project: AccessibleProject, db: DbSession):
    return _levels(db, project.id)


@router.post("", response_model=schemas.LevelOut, status_code=status.HTTP_201_CREATED)
def create_level(
    payload: schemas.LevelCreate, project: AccessibleProject, db: DbSession
) -> models.Level:
    level = models.Level(
        project_id=project.id, name=payload.name, elevation=float(payload.elevation)
    )
    db.add(level)
    db.commit()
    db.refresh(level)
    notify(project.id, "levels.changed", {"level_id": level.id})
    return level


@router.patch("/{level_id}", response_model=schemas.LevelOut)
def update_level(
    level_id: int,
    payload: schemas.LevelUpdate,
    project: AccessibleProject,
    db: DbSession,
) -> models.Level:
    level = _get_level(db, project.id, level_id)
    if payload.name is not None:
        level.name = payload.name
    if payload.elevation is not None:
        level.elevation = float(payload.elevation)
    db.commit()
    db.refresh(level)
    notify(project.id, "levels.changed", {"level_id": level.id})
    return level


@router.delete("/{level_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_level(level_id: int, project: AccessibleProject, db: DbSession):
    level = _get_level(db, project.id, level_id)
    db.delete(level)
    db.commit()
    notify(project.id, "levels.changed", {"level_id": level_id})


def _levels(db, project_id: int) -> list[models.Level]:  # noqa: ANN001
    return list(
        db.scalars(
            select(models.Level)
            .where(models.Level.project_id == project_id)
            .order_by(models.Level.elevation)
        ).all()
    )


def _get_level(db, project_id: int, level_id: int) -> models.Level:  # noqa: ANN001
    level = db.get(models.Level, level_id)
    if level is None or level.project_id != project_id:
        raise HTTPException(status_code=404, detail="Уровень не найден")
    return level
