"""Конфигурация приложения."""
from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="APP_", extra="ignore")

    # Хранилище
    database_url: str = f"sqlite:///{BASE_DIR / 'data.db'}"
    storage_dir: Path = BASE_DIR / "storage"

    # Безопасность
    secret_key: str = "change-me-in-production-please-use-a-long-random-string"
    jwt_algorithm: str = "HS256"
    access_token_ttl_minutes: int = 60 * 12

    # Первичный администратор (создаётся при первом запуске)
    seed_admin_username: str = "admin"
    seed_admin_password: str = "admin123"

    # CORS
    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:4173",
        "http://127.0.0.1:4173",
    ]

    # Загрузка моделей
    max_model_mb: int = 512

    # Вложения задач и проблем
    max_attachment_mb: int = 25
    #: Сколько файлов можно приложить к одной карточке.
    max_attachments_per_card: int = 10

    # ------------------------------------------------------------------ почта
    #: Пароль НЕ хранится в репозитории: задаётся переменной APP_SMTP_PASSWORD.
    #: У Яндекса это «пароль приложения» из Яндекс ID, а не пароль аккаунта —
    #: обычный пароль SMTP отклоняет с ошибкой 535.
    smtp_host: str = "smtp.yandex.ru"
    smtp_port: int = 465
    smtp_use_ssl: bool = True
    #: Поднимать ли STARTTLS на нешифрованном подключении. Выключается только
    #: для внутреннего релея без TLS — наружу так ходить нельзя.
    smtp_use_starttls: bool = True
    smtp_username: str = ""
    smtp_password: str = ""
    #: Адрес в поле «От кого». По умолчанию совпадает с логином.
    smtp_sender: str = ""
    smtp_timeout: int = 20
    #: Внешний адрес интерфейса — из него собираются ссылки в письмах.
    public_base_url: str = "http://localhost:5173"

    # Подтверждение почты
    email_code_ttl_minutes: int = 30
    #: Защита от перебора шестизначного кода.
    email_code_max_attempts: int = 5

    @property
    def models_dir(self) -> Path:
        return self.storage_dir / "models"

    @property
    def attachments_dir(self) -> Path:
        return self.storage_dir / "attachments"

    @property
    def mail_from(self) -> str:
        return self.smtp_sender or self.smtp_username

    @property
    def smtp_configured(self) -> bool:
        """Есть ли чем отправлять почту.

        Без настроек приложение работает как обычно, а письма пишутся в лог:
        разработчику не нужен почтовый сервер, чтобы поднять систему.
        """
        return bool(self.smtp_host and self.smtp_username and self.smtp_password)


settings = Settings()
settings.models_dir.mkdir(parents=True, exist_ok=True)
settings.attachments_dir.mkdir(parents=True, exist_ok=True)
