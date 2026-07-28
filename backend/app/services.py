"""Агрегация данных сектора на бэкенде (п. 5.1 ТЗ).

Фронтенд не считает ничего сам — он получает готовую сводку.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models, schemas
from .progress import compute_progress, in_progress_ids


def _fetch_ordered(db: Session, model, ids: list[int]) -> list:
    """Достать записи по списку ID, сохранив порядок из JSON-массива сектора."""
    ids = [int(i) for i in (ids or [])]
    if not ids:
        return []
    rows = db.scalars(select(model).where(model.id.in_(ids))).all()
    by_id = {row.id: row for row in rows}
    return [by_id[i] for i in ids if i in by_id]


def _order_from_cache(cache: dict[int, object], ids: list[int]) -> list:
    return [cache[int(i)] for i in (ids or []) if int(i) in cache]


def prune_missing_ids(db: Session, sector: models.Sector) -> None:
    """Убрать из JSON-массивов ID удалённых задач/проблем (самолечение данных)."""
    tasks = _fetch_ordered(db, models.Task, sector.task_ids)
    problems = _fetch_ordered(db, models.Problem, sector.problem_ids)
    alive_tasks = [t.id for t in tasks]
    alive_problems = [p.id for p in problems]
    if alive_tasks != list(sector.task_ids or []):
        sector.task_ids = alive_tasks
    if alive_problems != list(sector.problem_ids or []):
        sector.problem_ids = alive_problems


def recalculate_sector(db: Session, sector: models.Sector) -> float:
    """Пересчитать и сохранить progress_percent сектора.

    Вызывается только на путях записи — чтения БД не меняют.
    """
    prune_missing_ids(db, sector)
    tasks = _fetch_ordered(db, models.Task, sector.task_ids)
    sector.progress_percent = compute_progress(tasks)
    db.flush()
    return sector.progress_percent


def _assemble(
    sector: models.Sector,
    tasks: list[models.Task],
    problems: list[models.Problem],
    brigade: models.Brigade | None,
) -> schemas.SectorSummary:
    return schemas.SectorSummary(
        id=sector.id,
        project_id=sector.project_id,
        name=sector.name,
        coordinates=sector.coordinates or [],
        progress_percent=compute_progress(tasks),
        brigade=schemas.BrigadeOut.model_validate(brigade) if brigade else None,
        tasks=[schemas.TaskOut.model_validate(t) for t in tasks],
        problems=[schemas.ProblemOut.model_validate(p) for p in problems],
        in_progress_task_ids=in_progress_ids(tasks),
        tasks_total=len(tasks),
        tasks_done=sum(1 for t in tasks if t.status == models.TaskStatus.done),
        open_problems=sum(1 for p in problems if not p.is_resolved),
    )


def build_sector_summary(db: Session, sector: models.Sector) -> schemas.SectorSummary:
    """Готовая сводка сектора со вложенными бригадой, задачами и проблемами.

    Функция не изменяет БД: процент считается на лету, а сохранённое значение
    обновляется отдельно, в `recalculate_sector`.
    """
    tasks = _fetch_ordered(db, models.Task, sector.task_ids)
    problems = _fetch_ordered(db, models.Problem, sector.problem_ids)
    brigade = db.get(models.Brigade, sector.brigade_id) if sector.brigade_id else None
    return _assemble(sector, tasks, problems, brigade)


def build_project_snapshot(db: Session, project: models.Project) -> schemas.ProjectSnapshot:
    """Слепок всего проекта: один запрос — вся сцена.

    Задачи, проблемы и бригады загружаются пакетно (три запроса на весь проект,
    а не три на каждый сектор), иначе на объекте с полусотней зон получался бы
    N+1 на каждое открытие вида и на каждый цикл резервного опроса.
    """
    sectors = db.scalars(
        select(models.Sector)
        .where(models.Sector.project_id == project.id)
        .order_by(models.Sector.id)
    ).all()
    brigades = db.scalars(
        select(models.Brigade)
        .where(models.Brigade.project_id == project.id)
        .order_by(models.Brigade.id)
    ).all()

    task_ids: set[int] = set()
    problem_ids: set[int] = set()
    for sector in sectors:
        task_ids.update(int(i) for i in (sector.task_ids or []))
        problem_ids.update(int(i) for i in (sector.problem_ids or []))

    tasks_by_id: dict[int, object] = {}
    if task_ids:
        tasks_by_id = {
            t.id: t
            for t in db.scalars(select(models.Task).where(models.Task.id.in_(task_ids))).all()
        }
    problems_by_id: dict[int, object] = {}
    if problem_ids:
        problems_by_id = {
            p.id: p
            for p in db.scalars(
                select(models.Problem).where(models.Problem.id.in_(problem_ids))
            ).all()
        }
    brigades_by_id = {b.id: b for b in brigades}

    summaries = [
        _assemble(
            sector,
            _order_from_cache(tasks_by_id, sector.task_ids),
            _order_from_cache(problems_by_id, sector.problem_ids),
            brigades_by_id.get(sector.brigade_id) if sector.brigade_id else None,
        )
        for sector in sectors
    ]

    brigade_out = [
        schemas.BrigadeWithAssignment(
            id=b.id,
            project_id=b.project_id,
            name=b.name,
            brigadir=b.brigadir,
            cnt_people=b.cnt_people,
            assigned_sector_ids=[s.id for s in sectors if s.brigade_id == b.id],
        )
        for b in brigades
    ]

    return schemas.ProjectSnapshot(
        project=schemas.ProjectOut.model_validate(project),
        brigades=brigade_out,
        sectors=summaries,
    )


def purge_sector_children(db: Session, sector: models.Sector) -> None:
    """Удалить задачи и проблемы сектора.

    Связь хранится JSON-массивами (так требует ТЗ), внешних ключей нет —
    значит, каскад БД тут не сработает и чистить надо руками.
    """
    for task_id in list(sector.task_ids or []):
        task = db.get(models.Task, task_id)
        if task:
            db.delete(task)
    for problem_id in list(sector.problem_ids or []):
        problem = db.get(models.Problem, problem_id)
        if problem:
            db.delete(problem)
    sector.task_ids = []
    sector.problem_ids = []
