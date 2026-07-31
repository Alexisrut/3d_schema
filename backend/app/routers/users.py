"""Управление пользователями и выдача доступов к проектам (только админ)."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from .. import models, schemas
from ..deps import AdminUser, DbSession, EditorGuard
from ..security import hash_password

# Маршруты и так админские (роль «Читатель» админом быть не может), но
# защита от записи навешивается единообразно на все роутеры с мутациями.
router = APIRouter(prefix="/api/users", tags=["users"], dependencies=[EditorGuard])


@router.get("", response_model=list[schemas.UserOut])
def list_users(db: DbSession, _: AdminUser) -> list[models.User]:
    return list(db.scalars(select(models.User).order_by(models.User.id)).all())


@router.post("", response_model=schemas.UserOut, status_code=status.HTTP_201_CREATED)
def create_user(payload: schemas.UserCreate, db: DbSession, _: AdminUser) -> models.User:
    exists = db.scalar(select(models.User).where(models.User.username == payload.username))
    if exists:
        raise HTTPException(status_code=409, detail="Пользователь с таким логином уже есть")

    user = models.User(
        username=payload.username,
        password_hash=hash_password(payload.password),
        role=payload.role,
        allowed_project_ids=_valid_project_ids(db, payload.allowed_project_ids),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.patch("/{user_id}", response_model=schemas.UserOut)
def update_user(
    user_id: int, payload: schemas.UserUpdate, db: DbSession, admin: AdminUser
) -> models.User:
    user = db.get(models.User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="Пользователь не найден")

    if payload.password is not None:
        user.password_hash = hash_password(payload.password)
    if payload.role is not None:
        if user.id == admin.id and payload.role != models.UserRole.admin:
            raise HTTPException(status_code=400, detail="Нельзя снять роль администратора с себя")
        user.role = payload.role
    if payload.allowed_project_ids is not None:
        user.allowed_project_ids = _valid_project_ids(db, payload.allowed_project_ids)

    db.commit()
    db.refresh(user)
    return user


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(user_id: int, db: DbSession, admin: AdminUser):
    user = db.get(models.User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    if user.id == admin.id:
        raise HTTPException(status_code=400, detail="Нельзя удалить самого себя")
    db.delete(user)
    db.commit()


def _valid_project_ids(db, ids: list[int]) -> list[int]:  # noqa: ANN001
    """Оставить только реально существующие проекты, без дублей."""
    if not ids:
        return []
    unique = sorted({int(i) for i in ids})
    found = set(
        db.scalars(select(models.Project.id).where(models.Project.id.in_(unique))).all()
    )
    return [i for i in unique if i in found]
