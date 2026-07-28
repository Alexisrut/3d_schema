"""Тесты чистой логики расчёта прогресса (запускаются без FastAPI и SQLAlchemy).

Запуск:  python -m unittest discover -s tests -v
"""
from __future__ import annotations

import sys
import unittest
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.progress import (  # noqa: E402
    compute_progress,
    effective_task_progress,
    in_progress_ids,
    sync_status_and_progress,
)


@dataclass
class FakeTask:
    id: int = 0
    status: str = "todo"
    progress: int = 0


class FakeEnum:
    """Имитация SQLAlchemy Enum — у него есть .value."""

    def __init__(self, value: str) -> None:
        self.value = value


class EffectiveProgressTests(unittest.TestCase):
    def test_done_is_always_100(self) -> None:
        self.assertEqual(effective_task_progress(FakeTask(status="done", progress=3)), 100.0)

    def test_todo_is_always_0(self) -> None:
        self.assertEqual(effective_task_progress(FakeTask(status="todo", progress=80)), 0.0)

    def test_in_progress_uses_progress_field(self) -> None:
        self.assertEqual(effective_task_progress(FakeTask(status="in_progress", progress=42)), 42.0)

    def test_out_of_range_is_clamped(self) -> None:
        self.assertEqual(effective_task_progress(FakeTask(status="in_progress", progress=250)), 100.0)
        self.assertEqual(effective_task_progress(FakeTask(status="in_progress", progress=-5)), 0.0)

    def test_accepts_enum_like_status(self) -> None:
        task = FakeTask(progress=50)
        task.status = FakeEnum("in_progress")
        self.assertEqual(effective_task_progress(task), 50.0)

    def test_non_numeric_progress_falls_back_to_zero(self) -> None:
        task = FakeTask(status="in_progress")
        task.progress = None  # type: ignore[assignment]
        self.assertEqual(effective_task_progress(task), 0.0)


class ComputeProgressTests(unittest.TestCase):
    def test_empty_sector_is_zero(self) -> None:
        self.assertEqual(compute_progress([]), 0.0)

    def test_average_of_effective_values(self) -> None:
        tasks = [
            FakeTask(status="done", progress=100),
            FakeTask(status="in_progress", progress=60),
            FakeTask(status="todo", progress=0),
        ]
        # (100 + 60 + 0) / 3 = 53.333... -> 53.3
        self.assertEqual(compute_progress(tasks), 53.3)

    def test_all_done_is_100(self) -> None:
        self.assertEqual(compute_progress([FakeTask(status="done") for _ in range(4)]), 100.0)

    def test_rounding_to_one_decimal(self) -> None:
        tasks = [FakeTask(status="in_progress", progress=p) for p in (1, 2)]
        self.assertEqual(compute_progress(tasks), 1.5)

    def test_status_beats_stale_progress_field(self) -> None:
        # Задача помечена done, но поле progress не обновили — сектор всё равно 100 %.
        self.assertEqual(compute_progress([FakeTask(status="done", progress=10)]), 100.0)


class InProgressIdsTests(unittest.TestCase):
    def test_only_in_progress_ids_returned(self) -> None:
        tasks = [
            FakeTask(id=1, status="todo"),
            FakeTask(id=2, status="in_progress", progress=10),
            FakeTask(id=3, status="done"),
            FakeTask(id=4, status="in_progress", progress=90),
        ]
        self.assertEqual(in_progress_ids(tasks), [2, 4])


class SyncStatusTests(unittest.TestCase):
    """Ведущее поле — то, которое пользователь изменил осознанно."""

    def test_done_forces_100(self) -> None:
        self.assertEqual(sync_status_and_progress("done", 20, "status"), ("done", 100))

    def test_todo_forces_0(self) -> None:
        self.assertEqual(sync_status_and_progress("todo", 70, "status"), ("todo", 0))

    def test_reopening_done_task_is_possible(self) -> None:
        # Задача была done/100; пользователь вернул её в работу — статус
        # обязан сохраниться, иначе через интерфейс это не откатить.
        self.assertEqual(
            sync_status_and_progress("in_progress", 100, "status"), ("in_progress", 99)
        )

    def test_full_progress_promotes_to_done(self) -> None:
        self.assertEqual(sync_status_and_progress("in_progress", 100, "progress"), ("done", 100))

    def test_lowering_progress_of_done_task_reopens_it(self) -> None:
        self.assertEqual(sync_status_and_progress("done", 40, "progress"), ("in_progress", 40))

    def test_partial_progress_stays_in_progress(self) -> None:
        self.assertEqual(
            sync_status_and_progress("in_progress", 45, "progress"), ("in_progress", 45)
        )

    def test_zero_progress_keeps_todo(self) -> None:
        self.assertEqual(sync_status_and_progress("todo", 0, "progress"), ("todo", 0))

    def test_negative_progress_clamped(self) -> None:
        self.assertEqual(
            sync_status_and_progress("in_progress", -10, "progress"), ("in_progress", 0)
        )

    def test_non_numeric_progress_does_not_raise(self) -> None:
        self.assertEqual(
            sync_status_and_progress("in_progress", None, "progress"),  # type: ignore[arg-type]
            ("in_progress", 0),
        )


if __name__ == "__main__":
    unittest.main()
