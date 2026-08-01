# Бэкенд: FastAPI + uvicorn.
#
# Версия Python зафиксирована той же, на которой проект разрабатывался (3.12):
# bcrypt и pydantic собираются под конкретный ABI, и «просто свежий» Python
# однажды сломает сборку в самый неподходящий момент.
FROM python:3.12-slim

# PYTHONDONTWRITEBYTECODE — не мусорить .pyc в примонтированном томе.
# PYTHONUNBUFFERED — чтобы логи uvicorn попадали в `docker logs` сразу, а не
# после заполнения буфера: без этого «сервер молчит» при отладке.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Зависимости ставятся отдельным слоем и раньше кода: пересборка после правки
# исходников тогда не тянет заново весь pip.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY seed.py ./

# Приложение работает не от root: пробой в веб-сервисе не должен давать
# полный доступ к контейнеру. UID 10001 фиксирован — по нему выдаются права
# на каталог данных на хосте (см. DEPLOY.md, шаг «Каталог данных»).
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin appuser
USER appuser

EXPOSE 8000

# Порт наружу не публикуется: контейнер доступен только nginx'у по внутренней
# сети compose. Один воркер — осознанно: база SQLite, и несколько процессов
# на запись дали бы «database is locked» (см. DEPLOY.md, раздел про нагрузку).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
