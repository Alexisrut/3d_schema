"""Личный кабинет: смена пароля и привязка почты с подтверждением.

Доступен всем ролям, включая «Читателя»: смена собственного пароля — не
изменение данных объекта, а управление своей учётной записью. Поэтому роутер
намеренно НЕ закрыт `EditorGuard`.
"""
from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from .. import mail, models, schemas
from ..config import settings
from ..deps import CurrentUser, DbSession
from ..security import hash_password, verify_password

log = logging.getLogger("account")

router = APIRouter(prefix="/api/account", tags=["account"])

#: Длина кода подтверждения. Шесть цифр удобно вводить с телефона, а перебор
#: закрыт ограничением на число попыток.
CODE_LENGTH = 6


@router.get("", response_model=schemas.AccountOut)
def get_account(user: CurrentUser) -> models.User:
    return user


@router.post("/password", response_model=schemas.AccountOut)
def change_password(
    payload: schemas.PasswordChange, user: CurrentUser, db: DbSession
) -> models.User:
    """Смена собственного пароля.

    Текущий пароль спрашивается обязательно: иначе оставленная без присмотра
    сессия позволяла бы навсегда увести учётную запись.
    """
    if not verify_password(payload.current_password, user.password_hash):
        raise HTTPException(status_code=400, detail="Текущий пароль указан неверно")
    if payload.new_password == payload.current_password:
        raise HTTPException(status_code=400, detail="Новый пароль совпадает с текущим")

    user.password_hash = hash_password(payload.new_password)
    db.commit()
    db.refresh(user)
    return user


@router.post("/email", response_model=schemas.MailReport)
def bind_email(payload: schemas.EmailBind, user: CurrentUser, db: DbSession):
    """Привязать почту и отправить на неё код подтверждения.

    Адрес сохраняется сразу, но неподтверждённым: до ввода кода он не даёт
    ни уведомлений, ни попадания в список адресатов.
    """
    address = str(payload.email).strip().lower()

    taken = db.scalar(
        select(models.User).where(
            models.User.email == address,
            models.User.email_verified.is_(True),
            models.User.id != user.id,
        )
    )
    if taken is not None:
        raise HTTPException(status_code=409, detail="Эта почта уже подтверждена другим пользователем")

    code = _generate_code()
    user.email = address
    user.email_verified = False
    user.email_code_hash = hash_password(code)
    user.email_code_expires_at = datetime.now(timezone.utc) + timedelta(
        minutes=settings.email_code_ttl_minutes
    )
    user.email_code_attempts = 0
    db.commit()

    result = mail.send_verification_code(address, user.username, code)
    if result.skipped:
        # Без почтового сервера код всё равно нужен разработчику — он ушёл в лог.
        log.info("Код подтверждения для %s: %s", address, code)
    return schemas.MailReport(
        sent=result.sent, failed=result.failed, skipped=result.skipped, error=result.error
    )


@router.post("/email/confirm", response_model=schemas.AccountOut)
def confirm_email(
    payload: schemas.EmailConfirm, user: CurrentUser, db: DbSession
) -> models.User:
    """Подтвердить почту кодом из письма."""
    if not user.email or not user.email_code_hash:
        raise HTTPException(status_code=400, detail="Сначала привяжите почту")
    if user.email_verified:
        return user

    expires = user.email_code_expires_at
    # SQLite отдаёт время без зоны — сравниваем в UTC явно.
    if expires is not None and expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires is None or expires < datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="Срок действия кода истёк, запросите новый")

    if user.email_code_attempts >= settings.email_code_max_attempts:
        raise HTTPException(
            status_code=429,
            detail="Слишком много неудачных попыток. Запросите новый код.",
        )

    if not verify_password(payload.code.strip(), user.email_code_hash):
        user.email_code_attempts += 1
        db.commit()
        left = max(0, settings.email_code_max_attempts - user.email_code_attempts)
        raise HTTPException(status_code=400, detail=f"Код неверен. Осталось попыток: {left}")

    user.email_verified = True
    # Код одноразовый — стираем вместе со сроком и счётчиком попыток.
    user.email_code_hash = None
    user.email_code_expires_at = None
    user.email_code_attempts = 0
    db.commit()
    db.refresh(user)
    return user


@router.delete("/email", response_model=schemas.AccountOut)
def unbind_email(user: CurrentUser, db: DbSession) -> models.User:
    """Отвязать почту — пользователь пропадает из списка адресатов."""
    user.email = None
    user.email_verified = False
    user.email_code_hash = None
    user.email_code_expires_at = None
    user.email_code_attempts = 0
    db.commit()
    db.refresh(user)
    return user


def _generate_code() -> str:
    """Криптостойкий числовой код фиксированной длины."""
    return "".join(str(secrets.randbelow(10)) for _ in range(CODE_LENGTH))
