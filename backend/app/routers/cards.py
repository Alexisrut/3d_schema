"""Вложения карточек, рассылка по карточке и список адресатов.

Задачи и проблемы устроены одинаково, поэтому маршруты общие и различаются
видом карточки в пути: `/cards/task/{id}` и `/cards/problem/{id}`. Дублировать
один и тот же код дважды ради красивого URL смысла нет.
"""
from __future__ import annotations

import re
import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, Request, UploadFile, status
from sqlalchemy import select

from .. import mail, models, schemas, services
from ..config import settings
from ..deps import AccessibleProject, CurrentUser, DbSession, EditorGuard
from ..realtime import notify

router = APIRouter(prefix="/api/projects/{project_id}", tags=["cards"])

_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")

#: Исполняемые расширения не принимаем: файлы отдаются по прямой ссылке,
#: и превращать хранилище вложений в раздачу скриптов незачем.
BLOCKED_SUFFIXES = {
    ".exe", ".bat", ".cmd", ".com", ".scr", ".msi", ".js", ".jse",
    ".vbs", ".vbe", ".ps1", ".sh", ".jar", ".app", ".dll", ".php",
}

CARD_LABEL = {models.CardKind.task: "Задача", models.CardKind.problem: "Проблема"}


# ------------------------------------------------------------------- helpers
def _card_kind(kind: str) -> models.CardKind:
    try:
        return models.CardKind(kind)
    except ValueError:
        raise HTTPException(status_code=404, detail="Неизвестный вид карточки") from None


def _sector_of_card(db, project_id: int, kind: models.CardKind, card_id: int):  # noqa: ANN001
    """Зона, которой принадлежит карточка, — она же проверка доступа.

    Связь «сектор → задачи/проблемы» живёт в JSON-массивах, поэтому карточка
    ищется перебором зон проекта. Без этой проверки по номеру карточки можно
    было бы дотянуться до чужого проекта.
    """
    field = "task_ids" if kind == models.CardKind.task else "problem_ids"
    for sector in services.sectors_of_project(db, project_id):
        if card_id in services.normalize_ids(getattr(sector, field)):
            return sector
    raise HTTPException(status_code=404, detail="Карточка не найдена в этом проекте")


def _card_row(db, kind: models.CardKind, card_id: int):  # noqa: ANN001
    model = models.Task if kind == models.CardKind.task else models.Problem
    row = db.get(model, card_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Карточка не найдена")
    return row


# --------------------------------------------------------------- вложения
@router.get(
    "/cards/{kind}/{card_id}/attachments",
    response_model=list[schemas.AttachmentOut],
)
def list_attachments(kind: str, card_id: int, project: AccessibleProject, db: DbSession):
    card_kind = _card_kind(kind)
    _sector_of_card(db, project.id, card_kind, card_id)
    return services.attachments_for(db, card_kind, [card_id]).get(card_id, [])


@router.post(
    "/cards/{kind}/{card_id}/attachments",
    response_model=list[schemas.AttachmentOut],
    status_code=status.HTTP_201_CREATED,
    dependencies=[EditorGuard],
)
def upload_attachments(
    request: Request,
    kind: str,
    card_id: int,
    project: AccessibleProject,
    db: DbSession,
    user: CurrentUser,
    files: list[UploadFile] = File(...),  # noqa: B008
):
    """Приложить файлы к задаче или проблеме."""
    card_kind = _card_kind(kind)
    sector = _sector_of_card(db, project.id, card_kind, card_id)

    existing = len(services.attachments_for(db, card_kind, [card_id]).get(card_id, []))
    if existing + len(files) > settings.max_attachments_per_card:
        raise HTTPException(
            status_code=400,
            detail=f"К карточке можно приложить не больше "
            f"{settings.max_attachments_per_card} файлов",
        )

    limit = settings.max_attachment_mb * 1024 * 1024
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit * len(files) + 1024 * 1024:
        raise HTTPException(status_code=413, detail="Файлы слишком большие")

    created: list[models.Attachment] = []
    stored: list[str] = []
    try:
        for upload in files:
            original = Path(upload.filename or "file").name
            suffix = Path(original).suffix.lower()
            if suffix in BLOCKED_SUFFIXES:
                raise HTTPException(
                    status_code=400, detail=f"Файлы {suffix} загружать нельзя"
                )

            stem = _SAFE_NAME.sub("_", Path(original).stem)[:60] or "file"
            stored_name = f"{uuid.uuid4().hex}_{stem}{suffix}"
            target = settings.attachments_dir / stored_name

            written = 0
            with target.open("wb") as out:
                while chunk := upload.file.read(1024 * 1024):
                    written += len(chunk)
                    if written > limit:
                        raise HTTPException(
                            status_code=413,
                            detail=f"Файл «{original}» больше "
                            f"{settings.max_attachment_mb} МБ",
                        )
                    out.write(chunk)
            upload.file.close()
            stored.append(stored_name)

            row = models.Attachment(
                card_kind=card_kind,
                card_id=card_id,
                filename=original[:255],
                stored_name=stored_name,
                content_type=(upload.content_type or "")[:150],
                size_bytes=written,
                uploaded_by=user.id,
            )
            db.add(row)
            created.append(row)

        db.flush()
        summary = services.build_sector_summary(db, sector)
        db.commit()
    except Exception:
        # Записи в БД откатятся сами, а файлы надо убрать руками.
        db.rollback()
        for stored_name in stored:
            services.remove_attachment_file(stored_name)
        raise

    notify(project.id, "sector.updated", summary.model_dump(mode="json"))
    return [services.attachment_out(row) for row in created]


@router.delete(
    "/attachments/{attachment_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[EditorGuard],
)
def delete_attachment(attachment_id: int, project: AccessibleProject, db: DbSession):
    row = db.get(models.Attachment, attachment_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Вложение не найдено")
    sector = _sector_of_card(db, project.id, row.card_kind, row.card_id)

    stored_name = row.stored_name
    db.delete(row)
    db.flush()
    summary = services.build_sector_summary(db, sector)
    db.commit()
    services.remove_attachment_file(stored_name)
    notify(project.id, "sector.updated", summary.model_dump(mode="json"))


# ------------------------------------------------------- адресаты и рассылка
@router.get("/recipients", response_model=list[schemas.NotifyRecipient])
def list_recipients(project: AccessibleProject, db: DbSession):
    """Пользователи с ПОДТВЕРЖДЁННОЙ почтой — только им можно слать письма.

    Список не фильтруется по доступу к проекту сознательно: уведомить о
    проблеме нередко нужно смежника или руководителя, у которого доступа к
    3D-виду нет.
    """
    users = db.scalars(
        select(models.User)
        .where(models.User.email_verified.is_(True), models.User.email.is_not(None))
        .order_by(models.User.username)
    ).all()
    return [
        schemas.NotifyRecipient(id=u.id, username=u.username, email=u.email or "")
        for u in users
    ]


@router.post(
    "/cards/{kind}/{card_id}/notify",
    response_model=schemas.MailReport,
    dependencies=[EditorGuard],
)
def notify_about_card(
    kind: str,
    card_id: int,
    payload: schemas.NotifyRequest,
    project: AccessibleProject,
    db: DbSession,
    user: CurrentUser,
):
    """Разослать письмо о карточке выбранным адресатам."""
    card_kind = _card_kind(kind)
    sector = _sector_of_card(db, project.id, card_kind, card_id)
    card = _card_row(db, card_kind, card_id)

    ids = services.normalize_ids(payload.user_ids)
    if not ids:
        raise HTTPException(status_code=400, detail="Не выбран ни один адресат")

    recipients = db.scalars(
        select(models.User).where(
            models.User.id.in_(ids),
            models.User.email_verified.is_(True),
            models.User.email.is_not(None),
        )
    ).all()
    addresses = [u.email for u in recipients if u.email]
    if not addresses:
        raise HTTPException(
            status_code=400,
            detail="У выбранных пользователей нет подтверждённой почты",
        )

    extra: list[tuple[str, str]] = []
    if card_kind == models.CardKind.task:
        extra.append(("Статус", _status_label(card.status)))
        extra.append(("Выполнено", f"{card.progress} %"))
    else:
        extra.append(("Состояние", "решена" if card.is_resolved else "открыта"))

    files = services.attachments_for(db, card_kind, [card_id]).get(card_id, [])
    if files:
        extra.append(("Вложения", ", ".join(f.filename for f in files)))

    result = mail.send_card_notification(
        recipients=addresses,
        kind_label=CARD_LABEL[card_kind],
        card_name=card.name,
        definition=card.definition,
        project_name=project.name,
        sector_names=[sector.name],
        author=user.username,
        created_at=card.created_at.strftime("%d.%m.%Y %H:%M"),
        extra_rows=extra,
    )
    return schemas.MailReport(
        sent=result.sent, failed=result.failed, skipped=result.skipped, error=result.error
    )


def _status_label(status_value: object) -> str:
    labels = {"todo": "В плане", "in_progress": "В работе", "done": "Готово"}
    key = getattr(status_value, "value", status_value)
    return labels.get(str(key), str(key))
