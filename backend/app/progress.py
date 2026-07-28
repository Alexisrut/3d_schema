"""Чистая логика расчёта прогресса — без ORM и без FastAPI.

Вынесено отдельно, чтобы алгоритм можно было покрыть тестами и переиспользовать
(например, в отчётах или фоновых задачах) без поднятия приложения.
"""
from __future__ import annotations

from typing import Iterable, Protocol

STATUS_TODO = "todo"
STATUS_IN_PROGRESS = "in_progress"
STATUS_DONE = "done"


class TaskLike(Protocol):
    """Минимальный контракт задачи: строковый статус и процент 0..100."""

    status: object
    progress: int


def _status_value(status: object) -> str:
    """Принять как Enum (у него есть .value), так и обычную строку."""
    value = getattr(status, "value", status)
    return str(value)


def effective_task_progress(task: TaskLike) -> float:
    """Вклад одной задачи в прогресс сектора, 0..100.

    Статус приоритетнее поля progress: 'done' — всегда 100 %, 'todo' — всегда 0 %.
    Промежуточное значение читается только у 'in_progress' и зажимается в 0..100.
    """
    status = _status_value(task.status)
    if status == STATUS_DONE:
        return 100.0
    if status == STATUS_TODO:
        return 0.0
    try:
        raw = int(task.progress)
    except (TypeError, ValueError):
        raw = 0
    return float(max(0, min(100, raw)))


def compute_progress(tasks: Iterable[TaskLike]) -> float:
    """Средний прогресс по задачам сектора, округлённый до 0.1. Без задач — 0 %."""
    values = [effective_task_progress(t) for t in tasks]
    if not values:
        return 0.0
    return round(sum(values) / len(values), 1)


def in_progress_ids(tasks: Iterable) -> list[int]:
    """ID задач, которые сейчас в работе (п. 5.1 ТЗ)."""
    return [t.id for t in tasks if _status_value(t.status) == STATUS_IN_PROGRESS]


def sync_status_and_progress(
    status: str, progress: int, leading: str = "progress"
) -> tuple[str, int]:
    """Согласовать пару (статус, процент) после изменения одного из полей.

    `leading` указывает, какое поле пользователь изменил осознанно, — оно и
    побеждает в конфликте. Без этого возврат задачи из 'done' в 'in_progress'
    был бы невозможен: старый progress=100 тут же поднимал бы статус обратно.
    """
    try:
        clamped = max(0, min(100, int(progress)))
    except (TypeError, ValueError):
        clamped = 0

    if leading == "status":
        if status == STATUS_DONE:
            return STATUS_DONE, 100
        if status == STATUS_TODO:
            return STATUS_TODO, 0
        # Сняли отметку «готово» — процент не должен возвращать статус обратно.
        return STATUS_IN_PROGRESS, min(clamped, 99)

    # Ведущий — процент.
    if clamped >= 100:
        return STATUS_DONE, 100
    if status == STATUS_DONE:
        # Процент снизили у выполненной задачи — она снова в работе.
        return STATUS_IN_PROGRESS, clamped
    if clamped == 0:
        return status if status in (STATUS_TODO, STATUS_IN_PROGRESS) else STATUS_TODO, 0
    return STATUS_IN_PROGRESS, clamped
