"""Секторы (зоны разметки), их задачи и проблемы.

Все ответы содержат готовую сводку сектора: бэкенд сам находит задачи и
проблемы по JSON-массивам ID, считает progress_percent и подставляет бригаду.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from .. import models, schemas, services
from ..deps import AccessibleProject, DbSession
from ..progress import sync_status_and_progress
from ..realtime import notify

router = APIRouter(prefix="/api/projects/{project_id}/sectors", tags=["sectors"])


# ------------------------------------------------------------------- helpers
def _get_sector(db, project_id: int, sector_id: int) -> models.Sector:  # noqa: ANN001
    sector = db.get(models.Sector, sector_id)
    if sector is None or sector.project_id != project_id:
        raise HTTPException(status_code=404, detail="Сектор не найден")
    return sector


def _finish(db, sector: models.Sector, event: str) -> schemas.SectorSummary:  # noqa: ANN001
    """Пересчитать прогресс, зафиксировать транзакцию и разослать событие."""
    services.recalculate_sector(db, sector)
    summary = services.build_sector_summary(db, sector)
    db.commit()
    notify(sector.project_id, event, summary.model_dump(mode="json"))
    return summary


# ------------------------------------------------------------------- sectors
@router.get("", response_model=list[schemas.SectorSummary])
def list_sectors(project: AccessibleProject, db: DbSession):
    sectors = db.scalars(
        select(models.Sector)
        .where(models.Sector.project_id == project.id)
        .order_by(models.Sector.id)
    ).all()
    return [services.build_sector_summary(db, s) for s in sectors]


@router.post("", response_model=schemas.SectorSummary, status_code=status.HTTP_201_CREATED)
def create_sector(payload: schemas.SectorCreate, project: AccessibleProject, db: DbSession):
    if len(payload.coordinates) < 3:
        raise HTTPException(
            status_code=400, detail="Для зоны нужно минимум 3 опорные точки"
        )
    if payload.brigade_id is not None:
        _assert_brigade(db, project.id, payload.brigade_id)

    sector = models.Sector(
        project_id=project.id,
        name=payload.name,
        coordinates=_clean_coordinates(payload.coordinates),
        brigade_id=payload.brigade_id,
        task_ids=[],
        problem_ids=[],
        progress_percent=0.0,
    )
    db.add(sector)
    db.flush()
    return _finish(db, sector, "sector.created")


@router.get("/{sector_id}", response_model=schemas.SectorSummary)
def get_sector(sector_id: int, project: AccessibleProject, db: DbSession):
    sector = _get_sector(db, project.id, sector_id)
    return services.build_sector_summary(db, sector)


@router.patch("/{sector_id}", response_model=schemas.SectorSummary)
def update_sector(
    sector_id: int, payload: schemas.SectorUpdate, project: AccessibleProject, db: DbSession
):
    sector = _get_sector(db, project.id, sector_id)
    if payload.name is not None:
        sector.name = payload.name
    if payload.coordinates is not None:
        if len(payload.coordinates) < 3:
            raise HTTPException(status_code=400, detail="Для зоны нужно минимум 3 точки")
        sector.coordinates = _clean_coordinates(payload.coordinates)
    return _finish(db, sector, "sector.updated")


@router.delete("/{sector_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sector(sector_id: int, project: AccessibleProject, db: DbSession):
    """Удаление сектора уносит с собой его задачи и проблемы."""
    sector = _get_sector(db, project.id, sector_id)
    services.purge_sector_children(db, sector)
    db.delete(sector)
    db.commit()
    notify(project.id, "sector.deleted", {"sector_id": sector_id})


@router.put("/{sector_id}/brigade", response_model=schemas.SectorSummary)
def assign_brigade(
    sector_id: int,
    payload: schemas.SectorBrigadeAssign,
    project: AccessibleProject,
    db: DbSession,
):
    """Назначение/снятие бригады — сюда приходит drag-and-drop с фронтенда."""
    sector = _get_sector(db, project.id, sector_id)
    if payload.brigade_id is not None:
        _assert_brigade(db, project.id, payload.brigade_id)
    sector.brigade_id = payload.brigade_id
    return _finish(db, sector, "sector.brigade_changed")


# --------------------------------------------------------------------- tasks
@router.post(
    "/{sector_id}/tasks",
    response_model=schemas.SectorSummary,
    status_code=status.HTTP_201_CREATED,
)
def add_task(
    sector_id: int, payload: schemas.TaskCreate, project: AccessibleProject, db: DbSession
):
    sector = _get_sector(db, project.id, sector_id)
    task = models.Task(
        name=payload.name,
        definition=payload.definition,
        status=payload.status,
        progress=payload.progress,
    )
    db.add(task)
    db.flush()
    sector.task_ids = [*(sector.task_ids or []), task.id]
    return _finish(db, sector, "sector.updated")


@router.patch("/{sector_id}/tasks/{task_id}", response_model=schemas.SectorSummary)
def update_task(
    sector_id: int,
    task_id: int,
    payload: schemas.TaskUpdate,
    project: AccessibleProject,
    db: DbSession,
):
    sector = _get_sector(db, project.id, sector_id)
    if task_id not in (sector.task_ids or []):
        raise HTTPException(status_code=404, detail="Задача не принадлежит этому сектору")
    task = db.get(models.Task, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Задача не найдена")

    # exclude_none: ни одно поле схемы не может быть законно null,
    # а явный null в теле запроса иначе уронил бы NOT NULL-ограничение.
    data = payload.model_dump(exclude_unset=True, exclude_none=True)
    for field, value in data.items():
        setattr(task, field, value)

    # Держим статус и процент согласованными. Ведущим считаем поле, которое
    # пользователь изменил; если пришли оба — приоритет у статуса.
    if "status" in data or "progress" in data:
        leading = "status" if "status" in data else "progress"
        new_status, new_progress = sync_status_and_progress(
            task.status.value, int(task.progress), leading
        )
        task.status = models.TaskStatus(new_status)
        task.progress = new_progress

    return _finish(db, sector, "sector.updated")


@router.delete("/{sector_id}/tasks/{task_id}", response_model=schemas.SectorSummary)
def delete_task(sector_id: int, task_id: int, project: AccessibleProject, db: DbSession):
    sector = _get_sector(db, project.id, sector_id)
    if task_id not in (sector.task_ids or []):
        raise HTTPException(status_code=404, detail="Задача не принадлежит этому сектору")
    task = db.get(models.Task, task_id)
    if task:
        db.delete(task)
    sector.task_ids = [i for i in (sector.task_ids or []) if i != task_id]
    db.flush()
    return _finish(db, sector, "sector.updated")


# ------------------------------------------------------------------ problems
@router.post(
    "/{sector_id}/problems",
    response_model=schemas.SectorSummary,
    status_code=status.HTTP_201_CREATED,
)
def add_problem(
    sector_id: int, payload: schemas.ProblemCreate, project: AccessibleProject, db: DbSession
):
    sector = _get_sector(db, project.id, sector_id)
    problem = models.Problem(
        name=payload.name,
        definition=payload.definition,
        is_resolved=payload.is_resolved,
    )
    db.add(problem)
    db.flush()
    sector.problem_ids = [*(sector.problem_ids or []), problem.id]
    return _finish(db, sector, "sector.updated")


@router.patch("/{sector_id}/problems/{problem_id}", response_model=schemas.SectorSummary)
def update_problem(
    sector_id: int,
    problem_id: int,
    payload: schemas.ProblemUpdate,
    project: AccessibleProject,
    db: DbSession,
):
    sector = _get_sector(db, project.id, sector_id)
    if problem_id not in (sector.problem_ids or []):
        raise HTTPException(status_code=404, detail="Проблема не принадлежит этому сектору")
    problem = db.get(models.Problem, problem_id)
    if problem is None:
        raise HTTPException(status_code=404, detail="Проблема не найдена")
    for field, value in payload.model_dump(exclude_unset=True, exclude_none=True).items():
        setattr(problem, field, value)
    return _finish(db, sector, "sector.updated")


@router.delete("/{sector_id}/problems/{problem_id}", response_model=schemas.SectorSummary)
def delete_problem(
    sector_id: int, problem_id: int, project: AccessibleProject, db: DbSession
):
    sector = _get_sector(db, project.id, sector_id)
    if problem_id not in (sector.problem_ids or []):
        raise HTTPException(status_code=404, detail="Проблема не принадлежит этому сектору")
    problem = db.get(models.Problem, problem_id)
    if problem:
        db.delete(problem)
    sector.problem_ids = [i for i in (sector.problem_ids or []) if i != problem_id]
    db.flush()
    return _finish(db, sector, "sector.updated")


def _clean_coordinates(points: list[list[float]]) -> list[list[float]]:
    """Каждая опорная точка — ровно три координаты, иначе полигон будет битым."""
    cleaned: list[list[float]] = []
    for point in points:
        if len(point) != 3:
            raise HTTPException(
                status_code=400,
                detail="Каждая точка зоны должна содержать ровно 3 координаты [x, y, z]",
            )
        cleaned.append([float(c) for c in point])
    return cleaned


def _assert_brigade(db, project_id: int, brigade_id: int) -> models.Brigade:  # noqa: ANN001
    brigade = db.get(models.Brigade, brigade_id)
    if brigade is None or brigade.project_id != project_id:
        raise HTTPException(status_code=404, detail="Бригада не найдена в этом проекте")
    return brigade
