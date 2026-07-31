"""Модели БД строго по разделу 4 ТЗ.

Замечание по денормализации: согласно ТЗ связь «сектор → задачи/проблемы»
хранится массивами JSON (task_ids / problem_ids) в самой записи сектора,
а не внешним ключом в Task/Problem. Источником истины считается сектор.
Тем же способом хранится связь «сектор → бригады» (brigade_ids): на одном
секторе может работать несколько бригад одновременно.
"""
from __future__ import annotations

import enum
from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, Enum, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class UserRole(str, enum.Enum):
    admin = "admin"
    #: Подрядчик — основная рабочая роль (прежнее название «user»).
    #: Значение в БД изменено миграцией; старое «user» больше не встречается.
    contractor = "contractor"
    #: Только чтение: может вращать камеру и открывать карточки, но не менять данные.
    reader = "reader"


class TaskStatus(str, enum.Enum):
    todo = "todo"
    in_progress = "in_progress"
    done = "done"


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    #: Модель, показанная в списке проектов, — всегда первый слой (или NULL).
    #: Само хранилище моделей — таблица project_models: их может быть несколько.
    model_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    sectors: Mapped[list["Sector"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    brigades: Mapped[list["Brigade"]] = relationship(
        back_populates="project", cascade="all, delete-orphan"
    )
    model_layers: Mapped[list["ProjectModel"]] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="ProjectModel.sort_order, ProjectModel.id",
    )
    levels: Mapped[list["Level"]] = relationship(
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="Level.elevation",
    )


class ProjectModel(Base):
    """Один .glb-слой проекта.

    Панель «Слои» показывает эти записи; видимость и прозрачность слоя —
    состояние клиента, а не БД: два прораба смотрят на объект по-разному
    и не должны переключать слои друг другу.
    """

    __tablename__ = "project_models"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    #: Путь вида /media/models/<файл>. Уникален — по нему media-роутер
    #: находит проект и проверяет права на выдачу файла.
    model_url: Mapped[str] = mapped_column(String(512), nullable=False, unique=True, index=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    project: Mapped[Project] = relationship(back_populates="model_layers")


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(150), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[UserRole] = mapped_column(
        Enum(UserRole, native_enum=False, length=16),
        default=UserRole.contractor,
        nullable=False,
    )
    allowed_project_ids: Mapped[list[int]] = mapped_column(JSON, default=list, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    # ------------------------------------------------------------------ почта
    #: Привязанная почта. Подтверждённой считается только при email_verified.
    email: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    email_verified: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    #: Хеш кода подтверждения — в открытом виде код не хранится: доступ к базе
    #: не должен давать возможности подтвердить чужую почту.
    email_code_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    email_code_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    #: Счётчик неудачных попыток — защита от перебора шестизначного кода.
    email_code_attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    def can_access(self, project_id: int) -> bool:
        if self.role == UserRole.admin:
            return True
        return project_id in (self.allowed_project_ids or [])


class Brigade(Base):
    __tablename__ = "brigades"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    brigadir: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    cnt_people: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    project: Mapped[Project] = relationship(back_populates="brigades")


class Sector(Base):
    __tablename__ = "sectors"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # Основание зоны: массив 3D-координат опорных точек [[x, y, z], ...]
    coordinates: Mapped[list[list[float]]] = mapped_column(JSON, default=list, nullable=False)
    #: Высота выдавливания основания вверх, в метрах. 0 — плоская зона
    #: (так выглядят все зоны, созданные до появления объёма).
    height: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    #: Верхняя грань, если её вершины двигали вручную: [[x, y, z], ...].
    #: NULL — верх ровно повторяет основание, поднятое на height.
    #: Длина обязана совпадать с coordinates, иначе боковины не сойдутся.
    top_coordinates: Mapped[list[list[float]] | None] = mapped_column(JSON, nullable=True)
    #: Бригады сектора — массив ID, как task_ids/problem_ids. Внешнего ключа нет,
    #: поэтому висячие ID вычищает services.prune_missing_ids.
    brigade_ids: Mapped[list[int]] = mapped_column(JSON, default=list, nullable=False)
    task_ids: Mapped[list[int]] = mapped_column(JSON, default=list, nullable=False)
    problem_ids: Mapped[list[int]] = mapped_column(JSON, default=list, nullable=False)
    progress_percent: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    project: Mapped[Project] = relationship(back_populates="sectors")


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    definition: Mapped[str] = mapped_column(Text, default="", nullable=False)
    status: Mapped[TaskStatus] = mapped_column(
        Enum(TaskStatus, native_enum=False, length=16), default=TaskStatus.todo, nullable=False
    )
    progress: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    #: Момент создания — от него считается таймер «сколько времени прошло».
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Problem(Base):
    __tablename__ = "problems"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    definition: Mapped[str] = mapped_column(Text, default="", nullable=False)
    is_resolved: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class CardKind(str, enum.Enum):
    """К чему приложен файл: к задаче или к проблеме."""

    task = "task"
    problem = "problem"


class Attachment(Base):
    """Файл, приложенный к карточке задачи или проблемы.

    Связь хранится парой (card_kind, card_id), а не двумя внешними ключами:
    задачи и проблемы — разные таблицы, и одна нулевая колонка из двух в
    каждой строке читалась бы хуже, чем явный вид карточки.
    """

    __tablename__ = "attachments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    card_kind: Mapped[CardKind] = mapped_column(
        Enum(CardKind, native_enum=False, length=16), nullable=False, index=True
    )
    card_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    #: Имя, которое видел пользователь. На диске файл лежит под другим.
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    #: Имя файла в storage/attachments — уникальное, без пользовательских символов.
    stored_name: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    content_type: Mapped[str] = mapped_column(String(150), default="", nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    uploaded_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Level(Base):
    """Этаж (уровень) объекта — горизонтальная отметка по оси Y.

    Отметка снимается с выбранной детали модели, поэтому хранится ровно одно
    число: плоскость этажа всегда горизонтальна.
    """

    __tablename__ = "levels"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    elevation: Mapped[float] = mapped_column(Float, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    project: Mapped[Project] = relationship(back_populates="levels")
