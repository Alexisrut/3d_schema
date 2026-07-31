"""Pydantic-схемы: контракт между FastAPI и фронтендом."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from .models import TaskStatus, UserRole

ORM = ConfigDict(from_attributes=True)


# ---------------------------------------------------------------- auth / users
class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: "UserOut"


class UserOut(BaseModel):
    model_config = ORM

    id: int
    username: str
    role: UserRole
    allowed_project_ids: list[int] = Field(default_factory=list)
    created_at: datetime
    email: str | None = None
    email_verified: bool = False


class UserCreate(BaseModel):
    username: str = Field(min_length=2, max_length=150)
    password: str = Field(min_length=4, max_length=128)
    role: UserRole = UserRole.contractor
    allowed_project_ids: list[int] = Field(default_factory=list)


class UserUpdate(BaseModel):
    password: str | None = Field(default=None, min_length=4, max_length=128)
    role: UserRole | None = None
    allowed_project_ids: list[int] | None = None


# -------------------------------------------------------------------- projects
class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)


class ProjectOut(BaseModel):
    model_config = ORM

    id: int
    name: str
    #: Первый слой моделей — для списка проектов. Полный список см. ProjectModelOut.
    model_url: str | None
    created_at: datetime


# ------------------------------------------------------------------ вложения
class AttachmentOut(BaseModel):
    model_config = ORM

    id: int
    filename: str
    content_type: str
    size_bytes: int
    created_at: datetime
    #: Путь скачивания: /media/attachments/<stored_name>
    url: str


class MailReport(BaseModel):
    """Итог рассылки — интерфейс показывает его пользователю."""

    sent: list[str] = Field(default_factory=list)
    failed: list[str] = Field(default_factory=list)
    skipped: bool = False
    error: str | None = None


class NotifyRequest(BaseModel):
    """Кого известить о карточке."""

    user_ids: list[int] = Field(default_factory=list)


class NotifyRecipient(BaseModel):
    """Пользователь с подтверждённой почтой — вариант в списке адресатов."""

    id: int
    username: str
    email: str


# -------------------------------------------------------------------- этажи
class LevelOut(BaseModel):
    model_config = ORM

    id: int
    project_id: int
    name: str
    elevation: float
    created_at: datetime


class LevelCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    elevation: float


class LevelUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    elevation: float | None = None


# --------------------------------------------------------------- личный кабинет
class PasswordChange(BaseModel):
    current_password: str = Field(min_length=1)
    new_password: str = Field(min_length=6, max_length=128)


class EmailBind(BaseModel):
    email: EmailStr


class EmailConfirm(BaseModel):
    code: str = Field(min_length=4, max_length=12)


class AccountOut(BaseModel):
    """Профиль для личного кабинета."""

    model_config = ORM

    id: int
    username: str
    role: UserRole
    email: str | None = None
    email_verified: bool = False
    allowed_project_ids: list[int] = Field(default_factory=list)
    created_at: datetime


# -------------------------------------------------------------- модели (слои)
class ProjectModelOut(BaseModel):
    """Один .glb-слой сцены (панель «Слои»)."""

    model_config = ORM

    id: int
    project_id: int
    name: str
    model_url: str
    sort_order: int
    created_at: datetime


class ProjectModelUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    sort_order: int | None = Field(default=None, ge=0)


# -------------------------------------------------------------------- brigades
class BrigadeCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    brigadir: str = ""
    cnt_people: int = Field(default=0, ge=0)


class BrigadeUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    brigadir: str | None = None
    cnt_people: int | None = Field(default=None, ge=0)


class BrigadeOut(BaseModel):
    model_config = ORM

    id: int
    project_id: int
    name: str
    brigadir: str
    cnt_people: int


class BrigadeWithAssignment(BrigadeOut):
    """Бригада + информация о том, на каких секторах она сейчас занята."""

    assigned_sector_ids: list[int] = Field(default_factory=list)


# ----------------------------------------------------------------------- tasks
class TaskCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    definition: str = ""
    status: TaskStatus = TaskStatus.todo
    progress: int = Field(default=0, ge=0, le=100)


class TaskUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    definition: str | None = None
    status: TaskStatus | None = None
    progress: int | None = Field(default=None, ge=0, le=100)


class TaskOut(BaseModel):
    model_config = ORM

    id: int
    name: str
    definition: str
    status: TaskStatus
    progress: int
    #: От этого момента интерфейс считает таймер «сколько времени прошло».
    created_at: datetime
    attachments: list[AttachmentOut] = Field(default_factory=list)


# -------------------------------------------------------------------- problems
class ProblemCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    definition: str = ""
    is_resolved: bool = False


class ProblemUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    definition: str | None = None
    is_resolved: bool | None = None


class ProblemOut(BaseModel):
    model_config = ORM

    id: int
    name: str
    definition: str
    is_resolved: bool
    created_at: datetime
    attachments: list[AttachmentOut] = Field(default_factory=list)


# --------------------------------------------------------------------- sectors
#: Предел высоты выдавливания: 500 м перекрывает любой реальный объект,
#: но защищает сцену от опечатки в тысячу этажей.
MAX_SECTOR_HEIGHT = 500.0


class SectorCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    coordinates: list[list[float]] = Field(default_factory=list)
    #: Высота объёма зоны в метрах; 0 — плоская зона по поверхности.
    height: float = Field(default=0.0, ge=0, le=MAX_SECTOR_HEIGHT)
    #: Правленая верхняя грань; None — верх повторяет основание.
    top_coordinates: list[list[float]] | None = None
    brigade_ids: list[int] = Field(default_factory=list)


class SectorUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    coordinates: list[list[float]] | None = None
    height: float | None = Field(default=None, ge=0, le=MAX_SECTOR_HEIGHT)
    #: Пустой список сбрасывает правку верха к ровному выдавливанию.
    top_coordinates: list[list[float]] | None = None


class SectorBrigadesAssign(BaseModel):
    """Полная замена списка бригад сектора."""

    brigade_ids: list[int] = Field(default_factory=list)


class SectorBrigadeRef(BaseModel):
    """Добавление одной бригады к сектору (drag-and-drop).

    Точечная операция вместо PUT со всем списком: два прораба, бросающие
    разные бригады на одну зону, иначе затирали бы работу друг друга.
    """

    brigade_id: int


class SectorSummary(BaseModel):
    """Готовая сводка сектора — то, что фронтенд рисует поверх .glb (п. 5.1 ТЗ)."""

    id: int
    project_id: int
    name: str
    coordinates: list[list[float]]
    height: float = 0.0
    top_coordinates: list[list[float]] | None = None
    progress_percent: float
    #: Все бригады сектора, в порядке назначения.
    brigades: list[BrigadeOut] = Field(default_factory=list)
    tasks: list[TaskOut] = Field(default_factory=list)
    problems: list[ProblemOut] = Field(default_factory=list)
    in_progress_task_ids: list[int] = Field(default_factory=list)
    tasks_total: int = 0
    tasks_done: int = 0
    open_problems: int = 0


# ------------------------------------------------------------ массовые действия
class BulkSectorIds(BaseModel):
    """Набор зон для массового действия."""

    sector_ids: list[int] = Field(min_length=1)


class BulkTaskCreate(BulkSectorIds):
    """Одна задача, заводимая в нескольких зонах.

    В каждой зоне создаётся своя запись Task: прогресс у зон разный, а общая
    запись означала бы, что отметка «готово» в одной зоне закрывает работу
    во всех остальных.
    """

    task: TaskCreate


class BulkProblemCreate(BulkSectorIds):
    problem: ProblemCreate


class BulkBrigadesAssign(BulkSectorIds):
    brigade_ids: list[int] = Field(default_factory=list)


class BulkSectorsResult(BaseModel):
    """Пересчитанные сводки всех затронутых зон — одним ответом."""

    sectors: list[SectorSummary] = Field(default_factory=list)


class BulkDeleteResult(BaseModel):
    deleted_ids: list[int] = Field(default_factory=list)


class BulkBrigadeDelete(BaseModel):
    brigade_ids: list[int] = Field(min_length=1)


class ProjectSnapshot(BaseModel):
    """Полный слепок проекта — один запрос при открытии 3D-вида."""

    project: ProjectOut
    #: Слои .glb — панель «Слои» рисуется из этого списка.
    models: list[ProjectModelOut] = Field(default_factory=list)
    brigades: list[BrigadeWithAssignment] = Field(default_factory=list)
    sectors: list[SectorSummary] = Field(default_factory=list)
    #: Закреплённые уровни (этажи) — панель «Этажи».
    levels: list[LevelOut] = Field(default_factory=list)


TokenResponse.model_rebuild()
