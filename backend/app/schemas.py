"""Pydantic-схемы: контракт между FastAPI и фронтендом."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

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


class UserCreate(BaseModel):
    username: str = Field(min_length=2, max_length=150)
    password: str = Field(min_length=4, max_length=128)
    role: UserRole = UserRole.user
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
    model_url: str | None
    created_at: datetime


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
    created_at: datetime


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


# --------------------------------------------------------------------- sectors
class SectorCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    coordinates: list[list[float]] = Field(default_factory=list)
    brigade_id: int | None = None


class SectorUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    coordinates: list[list[float]] | None = None


class SectorBrigadeAssign(BaseModel):
    brigade_id: int | None = None


class SectorSummary(BaseModel):
    """Готовая сводка сектора — то, что фронтенд рисует поверх .glb (п. 5.1 ТЗ)."""

    id: int
    project_id: int
    name: str
    coordinates: list[list[float]]
    progress_percent: float
    brigade: BrigadeOut | None = None
    tasks: list[TaskOut] = Field(default_factory=list)
    problems: list[ProblemOut] = Field(default_factory=list)
    in_progress_task_ids: list[int] = Field(default_factory=list)
    tasks_total: int = 0
    tasks_done: int = 0
    open_problems: int = 0


class ProjectSnapshot(BaseModel):
    """Полный слепок проекта — один запрос при открытии 3D-вида."""

    project: ProjectOut
    brigades: list[BrigadeWithAssignment] = Field(default_factory=list)
    sectors: list[SectorSummary] = Field(default_factory=list)


TokenResponse.model_rebuild()
