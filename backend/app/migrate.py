"""Приведение существующей базы к текущей схеме.

Alembic в проекте пока нет (см. «Открытые вопросы» в README), а база у
заказчика уже содержит данные: `create_all` создаёт только отсутствующие
таблицы и никогда не меняет существующие. Поэтому изменения схемы,
затрагивающие уже созданные таблицы, выполняются здесь — вручную,
идемпотентно и без потери данных.

Каждый шаг обязан безопасно выполняться на любой базе: пустой, свежей и
уже обновлённой. Функция вызывается при каждом старте приложения.
"""
from __future__ import annotations

import json
import logging
import re

from sqlalchemy import Engine, inspect, text

log = logging.getLogger("migrate")


def _columns(conn, table: str) -> set[str]:
    return {row[1] for row in conn.execute(text(f'PRAGMA table_info("{table}")'))}


def run_migrations(engine: Engine) -> None:
    """Выполнить все шаги миграции. Вызывать ПОСЛЕ Base.metadata.create_all."""
    tables = set(inspect(engine).get_table_names())
    with engine.begin() as conn:
        if "sectors" in tables:
            _sector_brigade_ids(conn)
            _sector_height(conn)
        if "project_models" in tables and "projects" in tables:
            _project_model_layers(conn)
        if "users" in tables:
            _user_role_contractor(conn)
            _user_email_fields(conn)


# --------------------------------------------------------------------------- #
def _user_role_contractor(conn) -> None:  # noqa: ANN001
    """Роль «user» переименована в «contractor».

    Значение роли хранится строкой (Enum с native_enum=False), поэтому
    достаточно обновить данные — менять тип колонки не нужно.
    """
    result = conn.execute(
        text("UPDATE users SET role = 'contractor' WHERE role = 'user'")
    )
    if result.rowcount:
        log.info("Миграция: роль «user» → «contractor» у %d пользователей", result.rowcount)


def _user_email_fields(conn) -> None:  # noqa: ANN001
    """Почта пользователя и её подтверждение."""
    columns = _columns(conn, "users")
    additions = {
        "email": "ALTER TABLE users ADD COLUMN email VARCHAR(255)",
        "email_verified": (
            "ALTER TABLE users ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT 0"
        ),
        "email_code_hash": "ALTER TABLE users ADD COLUMN email_code_hash VARCHAR(255)",
        "email_code_expires_at": "ALTER TABLE users ADD COLUMN email_code_expires_at DATETIME",
        "email_code_attempts": (
            "ALTER TABLE users ADD COLUMN email_code_attempts INTEGER NOT NULL DEFAULT 0"
        ),
    }
    for column, statement in additions.items():
        if column not in columns:
            conn.execute(text(statement))
            log.info("Миграция: users.%s добавлена", column)


# --------------------------------------------------------------------------- #
def _sector_brigade_ids(conn) -> None:  # noqa: ANN001
    """brigade_id (одна бригада) → brigade_ids (массив ID).

    Старая колонка сознательно не удаляется: DROP COLUMN в SQLite перестраивает
    таблицу, а выгода — ноль. Она остаётся пустой и ORM её больше не знает.
    """
    columns = _columns(conn, "sectors")
    if "brigade_ids" not in columns:
        # Константный DEFAULT — единственная форма ADD COLUMN NOT NULL,
        # которую разрешает SQLite.
        conn.execute(text("ALTER TABLE sectors ADD COLUMN brigade_ids JSON NOT NULL DEFAULT '[]'"))
        log.info("Миграция: sectors.brigade_ids добавлена")
        columns.add("brigade_ids")

    if "brigade_id" not in columns:
        return

    # Переносим прежнее назначение. Условие NOT NULL на brigade_ids и проверка
    # на пустой массив делают шаг идемпотентным: повторный запуск ничего не
    # перезапишет, даже если бригады уже поменяли вручную.
    rows = conn.execute(
        text(
            "SELECT id, brigade_id, brigade_ids FROM sectors "
            "WHERE brigade_id IS NOT NULL"
        )
    ).all()
    migrated = 0
    for sector_id, brigade_id, raw in rows:
        if _has_any(raw):
            continue
        conn.execute(
            text("UPDATE sectors SET brigade_ids = :ids WHERE id = :id"),
            {"ids": json.dumps([int(brigade_id)]), "id": sector_id},
        )
        migrated += 1
    if migrated:
        log.info("Миграция: перенесено назначений бригад — %d", migrated)


def _has_any(raw: object) -> bool:
    """В колонке уже есть непустой массив ID?"""
    if isinstance(raw, (list, tuple)):
        return len(raw) > 0
    if not raw:
        return False
    try:
        return bool(json.loads(str(raw)))
    except (TypeError, ValueError):
        return False


def _sector_height(conn) -> None:  # noqa: ANN001
    """Высота выдавливания зоны. 0 — прежние плоские зоны."""
    columns = _columns(conn, "sectors")
    if "height" not in columns:
        conn.execute(text("ALTER TABLE sectors ADD COLUMN height FLOAT NOT NULL DEFAULT 0"))
        log.info("Миграция: sectors.height добавлена")
    if "top_coordinates" not in columns:
        # NULL означает «верх повторяет основание» — прежние зоны так и
        # остаются ровными призмами без единой записи в данных.
        conn.execute(text("ALTER TABLE sectors ADD COLUMN top_coordinates JSON"))
        log.info("Миграция: sectors.top_coordinates добавлена")


def _project_model_layers(conn) -> None:  # noqa: ANN001
    """projects.model_url (одна модель) → project_models (слои).

    Колонка model_url остаётся: она показывает в списке проектов, загружена ли
    модель, и её значение поддерживается равным первому слою.
    """
    rows = conn.execute(
        text(
            "SELECT p.id, p.name, p.model_url FROM projects p "
            "WHERE p.model_url IS NOT NULL AND p.model_url <> '' "
            "AND NOT EXISTS (SELECT 1 FROM project_models m WHERE m.project_id = p.id)"
        )
    ).all()
    for project_id, project_name, model_url in rows:
        # Уникальность model_url — на случай, если два проекта ссылались на один
        # файл: второй слой просто не создаётся, файл остаётся у первого.
        exists = conn.execute(
            text("SELECT 1 FROM project_models WHERE model_url = :url"),
            {"url": model_url},
        ).first()
        if exists:
            continue
        conn.execute(
            text(
                "INSERT INTO project_models (project_id, name, model_url, sort_order, created_at) "
                "VALUES (:pid, :name, :url, 0, CURRENT_TIMESTAMP)"
            ),
            {"pid": project_id, "name": _layer_name(model_url, project_name), "url": model_url},
        )
        log.info("Миграция: модель проекта #%s перенесена в слои", project_id)


#: Имена загруженных файлов имеют внутренний префикс «p<id>_<8 hex>_».
#: Показывать его в панели «Слои» незачем.
_UPLOAD_PREFIX = re.compile(r"^p\d+_[0-9a-f]{8}_")


def _layer_name(model_url: str, fallback: str) -> str:
    """Человекочитаемое имя слоя из имени файла."""
    stem = str(model_url).rsplit("/", 1)[-1]
    for suffix in (".glb", ".gltf"):
        if stem.lower().endswith(suffix):
            stem = stem[: -len(suffix)]
            break
    stem = _UPLOAD_PREFIX.sub("", stem)
    return stem or fallback or "Модель"
