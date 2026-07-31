"""Бригады проекта."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from .. import models, schemas, services
from ..deps import AccessibleProject, DbSession, EditorGuard
from ..realtime import notify

router = APIRouter(
    prefix="/api/projects/{project_id}/brigades",
    tags=["brigades"],
    dependencies=[EditorGuard],
)


def _with_assignment(db, brigade: models.Brigade) -> schemas.BrigadeWithAssignment:  # noqa: ANN001
    sector_ids = services.sector_ids_for_brigade(db, brigade.project_id, brigade.id)
    return schemas.BrigadeWithAssignment(
        id=brigade.id,
        project_id=brigade.project_id,
        name=brigade.name,
        brigadir=brigade.brigadir,
        cnt_people=brigade.cnt_people,
        assigned_sector_ids=sector_ids,
    )


@router.get("", response_model=list[schemas.BrigadeWithAssignment])
def list_brigades(project: AccessibleProject, db: DbSession):
    brigades = db.scalars(
        select(models.Brigade)
        .where(models.Brigade.project_id == project.id)
        .order_by(models.Brigade.id)
    ).all()
    # Зоны читаются один раз на весь список: _with_assignment на каждую
    # бригаду перечитывал бы их заново (N+1 на панель бригад).
    sectors_by_brigade: dict[int, list[int]] = {}
    for sector in services.sectors_of_project(db, project.id):
        for brigade_id in services.normalize_ids(sector.brigade_ids):
            sectors_by_brigade.setdefault(brigade_id, []).append(sector.id)

    return [
        schemas.BrigadeWithAssignment(
            id=b.id,
            project_id=b.project_id,
            name=b.name,
            brigadir=b.brigadir,
            cnt_people=b.cnt_people,
            assigned_sector_ids=sectors_by_brigade.get(b.id, []),
        )
        for b in brigades
    ]


@router.post("", response_model=schemas.BrigadeWithAssignment, status_code=status.HTTP_201_CREATED)
def create_brigade(
    payload: schemas.BrigadeCreate, project: AccessibleProject, db: DbSession
):
    brigade = models.Brigade(
        project_id=project.id,
        name=payload.name,
        brigadir=payload.brigadir,
        cnt_people=payload.cnt_people,
    )
    db.add(brigade)
    db.commit()
    db.refresh(brigade)
    notify(project.id, "brigade.created", {"brigade_id": brigade.id})
    return _with_assignment(db, brigade)


@router.post("/bulk/delete", response_model=schemas.BulkDeleteResult)
def bulk_delete_brigades(
    payload: schemas.BulkBrigadeDelete, project: AccessibleProject, db: DbSession
):
    """Массовое удаление бригад — одно подтверждение на весь набор.

    Объявлено до маршрутов с /{brigade_id}: путь «bulk» не пройдёт проверку
    типа int, а FastAPI на ней возвращает 422, не пробуя следующий маршрут.
    """
    brigade_ids = services.normalize_ids(payload.brigade_ids)
    brigades = [_get_brigade(db, project.id, i) for i in brigade_ids]

    affected: set[int] = set()
    for brigade in brigades:
        affected.update(services.detach_brigade_everywhere(db, project.id, brigade.id))
        db.delete(brigade)
    db.commit()

    for brigade_id in brigade_ids:
        notify(project.id, "brigade.deleted", {"brigade_id": brigade_id})
    _notify_sectors(db, project.id, sorted(affected))
    return schemas.BulkDeleteResult(deleted_ids=brigade_ids)


@router.patch("/{brigade_id}", response_model=schemas.BrigadeWithAssignment)
def update_brigade(
    brigade_id: int,
    payload: schemas.BrigadeUpdate,
    project: AccessibleProject,
    db: DbSession,
):
    brigade = _get_brigade(db, project.id, brigade_id)
    data = payload.model_dump(exclude_unset=True, exclude_none=True)
    for field, value in data.items():
        setattr(brigade, field, value)
    affected = _sector_ids_of(db, brigade.id)
    db.commit()
    db.refresh(brigade)
    notify(project.id, "brigade.updated", {"brigade_id": brigade.id})
    _notify_sectors(db, project.id, affected)
    return _with_assignment(db, brigade)


@router.delete("/{brigade_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_brigade(brigade_id: int, project: AccessibleProject, db: DbSession):
    brigade = _get_brigade(db, project.id, brigade_id)
    # Снимаем бригаду со всех секторов, чтобы не остались висячие ID:
    # связь живёт в JSON-массиве, каскада БД у неё нет.
    affected = services.detach_brigade_everywhere(db, project.id, brigade.id)
    db.delete(brigade)
    db.commit()
    notify(project.id, "brigade.deleted", {"brigade_id": brigade_id})
    _notify_sectors(db, project.id, affected)


def _get_brigade(db, project_id: int, brigade_id: int) -> models.Brigade:  # noqa: ANN001
    brigade = db.get(models.Brigade, brigade_id)
    if brigade is None or brigade.project_id != project_id:
        raise HTTPException(status_code=404, detail="Бригада не найдена")
    return brigade


def _sector_ids_of(db, brigade_id: int) -> list[int]:  # noqa: ANN001
    """Зоны бригады — для рассылки после переименования."""
    brigade = db.get(models.Brigade, brigade_id)
    if brigade is None:
        return []
    return services.sector_ids_for_brigade(db, brigade.project_id, brigade_id)


def _notify_sectors(db, project_id: int, sector_ids: list[int]) -> None:  # noqa: ANN001
    """Переименование или удаление бригады меняет сводку затронутых секторов.

    Без этой рассылки название бригады продолжало бы висеть на 3D-виджете
    до перезагрузки страницы.
    """
    for sector_id in sector_ids:
        sector = db.get(models.Sector, sector_id)
        if sector is None:
            continue
        summary = services.build_sector_summary(db, sector)
        notify(project_id, "sector.updated", summary.model_dump(mode="json"))
