"""Отправка почты: подтверждение адреса и уведомления по карточкам.

Отправка синхронная и выполняется в отдельном потоке (роутеры синхронные,
FastAPI и так держит их в threadpool). Очередь и повторы не заводятся
сознательно: письмо здесь — уведомление, а не транзакция, и терять его
допустимо; ронять из-за него запрос — нет.

Если SMTP не настроен, письма пишутся в лог. Так систему можно поднять и
проверить без почтового сервера, а вызывающий код не обрастает ветками.
"""
from __future__ import annotations

import logging
import smtplib
import ssl
from dataclasses import dataclass, field
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

from .config import settings

log = logging.getLogger("mail")


@dataclass
class MailResult:
    """Чем закончилась отправка — попадает в ответ API."""

    sent: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)
    #: SMTP не настроен: письмо только записано в лог.
    skipped: bool = False
    error: str | None = None

    @property
    def ok(self) -> bool:
        return not self.failed and self.error is None


def _build(subject: str, to: list[str], text: str, html: str | None = None) -> EmailMessage:
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = settings.mail_from
    message["To"] = ", ".join(to)
    # Date и Message-ID обязательны по RFC 5322. smtplib их не добавляет, а
    # письмо без них спам-фильтры считают отправленным ботом.
    message["Date"] = formatdate(localtime=True)
    message["Message-ID"] = make_msgid(domain=_sender_domain())
    message.set_content(text)
    if html:
        message.add_alternative(html, subtype="html")
    return message


def _sender_domain() -> str:
    """Домен отправителя для Message-ID; по умолчанию — localhost."""
    _, _, domain = settings.mail_from.partition("@")
    return domain or "localhost"


def send_mail(subject: str, to: list[str], text: str, html: str | None = None) -> MailResult:
    """Отправить письмо списку адресатов.

    Возвращает результат, а не бросает исключение: интерфейс должен сообщить
    «задача создана, но письмо не ушло», а не потерять саму задачу.
    """
    recipients = [address.strip() for address in to if address and address.strip()]
    if not recipients:
        return MailResult(skipped=True)

    if not settings.smtp_configured:
        log.warning(
            "SMTP не настроен — письмо не отправлено.\n  Кому: %s\n  Тема: %s\n%s",
            ", ".join(recipients),
            subject,
            text,
        )
        return MailResult(skipped=True, error="Почта не настроена (APP_SMTP_*)")

    message = _build(subject, recipients, text, html)
    context = ssl.create_default_context()
    try:
        if settings.smtp_use_ssl:
            server = smtplib.SMTP_SSL(
                settings.smtp_host, settings.smtp_port,
                context=context, timeout=settings.smtp_timeout,
            )
        else:
            server = smtplib.SMTP(
                settings.smtp_host, settings.smtp_port, timeout=settings.smtp_timeout
            )
        with server:
            if not settings.smtp_use_ssl and settings.smtp_use_starttls:
                server.starttls(context=context)
            server.login(settings.smtp_username, settings.smtp_password)
            # send_message возвращает только отказы по конкретным адресам;
            # остальные считаются принятыми сервером.
            refused = server.send_message(message)
        failed = list(refused.keys())
        return MailResult(
            sent=[r for r in recipients if r not in failed],
            failed=failed,
        )
    except smtplib.SMTPAuthenticationError as exc:
        # Самая частая причина: у Яндекса нужен «пароль приложения», а не
        # пароль аккаунта. Пишем это прямо, иначе диагностика занимает часы.
        log.error("SMTP: аутентификация отклонена (%s)", exc)
        return MailResult(
            failed=recipients,
            error="Почтовый сервер отклонил логин или пароль. "
            "Для Яндекса нужен пароль приложения из Яндекс ID.",
        )
    except smtplib.SMTPDataError as exc:
        # 554 после успешного логина — письмо приняли к рассмотрению и
        # отклонили. У Яндекса это обычно значит, что ящику ещё не разрешена
        # отправка на внешние домены (нет подтверждённого телефона, нет
        # истории отправки). Пишем прямо, иначе диагностика уходит в догадки.
        detail = exc.smtp_error.decode("utf-8", "replace")
        log.error("SMTP: сервер отклонил письмо (%s %s)", exc.smtp_code, detail)
        hint = (
            " Почтовый сервер счёл письмо спамом: у ящика может быть не открыта "
            "отправка на внешние адреса."
            if "SPAM" in detail.upper()
            else ""
        )
        return MailResult(
            failed=recipients, error=f"Письмо отклонено сервером ({exc.smtp_code}).{hint}"
        )
    except (OSError, smtplib.SMTPException) as exc:
        log.error("SMTP: отправка не удалась (%s: %s)", type(exc).__name__, exc)
        return MailResult(failed=recipients, error=f"Почта недоступна: {exc}")


# ------------------------------------------------------------------- шаблоны
def send_verification_code(email: str, username: str, code: str) -> MailResult:
    minutes = settings.email_code_ttl_minutes
    text = (
        f"Здравствуйте, {username}!\n\n"
        f"Код подтверждения почты в системе 3D-мониторинга строительства:\n\n"
        f"    {code}\n\n"
        f"Код действует {minutes} мин. Если вы не запрашивали привязку почты, "
        f"просто проигнорируйте это письмо.\n"
    )
    html = (
        f"<p>Здравствуйте, {_escape(username)}!</p>"
        f"<p>Код подтверждения почты в системе 3D-мониторинга строительства:</p>"
        f'<p style="font-size:24px;letter-spacing:4px;'
        f'font-family:monospace"><b>{code}</b></p>'
        f"<p>Код действует {minutes} мин. Если вы не запрашивали привязку почты, "
        f"просто проигнорируйте это письмо.</p>"
    )
    return send_mail("Код подтверждения почты — 3D-мониторинг", [email], text, html)


def send_card_notification(
    *,
    recipients: list[str],
    kind_label: str,
    card_name: str,
    definition: str,
    project_name: str,
    sector_names: list[str],
    author: str,
    created_at: str,
    extra_rows: list[tuple[str, str]] | None = None,
) -> MailResult:
    """Письмо о заведённой задаче или проблеме — со всеми данными карточки."""
    rows: list[tuple[str, str]] = [
        ("Объект", project_name),
        ("Зоны", ", ".join(sector_names) or "—"),
        ("Автор", author),
        ("Создано", created_at),
        *(extra_rows or []),
    ]

    lines = [f"{kind_label}: {card_name}", ""]
    lines += [f"{label}: {value}" for label, value in rows]
    if definition:
        lines += ["", "Описание:", definition]
    text = "\n".join(lines) + "\n"

    html_rows = "".join(
        f'<tr><td style="padding:4px 12px 4px 0;color:#666">{_escape(label)}</td>'
        f"<td style=\"padding:4px 0\">{_escape(value)}</td></tr>"
        for label, value in rows
    )
    html = (
        f"<h2 style=\"margin:0 0 12px\">{_escape(kind_label)}: {_escape(card_name)}</h2>"
        f'<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">'
        f"{html_rows}</table>"
        + (
            f'<p style="font-family:sans-serif;font-size:14px"><b>Описание:</b><br>'
            f"{_escape(definition)}</p>"
            if definition
            else ""
        )
    )
    return send_mail(f"{kind_label}: {card_name}", recipients, text, html)


def _escape(value: str) -> str:
    """Минимальное экранирование: имена зон и описания вводит пользователь."""
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )
