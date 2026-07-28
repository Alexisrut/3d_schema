#!/usr/bin/env python3
"""Наполнение базы демонстрационными данными.

Запуск из каталога backend:  python seed.py
Повторный запуск безопасен — существующие записи не дублируются.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from sqlalchemy import select

from app import models
from app.config import settings
from app.database import Base, SessionLocal, engine
from app.security import hash_password
from app.services import recalculate_sector

BASE_DIR = Path(__file__).resolve().parent
DEMO_MODEL = settings.models_dir / "demo_building.glb"


def ensure_demo_model() -> str | None:
    """Сгенерировать демо-.glb, если его ещё нет."""
    if not DEMO_MODEL.exists():
        script = BASE_DIR / "tools" / "make_demo_model.py"
        try:
            subprocess.run([sys.executable, str(script), str(DEMO_MODEL)], check=True)
        except (subprocess.CalledProcessError, OSError) as exc:
            print(f"Не удалось собрать демо-модель: {exc}")
            return None
    return f"/media/models/{DEMO_MODEL.name}"


def main() -> None:
    Base.metadata.create_all(bind=engine)
    model_url = ensure_demo_model()

    with SessionLocal() as db:
        admin = db.scalar(
            select(models.User).where(models.User.username == settings.seed_admin_username)
        )
        if admin is None:
            admin = models.User(
                username=settings.seed_admin_username,
                password_hash=hash_password(settings.seed_admin_password),
                role=models.UserRole.admin,
                allowed_project_ids=[],
            )
            db.add(admin)
            db.flush()

        project = db.scalar(
            select(models.Project).where(models.Project.name == "ЖК «Северный», корпус 3")
        )
        if project is None:
            project = models.Project(name="ЖК «Северный», корпус 3", model_url=model_url)
            db.add(project)
            db.flush()
        elif model_url and not project.model_url:
            project.model_url = model_url

        prorab = db.scalar(select(models.User).where(models.User.username == "prorab"))
        if prorab is None:
            prorab = models.User(
                username="prorab",
                password_hash=hash_password("prorab123"),
                role=models.UserRole.user,
                allowed_project_ids=[project.id],
            )
            db.add(prorab)
        elif project.id not in (prorab.allowed_project_ids or []):
            prorab.allowed_project_ids = [*(prorab.allowed_project_ids or []), project.id]

        existing_brigades = db.scalars(
            select(models.Brigade).where(models.Brigade.project_id == project.id)
        ).all()
        if not existing_brigades:
            brigades = [
                models.Brigade(project_id=project.id, name="Монолитчики 1",
                               brigadir="Иванов И. И.", cnt_people=12),
                models.Brigade(project_id=project.id, name="Монолитчики 2",
                               brigadir="Петров П. С.", cnt_people=9),
                models.Brigade(project_id=project.id, name="Каменщики",
                               brigadir="Сидоров А. В.", cnt_people=7),
                models.Brigade(project_id=project.id, name="Электрики",
                               brigadir="Кузнецов Д. О.", cnt_people=5),
            ]
            db.add_all(brigades)
            db.flush()
        else:
            brigades = list(existing_brigades)

        has_sectors = db.scalar(
            select(models.Sector).where(models.Sector.project_id == project.id)
        )
        if has_sectors is None:
            _create_demo_sectors(db, project, brigades)

        db.commit()

        print("База заполнена.")
        print(f"  Админ:        {settings.seed_admin_username} / {settings.seed_admin_password}")
        print("  Пользователь: prorab / prorab123")
        print(f"  Проект:       #{project.id} {project.name}")


def _create_demo_sectors(db, project: models.Project, brigades: list[models.Brigade]) -> None:
    """Две зоны на перекрытии 1-го этажа демо-модели (y = 0.2, чуть выше плиты)."""
    y = 0.2
    definitions = [
        {
            "name": "Секция А, 1 этаж",
            "coordinates": [[-11.0, y, -7.0], [-1.0, y, -7.0], [-1.0, y, 7.0], [-11.0, y, 7.0]],
            "brigade": brigades[0] if brigades else None,
            "tasks": [
                ("Устройство опалубки", "Опалубка стен и колонн секции А", "done", 100),
                ("Армирование", "Вязка каркаса, приёмка скрытых работ", "in_progress", 60),
                ("Бетонирование", "Заливка бетона В25", "todo", 0),
            ],
            "problems": [("Нет паспорта на арматуру", "Ожидаем документы от поставщика", False)],
        },
        {
            "name": "Секция Б, 1 этаж",
            "coordinates": [[1.0, y, -7.0], [11.0, y, -7.0], [11.0, y, 7.0], [1.0, y, 7.0]],
            "brigade": brigades[1] if len(brigades) > 1 else None,
            "tasks": [
                ("Устройство опалубки", "Опалубка секции Б", "in_progress", 35),
                ("Армирование", "Каркас перекрытия", "todo", 0),
            ],
            "problems": [],
        },
    ]

    for spec in definitions:
        sector = models.Sector(
            project_id=project.id,
            name=spec["name"],
            coordinates=spec["coordinates"],
            brigade_id=spec["brigade"].id if spec["brigade"] else None,
            task_ids=[],
            problem_ids=[],
        )
        db.add(sector)
        db.flush()

        task_ids: list[int] = []
        for name, definition, status, progress in spec["tasks"]:
            task = models.Task(
                name=name,
                definition=definition,
                status=models.TaskStatus(status),
                progress=progress,
            )
            db.add(task)
            db.flush()
            task_ids.append(task.id)

        problem_ids: list[int] = []
        for name, definition, resolved in spec["problems"]:
            problem = models.Problem(name=name, definition=definition, is_resolved=resolved)
            db.add(problem)
            db.flush()
            problem_ids.append(problem.id)

        sector.task_ids = task_ids
        sector.problem_ids = problem_ids
        db.flush()
        recalculate_sector(db, sector)


if __name__ == "__main__":
    main()
