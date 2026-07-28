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

    @property
    def models_dir(self) -> Path:
        return self.storage_dir / "models"


settings = Settings()
settings.models_dir.mkdir(parents=True, exist_ok=True)
