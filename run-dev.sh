#!/usr/bin/env bash
# Поднимает бэкенд и фронтенд одной командой (для разработки).
# Первый запуск: создаёт venv, ставит зависимости, генерирует демо-модель и сид.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [ ! -d backend/.venv ]; then
  echo "→ Создаю виртуальное окружение…"
  python3 -m venv backend/.venv
  backend/.venv/bin/pip install --upgrade pip
  backend/.venv/bin/pip install -r backend/requirements.txt
fi

if [ ! -f backend/data.db ]; then
  echo "→ Готовлю демо-данные…"
  (cd backend && .venv/bin/python tools/make_demo_model.py storage/models/demo_building.glb)
  (cd backend && .venv/bin/python seed.py)
fi

if [ ! -d frontend/node_modules ]; then
  echo "→ Ставлю зависимости фронтенда…"
  (cd frontend && npm install)
fi

echo "→ Запускаю бэкенд на :8000 и фронтенд на :5173"
(cd backend && .venv/bin/uvicorn app.main:app --reload --port 8000) &
BACKEND_PID=$!
trap 'kill $BACKEND_PID 2>/dev/null || true' EXIT INT TERM

cd frontend && npm run dev
