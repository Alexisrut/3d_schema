"""Секторы (зоны разметки), их задачи и проблемы.

Все ответы содержат готовую сводку сектора: бэкенд сам находит задачи и
проблемы по JSON-массивам ID, считает progress_percent и подставляет бригаду.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from .. import models, schemas, services
from ..deps import AccessibleProject, DbSession, EditorGuard
from ..progress import sync_status_and_progress
from ..realtime import notify

router = APIRouter(
    prefix="/api/projects/{project_id}/sectors",
    tags=["sectors"],
    # Роль «Читатель» отсекается на входе в роутер: защита распространяется
    # и на маршруты, которые появятся позже.
    dependencies=[EditorGuard],
)


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


def _finish_many(
    db,  # noqa: ANN001
    sectors: list[models.Sector],
    event: str,
) -> schemas.BulkSectorsResult:
    """Одна транзакция на всё массовое действие, рассылка — после коммита.

    Коммит внутри цикла оставил бы половину зон изменёнными, если бы
    следующая упала, а событие, отправленное до коммита, показало бы
    остальным зрителям данные, которых ещё нет в базе.
    """
    summaries: list[schemas.SectorSummary] = []
    for sector in sectors:
        services.recalculate_sector(db, sector)
        summaries.append(services.build_sector_summary(db, sector))
    db.commit()
    for summary in summaries:
        notify(summary.project_id, event, summary.model_dump(mode="json"))
    return schemas.BulkSectorsResult(sectors=summaries)


def _resolve_sectors(db, project_id: int, sector_ids: list[int]) -> list[models.Sector]:  # noqa: ANN001
    """Зоны массового действия: без дублей, все обязаны существовать.

    Молча пропускать несуществующие ID нельзя — пользователь решил бы, что
    задача заведена во всех выбранных зонах.
    """
    resolved: list[models.Sector] = []
    for sector_id in services.normalize_ids(sector_ids):
        resolved.append(_get_sector(db, project_id, sector_id))
    if not resolved:
        raise HTTPException(status_code=400, detail="Не выбрано ни одной зоны")
    return resolved


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
    brigade_ids = _assert_brigades(db, project.id, payload.brigade_ids)

    coordinates = _clean_coordinates(payload.coordinates)
    sector = models.Sector(
        project_id=project.id,
        name=payload.name,
        coordinates=coordinates,
        height=payload.height,
        top_coordinates=_clean_top(payload.top_coordinates, coordinates),
        brigade_ids=brigade_ids,
        task_ids=[],
        problem_ids=[],
        progress_percent=0.0,
    )
    db.add(sector)
    db.flush()
    return _finish(db, sector, "sector.created")


# ------------------------------------------------------------ массовые действия
# Объявлены ДО маршрутов с /{sector_id}: путь «bulk» не проходит проверку
# типа int, а FastAPI на неудачной валидации возвращает 422, а не пробует
# следующий маршрут.
@router.post("/bulk/tasks", response_model=schemas.BulkSectorsResult, status_code=201)
def bulk_add_task(
    payload: schemas.BulkTaskCreate, project: AccessibleProject, db: DbSession
):
    """Одна задача сразу в нескольких зонах (п. 2.2 доработок)."""
    sectors = _resolve_sectors(db, project.id, payload.sector_ids)
    for sector in sectors:
        task = models.Task(
            name=payload.task.name,
            definition=payload.task.definition,
            status=payload.task.status,
            progress=payload.task.progress,
        )
        db.add(task)
        db.flush()
        sector.task_ids = [*(sector.task_ids or []), task.id]
    return _finish_many(db, sectors, "sector.updated")


@router.post("/bulk/problems", response_model=schemas.BulkSectorsResult, status_code=201)
def bulk_add_problem(
    payload: schemas.BulkProblemCreate, project: AccessibleProject, db: DbSession
):
    sectors = _resolve_sectors(db, project.id, payload.sector_ids)
    for sector in sectors:
        problem = models.Problem(
            name=payload.problem.name,
            definition=payload.problem.definition,
            is_resolved=payload.problem.is_resolved,
        )
        db.add(problem)
        db.flush()
        sector.problem_ids = [*(sector.problem_ids or []), problem.id]
    return _finish_many(db, sectors, "sector.updated")


@router.put("/bulk/brigades", response_model=schemas.BulkSectorsResult)
def bulk_assign_brigades(
    payload: schemas.BulkBrigadesAssign, project: AccessibleProject, db: DbSession
):
    """Назначить один и тот же состав бригад нескольким зонам."""
    sectors = _resolve_sectors(db, project.id, payload.sector_ids)
    brigade_ids = _assert_brigades(db, project.id, payload.brigade_ids)
    for sector in sectors:
        sector.brigade_ids = list(brigade_ids)
    return _finish_many(db, sectors, "sector.brigade_changed")


@router.post("/bulk/delete", response_model=schemas.BulkDeleteResult)
def bulk_delete_sectors(
    payload: schemas.BulkSectorIds, project: AccessibleProject, db: DbSession
):
    """Массовое удаление зон — одно подтверждение на весь набор."""
    sectors = _resolve_sectors(db, project.id, payload.sector_ids)
    deleted: list[int] = []
    for sector in sectors:
        services.purge_sector_children(db, sector)
        deleted.append(sector.id)
        db.delete(sector)
    db.commit()
    for sector_id in deleted:
        notify(project.id, "sector.deleted", {"sector_id": sector_id})
    return schemas.BulkDeleteResult(deleted_ids=deleted)


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
        # Основание изменили, а верх правили вручную — сбрасываем его к
        # ровному выдавливанию: иначе число вершин разойдётся и боковины
        # не сойдутся.
        if sector.top_coordinates and len(sector.top_coordinates) != len(sector.coordinates):
            sector.top_coordinates = None
    if payload.height is not None:
        sector.height = float(payload.height)
    if payload.top_coordinates is not None:
        sector.top_coordinates = _clean_top(payload.top_coordinates, sector.coordinates or [])
    return _finish(db, sector, "sector.updated")


@router.delete("/{sector_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sector(sector_id: int, project: AccessibleProject, db: DbSession):
    """Удаление сектора уносит с собой его задачи и проблемы."""
    sector = _get_sector(db, project.id, sector_id)
    services.purge_sector_children(db, sector)
    db.delete(sector)
    db.commit()
    notify(project.id, "sector.deleted", {"sector_id": sector_id})


@router.put("/{sector_id}/brigades", response_model=schemas.SectorSummary)
def set_brigades(
    sector_id: int,
    payload: schemas.SectorBrigadesAssign,
    project: AccessibleProject,
    db: DbSession,
):
    """Полная замена состава бригад сектора.

    Пустой список снимает все бригады — этим же вызовом работает кнопка
    «Снять все» в карточке зоны.
    """
    sector = _get_sector(db, project.id, sector_id)
    sector.brigade_ids = _assert_brigades(db, project.id, payload.brigade_ids)
    return _finish(db, sector, "sector.brigade_changed")


@router.post(
    "/{sector_id}/brigades",
    response_model=schemas.SectorSummary,
    status_code=status.HTTP_201_CREATED,
)
def add_brigade(
    sector_id: int,
    payload: schemas.SectorBrigadeRef,
    project: AccessibleProject,
    db: DbSession,
):
    """Добавить бригаду к сектору — сюда приходит drag-and-drop с фронтенда.

    Добавление именно точечное: список бригад дочитывается и меняется на
    сервере, поэтому две одновременные пересадки бригад на одну зону не
    затирают друг друга (в отличие от PUT со всем списком).
    """
    sector = _get_sector(db, project.id, sector_id)
    _assert_brigade(db, project.id, payload.brigade_id)
    current = services.normalize_ids(sector.brigade_ids)
    if payload.brigade_id not in current:
        sector.brigade_ids = [*current, payload.brigade_id]
    return _finish(db, sector, "sector.brigade_changed")


@router.delete("/{sector_id}/brigades/{brigade_id}", response_model=schemas.SectorSummary)
def remove_brigade(
    sector_id: int, brigade_id: int, project: AccessibleProject, db: DbSession
):
    """Снять одну бригаду с сектора, не затрагивая остальные."""
    sector = _get_sector(db, project.id, sector_id)
    current = services.normalize_ids(sector.brigade_ids)
    if brigade_id not in current:
        raise HTTPException(status_code=404, detail="Бригада не назначена на эту зону")
    sector.brigade_ids = [i for i in current if i != brigade_id]
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
    # Вложения снимаем вместе с задачей: rowid в SQLite переиспользуется после
    # удаления, и осиротевшие файлы иначе всплыли бы у новой задачи с тем же id.
    services.purge_card_attachments(db, models.CardKind.task, task_id)
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
    services.purge_card_attachments(db, models.CardKind.problem, problem_id)
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


def _clean_top(
    points: list[list[float]] | None, base: list[list[float]]
) -> list[list[float]] | None:
    """Проверить правленую верхнюю грань.

    Пустой список — осознанный сброс к ровному выдавливанию. Иначе число
    вершин обязано совпадать с основанием: боковины строятся парами
    «вершина низа — вершина верха», и при расхождении зона развалится.
    """
    if points is None:
        return None
    if len(points) == 0:
        return None
    if len(points) != len(base):
        raise HTTPException(
            status_code=400,
            detail="Верхняя грань должна содержать столько же точек, сколько основание",
        )
    return _clean_coordinates(points)


def _assert_brigade(db, project_id: int, brigade_id: int) -> models.Brigade:  # noqa: ANN001
    brigade = db.get(models.Brigade, brigade_id)
    if brigade is None or brigade.project_id != project_id:
        raise HTTPException(status_code=404, detail="Бригада не найдена в этом проекте")
    return brigade


def _assert_brigades(db, project_id: int, brigade_ids: list[int]) -> list[int]:  # noqa: ANN001
    """Проверить весь список бригад и вернуть его без дублей.

    Проверяются все ID до единого: незамеченная опечатка означала бы зону
    с бригадой-призраком, которую потом молча вычистит prune_missing_ids.
    """
    normalized = services.normalize_ids(brigade_ids)
    for brigade_id in normalized:
        _assert_brigade(db, project_id, brigade_id)
    return normalized
