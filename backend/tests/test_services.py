"""Тесты сервисного слоя на настоящей БД в памяти: бригады-массивы, слои, сводки.

Запуск:  python -m unittest discover -s tests -v
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from app import models, services  # noqa: E402
from app.database import Base  # noqa: E402


class NormalizeIdsTests(unittest.TestCase):
    def test_removes_duplicates_keeping_order(self) -> None:
        self.assertEqual(services.normalize_ids([3, 1, 3, 2, 1]), [3, 1, 2])

    def test_casts_strings_from_json(self) -> None:
        # JSON из SQLite может отдать числа строками.
        self.assertEqual(services.normalize_ids(["4", 5]), [4, 5])

    def test_skips_garbage_instead_of_raising(self) -> None:
        self.assertEqual(services.normalize_ids([1, None, "нет", 2]), [1, 2])

    def test_empty_and_none(self) -> None:
        self.assertEqual(services.normalize_ids([]), [])
        self.assertEqual(services.normalize_ids(None), [])


class ServiceDbTests(unittest.TestCase):
    """Проверки, которым нужна настоящая сессия SQLAlchemy."""

    def setUp(self) -> None:
        self.engine = create_engine("sqlite://")  # in-memory
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine, future=True)
        self.db = self.Session()

        self.project = models.Project(name="Корпус 1")
        self.other = models.Project(name="Корпус 2")
        self.db.add_all([self.project, self.other])
        self.db.flush()

        self.b1 = models.Brigade(project_id=self.project.id, name="Монолитчики", cnt_people=8)
        self.b2 = models.Brigade(project_id=self.project.id, name="Каменщики", cnt_people=5)
        self.foreign = models.Brigade(project_id=self.other.id, name="Чужая", cnt_people=3)
        self.db.add_all([self.b1, self.b2, self.foreign])
        self.db.flush()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def _sector(self, name: str = "Секция", **kwargs) -> models.Sector:
        sector = models.Sector(
            project_id=self.project.id,
            name=name,
            coordinates=[[0, 0, 0], [1, 0, 0], [1, 0, 1]],
            task_ids=[],
            problem_ids=[],
            **kwargs,
        )
        self.db.add(sector)
        self.db.flush()
        return sector

    # ------------------------------------------------------------- сводка
    def test_summary_lists_all_brigades_in_order(self) -> None:
        sector = self._sector(brigade_ids=[self.b2.id, self.b1.id])
        summary = services.build_sector_summary(self.db, sector)
        self.assertEqual([b.id for b in summary.brigades], [self.b2.id, self.b1.id])

    def test_summary_exposes_height(self) -> None:
        summary = services.build_sector_summary(self.db, self._sector(height=3.5))
        self.assertEqual(summary.height, 3.5)

    def test_summary_without_brigades(self) -> None:
        summary = services.build_sector_summary(self.db, self._sector())
        self.assertEqual(summary.brigades, [])

    # -------------------------------------------------------------- prune
    def test_prune_drops_deleted_brigade(self) -> None:
        sector = self._sector(brigade_ids=[self.b1.id, self.b2.id])
        self.db.delete(self.b2)
        self.db.flush()
        services.prune_missing_ids(self.db, sector)
        self.assertEqual(sector.brigade_ids, [self.b1.id])

    def test_prune_drops_brigade_from_another_project(self) -> None:
        """Бригада чужого проекта на зоне — данные, которых не должно быть."""
        sector = self._sector(brigade_ids=[self.b1.id, self.foreign.id])
        services.prune_missing_ids(self.db, sector)
        self.assertEqual(sector.brigade_ids, [self.b1.id])

    def test_prune_keeps_valid_ids_untouched(self) -> None:
        sector = self._sector(brigade_ids=[self.b1.id, self.b2.id])
        services.prune_missing_ids(self.db, sector)
        self.assertEqual(sector.brigade_ids, [self.b1.id, self.b2.id])

    # ------------------------------------------------- обратная связь бригад
    def test_sector_ids_for_brigade(self) -> None:
        a = self._sector("А", brigade_ids=[self.b1.id])
        b = self._sector("Б", brigade_ids=[self.b1.id, self.b2.id])
        self._sector("В", brigade_ids=[])
        self.assertEqual(services.sector_ids_for_brigade(self.db, self.project.id, self.b1.id),
                         [a.id, b.id])
        self.assertEqual(services.sector_ids_for_brigade(self.db, self.project.id, self.b2.id),
                         [b.id])

    def test_detach_brigade_everywhere(self) -> None:
        a = self._sector("А", brigade_ids=[self.b1.id, self.b2.id])
        b = self._sector("Б", brigade_ids=[self.b1.id])
        c = self._sector("В", brigade_ids=[self.b2.id])
        affected = services.detach_brigade_everywhere(self.db, self.project.id, self.b1.id)
        self.assertEqual(affected, [a.id, b.id])
        self.assertEqual(a.brigade_ids, [self.b2.id])
        self.assertEqual(b.brigade_ids, [])
        # Зона, где этой бригады не было, не затронута.
        self.assertEqual(c.brigade_ids, [self.b2.id])

    def test_detach_brigade_that_is_not_assigned(self) -> None:
        self._sector("А", brigade_ids=[self.b2.id])
        self.assertEqual(services.detach_brigade_everywhere(self.db, self.project.id, self.b1.id), [])

    # ----------------------------------------------------------- слои модели
    def _layer(self, url: str, order: int, name: str = "Слой") -> models.ProjectModel:
        layer = models.ProjectModel(
            project_id=self.project.id, name=name, model_url=url, sort_order=order
        )
        self.db.add(layer)
        self.db.flush()
        return layer

    def test_primary_model_is_first_layer(self) -> None:
        self._layer("/media/models/b.glb", 2)
        self._layer("/media/models/a.glb", 1)
        services.sync_primary_model(self.db, self.project)
        self.assertEqual(self.project.model_url, "/media/models/a.glb")

    def test_primary_model_is_none_without_layers(self) -> None:
        self.project.model_url = "/media/models/stale.glb"
        services.sync_primary_model(self.db, self.project)
        self.assertIsNone(self.project.model_url)

    def test_primary_model_follows_deletion(self) -> None:
        first = self._layer("/media/models/a.glb", 1)
        self._layer("/media/models/b.glb", 2)
        services.sync_primary_model(self.db, self.project)
        self.db.delete(first)
        self.db.flush()
        services.sync_primary_model(self.db, self.project)
        self.assertEqual(self.project.model_url, "/media/models/b.glb")

    # -------------------------------------------------------------- слепок
    def test_snapshot_includes_layers_and_brigade_backlinks(self) -> None:
        self._layer("/media/models/a.glb", 1, name="АР")
        a = self._sector("А", brigade_ids=[self.b1.id, self.b2.id], height=3.0)
        b = self._sector("Б", brigade_ids=[self.b1.id])
        self.db.flush()

        snapshot = services.build_project_snapshot(self.db, self.project)
        self.assertEqual([m.name for m in snapshot.models], ["АР"])
        self.assertEqual(len(snapshot.sectors), 2)
        self.assertEqual([s.height for s in snapshot.sectors], [3.0, 0.0])
        self.assertEqual(
            [[br.id for br in s.brigades] for s in snapshot.sectors],
            [[self.b1.id, self.b2.id], [self.b1.id]],
        )
        by_id = {br.id: br for br in snapshot.brigades}
        self.assertEqual(by_id[self.b1.id].assigned_sector_ids, [a.id, b.id])
        self.assertEqual(by_id[self.b2.id].assigned_sector_ids, [a.id])

    def test_snapshot_brigade_without_sectors(self) -> None:
        snapshot = services.build_project_snapshot(self.db, self.project)
        by_id = {br.id: br for br in snapshot.brigades}
        self.assertEqual(by_id[self.b1.id].assigned_sector_ids, [])

    def test_snapshot_does_not_leak_other_project(self) -> None:
        self._layer("/media/models/a.glb", 1)
        snapshot = services.build_project_snapshot(self.db, self.other)
        self.assertEqual(snapshot.models, [])
        self.assertEqual([b.id for b in snapshot.brigades], [self.foreign.id])


if __name__ == "__main__":
    unittest.main()
