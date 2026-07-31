"""Тесты миграции схемы на настоящем SQLite-файле.

Запуск:  python -m unittest discover -s tests -v
"""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import create_engine, text  # noqa: E402

from app.migrate import _layer_name, run_migrations  # noqa: E402

#: Схема «до доработок» — ровно та, что лежит у заказчика в data.db.
LEGACY_SCHEMA = """
CREATE TABLE projects (
    id INTEGER NOT NULL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    model_url VARCHAR(512),
    created_at DATETIME NOT NULL
);
CREATE TABLE brigades (
    id INTEGER NOT NULL PRIMARY KEY,
    project_id INTEGER NOT NULL,
    name VARCHAR(255) NOT NULL,
    brigadir VARCHAR(255) NOT NULL,
    cnt_people INTEGER NOT NULL
);
CREATE TABLE sectors (
    id INTEGER NOT NULL PRIMARY KEY,
    project_id INTEGER NOT NULL,
    name VARCHAR(255) NOT NULL,
    coordinates JSON NOT NULL,
    brigade_id INTEGER,
    task_ids JSON NOT NULL,
    problem_ids JSON NOT NULL,
    progress_percent FLOAT NOT NULL,
    created_at DATETIME NOT NULL
);
CREATE TABLE project_models (
    id INTEGER NOT NULL PRIMARY KEY,
    project_id INTEGER NOT NULL,
    name VARCHAR(255) NOT NULL,
    model_url VARCHAR(512) NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL,
    created_at DATETIME NOT NULL
);
"""


class MigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.path = Path(self._dir.name) / "legacy.db"
        self.engine = create_engine(f"sqlite:///{self.path}")
        with self.engine.begin() as conn:
            for statement in LEGACY_SCHEMA.strip().split(";"):
                if statement.strip():
                    conn.execute(text(statement))

    def tearDown(self) -> None:
        self.engine.dispose()
        self._dir.cleanup()

    # -------------------------------------------------------------- helpers
    def _seed(self) -> None:
        with self.engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO projects (id, name, model_url, created_at) VALUES "
                    "(1, 'Корпус 1', '/media/models/p1_aabbccdd_building.glb', CURRENT_TIMESTAMP),"
                    "(2, 'Корпус 2', NULL, CURRENT_TIMESTAMP)"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO brigades (id, project_id, name, brigadir, cnt_people) VALUES "
                    "(7, 1, 'Монолитчики', 'Иванов', 10)"
                )
            )
            conn.execute(
                text(
                    "INSERT INTO sectors "
                    "(id, project_id, name, coordinates, brigade_id, task_ids, problem_ids,"
                    " progress_percent, created_at) VALUES "
                    "(1, 1, 'Секция А', '[]', 7, '[]', '[]', 0, CURRENT_TIMESTAMP),"
                    "(2, 1, 'Секция Б', '[]', NULL, '[]', '[]', 0, CURRENT_TIMESTAMP)"
                )
            )

    def _rows(self, sql: str) -> list[tuple]:
        with self.engine.begin() as conn:
            return conn.execute(text(sql)).all()

    def _columns(self, table: str) -> set[str]:
        return {row[1] for row in self._rows(f'PRAGMA table_info("{table}")')}

    # ---------------------------------------------------------------- tests
    def test_adds_new_columns(self) -> None:
        self._seed()
        run_migrations(self.engine)
        columns = self._columns("sectors")
        self.assertIn("brigade_ids", columns)
        self.assertIn("height", columns)

    def test_backfills_brigade_assignment(self) -> None:
        self._seed()
        run_migrations(self.engine)
        rows = dict(self._rows("SELECT id, brigade_ids FROM sectors"))
        self.assertEqual(json.loads(rows[1]), [7])
        # Сектор без бригады остаётся с пустым массивом, а не с [null].
        self.assertEqual(json.loads(rows[2]), [])

    def test_height_defaults_to_zero(self) -> None:
        self._seed()
        run_migrations(self.engine)
        heights = [row[0] for row in self._rows("SELECT height FROM sectors")]
        self.assertEqual(heights, [0.0, 0.0])

    def test_moves_model_url_into_layers(self) -> None:
        self._seed()
        run_migrations(self.engine)
        layers = self._rows("SELECT project_id, name, model_url, sort_order FROM project_models")
        self.assertEqual(len(layers), 1)
        project_id, name, model_url, sort_order = layers[0]
        self.assertEqual(project_id, 1)
        self.assertEqual(model_url, "/media/models/p1_aabbccdd_building.glb")
        self.assertEqual(sort_order, 0)
        # Внутренний префикс «p<id>_<hash>_» в имени слоя показывать незачем.
        self.assertEqual(name, "building")

    def test_is_idempotent(self) -> None:
        self._seed()
        run_migrations(self.engine)
        run_migrations(self.engine)
        run_migrations(self.engine)
        self.assertEqual(len(self._rows("SELECT id FROM project_models")), 1)
        rows = dict(self._rows("SELECT id, brigade_ids FROM sectors"))
        self.assertEqual(json.loads(rows[1]), [7])

    def test_does_not_overwrite_existing_assignment(self) -> None:
        """Повторная миграция не откатывает бригады, изменённые после первой."""
        self._seed()
        run_migrations(self.engine)
        with self.engine.begin() as conn:
            conn.execute(text("UPDATE sectors SET brigade_ids = '[7, 9]' WHERE id = 1"))
        run_migrations(self.engine)
        rows = dict(self._rows("SELECT id, brigade_ids FROM sectors"))
        self.assertEqual(json.loads(rows[1]), [7, 9])

    def test_runs_on_empty_database(self) -> None:
        run_migrations(self.engine)
        self.assertIn("brigade_ids", self._columns("sectors"))
        self.assertEqual(self._rows("SELECT id FROM project_models"), [])

    def test_survives_missing_tables(self) -> None:
        """На совсем чистой базе (таблиц ещё нет) миграция не падает."""
        with self.engine.begin() as conn:
            conn.execute(text("DROP TABLE sectors"))
            conn.execute(text("DROP TABLE project_models"))
        run_migrations(self.engine)

    def test_two_projects_sharing_one_file(self) -> None:
        """model_url уникален: второй проект с тем же файлом не ломает миграцию."""
        with self.engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO projects (id, name, model_url, created_at) VALUES "
                    "(1, 'A', '/media/models/shared.glb', CURRENT_TIMESTAMP),"
                    "(2, 'B', '/media/models/shared.glb', CURRENT_TIMESTAMP)"
                )
            )
        run_migrations(self.engine)
        layers = self._rows("SELECT project_id FROM project_models")
        self.assertEqual(len(layers), 1)


class LayerNameTests(unittest.TestCase):
    def test_strips_extension(self) -> None:
        self.assertEqual(_layer_name("/media/models/Корпус 3.glb", "проект"), "Корпус 3")
        self.assertEqual(_layer_name("/media/models/scene.GLTF", "проект"), "scene")

    def test_strips_internal_upload_prefix(self) -> None:
        self.assertEqual(_layer_name("/media/models/p12_0a1b2c3d_ar.glb", "п"), "ar")

    def test_keeps_names_that_only_look_like_a_prefix(self) -> None:
        # Префикс — строго p<цифры>_<8 hex>_; обычное имя не должно урезаться.
        self.assertEqual(_layer_name("/media/models/plan_2024_ar.glb", "п"), "plan_2024_ar")

    def test_falls_back_when_name_is_empty(self) -> None:
        self.assertEqual(_layer_name("/media/models/.glb", "Проект"), "Проект")
        self.assertEqual(_layer_name("", ""), "Модель")


if __name__ == "__main__":
    unittest.main()
