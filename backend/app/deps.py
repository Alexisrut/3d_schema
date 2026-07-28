"""Зависимости FastAPI: текущий пользователь, роль, доступ к проекту."""
from __future__ import annotations

from typing import Annotated

from fastapi import Depends, HTTPException, Path, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from . import models
from .database import get_db
from .security import decode_access_token

bearer = HTTPBearer(auto_error=False)

DbSession = Annotated[Session, Depends(get_db)]


def _unauthorized(detail: str = "Требуется авторизация") -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def get_current_user(
    db: DbSession,
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)] = None,
) -> models.User:
    """Пользователь строго из заголовка Authorization.

    Токен в query-строке сознательно не принимается: он утекал бы в логи
    доступа, историю браузера и Referer. Двум местам, где заголовок передать
    нельзя (WebSocket и загрузка .glb движком three.js), токен передаётся
    явным параметром в их собственных обработчиках.
    """
    token = creds.credentials if creds else None
    if not token:
        raise _unauthorized()

    payload = decode_access_token(token)
    if not payload or "sub" not in payload:
        raise _unauthorized("Токен недействителен или истёк")

    try:
        user_id = int(payload["sub"])
    except (TypeError, ValueError):
        raise _unauthorized("Токен недействителен") from None

    user = db.get(models.User, user_id)
    if user is None:
        raise _unauthorized("Пользователь не найден")
    return user


CurrentUser = Annotated[models.User, Depends(get_current_user)]


def require_admin(user: CurrentUser) -> models.User:
    if user.role != models.UserRole.admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Действие доступно только администратору",
        )
    return user


AdminUser = Annotated[models.User, Depends(require_admin)]


def get_project_for_user(
    db: DbSession,
    user: CurrentUser,
    project_id: Annotated[int, Path(ge=1)],
) -> models.Project:
    """Проект из пути + проверка, что пользователю он назначен."""
    project = db.get(models.Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Проект не найден")
    if not user.can_access(project.id):
        raise HTTPException(status_code=403, detail="Нет доступа к этому проекту")
    return project


AccessibleProject = Annotated[models.Project, Depends(get_project_for_user)]
