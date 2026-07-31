"""Агрегация данных сектора на бэкенде (п. 5.1 ТЗ).

Фронтенд не считает ничего сам — он получает готовую сводку.
"""
from __future__ import annotations

from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import models, schemas
from .config import settings
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


def normalize_ids(ids: list[int] | None) -> list[int]:
    """Целые числа, без дублей, в исходном порядке.

    Порядок сохраняется, потому что он виден пользователю: бригады
    показываются в том порядке, в котором их назначили.
    """
    seen: set[int] = set()
    result: list[int] = []
    for raw in ids or []:
        try:
            value = int(raw)
        except (TypeError, ValueError):
            continue
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def prune_missing_ids(db: Session, sector: models.Sector) -> None:
    """Убрать из JSON-массивов ID удалённых задач/проблем/бригад.

    Самолечение данных: внешних ключей у этих связей нет (так требует ТЗ),
    поэтому удаление записи не может почистить ссылку на неё автоматически.
    """
    tasks = _fetch_ordered(db, models.Task, sector.task_ids)
    problems = _fetch_ordered(db, models.Problem, sector.problem_ids)
    brigades = _fetch_ordered(db, models.Brigade, sector.brigade_ids)
    alive_tasks = [t.id for t in tasks]
    alive_problems = [p.id for p in problems]
    # Бригаду, уехавшую в другой проект, на этой зоне тоже держать нельзя.
    alive_brigades = [b.id for b in brigades if b.project_id == sector.project_id]
    if alive_tasks != list(sector.task_ids or []):
        sector.task_ids = alive_tasks
    if alive_problems != list(sector.problem_ids or []):
        sector.problem_ids = alive_problems
    if alive_brigades != list(sector.brigade_ids or []):
        sector.brigade_ids = alive_brigades


def recalculate_sector(db: Session, sector: models.Sector) -> float:
    """Пересчитать и сохранить progress_percent сектора.

    Вызывается только на путях записи — чтения БД не меняют.
    """
    prune_missing_ids(db, sector)
    tasks = _fetch_ordered(db, models.Task, sector.task_ids)
    sector.progress_percent = compute_progress(tasks)
    db.flush()
    return sector.progress_percent


def attachment_url(stored_name: str) -> str:
    return f"/media/attachments/{stored_name}"


def attachment_out(row: models.Attachment) -> schemas.AttachmentOut:
    return schemas.AttachmentOut(
        id=row.id,
        filename=row.filename,
        content_type=row.content_type,
        size_bytes=row.size_bytes,
        created_at=row.created_at,
        url=attachment_url(row.stored_name),
    )


def attachments_for(
    db: Session, kind: models.CardKind, card_ids: list[int]
) -> dict[int, list[schemas.AttachmentOut]]:
    """Вложения пачкой по списку карточек.

    Один запрос на весь список: карточек в проекте сотни, и запрос на каждую
    превратил бы открытие сцены в N+1.
    """
    if not card_ids:
        return {}
    rows = db.scalars(
        select(models.Attachment)
        .where(
            models.Attachment.card_kind == kind,
            models.Attachment.card_id.in_(card_ids),
        )
        .order_by(models.Attachment.id)
    ).all()
    grouped: dict[int, list[schemas.AttachmentOut]] = {}
    for row in rows:
        grouped.setdefault(row.card_id, []).append(attachment_out(row))
    return grouped


def _assemble(
    sector: models.Sector,
    tasks: list[models.Task],
    problems: list[models.Problem],
    brigades: list[models.Brigade],
    task_files: dict[int, list[schemas.AttachmentOut]] | None = None,
    problem_files: dict[int, list[schemas.AttachmentOut]] | None = None,
) -> schemas.SectorSummary:
    task_files = task_files or {}
    problem_files = problem_files or {}
    return schemas.SectorSummary(
        id=sector.id,
        project_id=sector.project_id,
        name=sector.name,
        coordinates=sector.coordinates or [],
        height=float(sector.height or 0.0),
        top_coordinates=sector.top_coordinates or None,
        progress_percent=compute_progress(tasks),
        brigades=[schemas.BrigadeOut.model_validate(b) for b in brigades],
        tasks=[
            schemas.TaskOut.model_validate(t).model_copy(
                update={"attachments": task_files.get(t.id, [])}
            )
            for t in tasks
        ],
        problems=[
            schemas.ProblemOut.model_validate(p).model_copy(
                update={"attachments": problem_files.get(p.id, [])}
            )
            for p in problems
        ],
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
    brigades = _fetch_ordered(db, models.Brigade, sector.brigade_ids)
    return _assemble(
        sector,
        tasks,
        problems,
        brigades,
        attachments_for(db, models.CardKind.task, [t.id for t in tasks]),
        attachments_for(db, models.CardKind.problem, [p.id for p in problems]),
    )


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
    model_layers = db.scalars(
        select(models.ProjectModel)
        .where(models.ProjectModel.project_id == project.id)
        .order_by(models.ProjectModel.sort_order, models.ProjectModel.id)
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

    # Вложения — тоже пачкой на весь проект, по одному запросу на вид карточки.
    task_files = attachments_for(db, models.CardKind.task, list(task_ids))
    problem_files = attachments_for(db, models.CardKind.problem, list(problem_ids))

    summaries = [
        _assemble(
            sector,
            _order_from_cache(tasks_by_id, sector.task_ids),
            _order_from_cache(problems_by_id, sector.problem_ids),
            _order_from_cache(brigades_by_id, sector.brigade_ids),
            task_files,
            problem_files,
        )
        for sector in sectors
    ]

    # Обратный индекс «бригада → её зоны» строится одним проходом:
    # запрос на каждую бригаду по JSON-массиву SQLite отдал бы дороже.
    sectors_by_brigade: dict[int, list[int]] = {}
    for sector in sectors:
        for brigade_id in normalize_ids(sector.brigade_ids):
            sectors_by_brigade.setdefault(brigade_id, []).append(sector.id)

    brigade_out = [
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

    levels = db.scalars(
        select(models.Level)
        .where(models.Level.project_id == project.id)
        .order_by(models.Level.elevation)
    ).all()

    return schemas.ProjectSnapshot(
        project=schemas.ProjectOut.model_validate(project),
        models=[schemas.ProjectModelOut.model_validate(m) for m in model_layers],
        brigades=brigade_out,
        sectors=summaries,
        levels=[schemas.LevelOut.model_validate(level) for level in levels],
    )


def sectors_of_project(db: Session, project_id: int) -> list[models.Sector]:
    return list(
        db.scalars(
            select(models.Sector)
            .where(models.Sector.project_id == project_id)
            .order_by(models.Sector.id)
        ).all()
    )


def sector_ids_for_brigade(db: Session, project_id: int, brigade_id: int) -> list[int]:
    """Зоны, на которых занята бригада.

    Связь живёт в JSON-массиве, поэтому фильтруется в Python: диалектных
    JSON-операторов SQLite здесь избегаем сознательно — их поведение
    отличается от версии к версии, а зон в проекте десятки, не миллионы.
    """
    return [
        sector.id
        for sector in sectors_of_project(db, project_id)
        if brigade_id in normalize_ids(sector.brigade_ids)
    ]


def detach_brigade_everywhere(db: Session, project_id: int, brigade_id: int) -> list[int]:
    """Снять бригаду со всех зон проекта. Возвращает id затронутых зон."""
    affected: list[int] = []
    for sector in sectors_of_project(db, project_id):
        current = normalize_ids(sector.brigade_ids)
        if brigade_id not in current:
            continue
        sector.brigade_ids = [i for i in current if i != brigade_id]
        affected.append(sector.id)
    if affected:
        db.flush()
    return affected


def sync_primary_model(db: Session, project: models.Project) -> None:
    """Держать project.model_url равным первому слою.

    Колонка осталась ради списка проектов («модель загружена») и старых
    клиентов; единственное правило её значения — первый слой или NULL.
    """
    first = db.scalar(
        select(models.ProjectModel)
        .where(models.ProjectModel.project_id == project.id)
        .order_by(models.ProjectModel.sort_order, models.ProjectModel.id)
        .limit(1)
    )
    desired = first.model_url if first else None
    if project.model_url != desired:
        project.model_url = desired
        db.flush()


def purge_card_attachments(db: Session, kind: models.CardKind, card_id: int) -> None:
    """Удалить вложения карточки вместе с файлами на диске.

    Файл удаляется после записи в БД: осиротевшая строка чинится вручную,
    а потерянный файл не вернуть.
    """
    rows = db.scalars(
        select(models.Attachment).where(
            models.Attachment.card_kind == kind,
            models.Attachment.card_id == card_id,
        )
    ).all()
    doomed = [row.stored_name for row in rows]
    for row in rows:
        db.delete(row)
    if doomed:
        db.flush()
    for stored_name in doomed:
        remove_attachment_file(stored_name)


def remove_attachment_file(stored_name: str) -> None:
    """Стереть файл вложения. Отсутствие файла ошибкой не считается."""
    target = settings.attachments_dir / Path(stored_name).name
    try:
        if target.is_file() and target.parent == settings.attachments_dir:
            target.unlink()
    except OSError:
        pass


def purge_sector_children(db: Session, sector: models.Sector) -> None:
    """Удалить задачи и проблемы сектора вместе с их вложениями.

    Связь хранится JSON-массивами (так требует ТЗ), внешних ключей нет —
    значит, каскад БД тут не сработает и чистить надо руками.
    """
    for task_id in list(sector.task_ids or []):
        purge_card_attachments(db, models.CardKind.task, task_id)
        task = db.get(models.Task, task_id)
        if task:
            db.delete(task)
    for problem_id in list(sector.problem_ids or []):
        purge_card_attachments(db, models.CardKind.problem, problem_id)
        problem = db.get(models.Problem, problem_id)
        if problem:
            db.delete(problem)
    sector.task_ids = []
    sector.problem_ids = []
