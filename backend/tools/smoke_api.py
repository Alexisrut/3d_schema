#!/usr/bin/env python3
"""Сквозная проверка API по HTTP против запущенного сервера.

Покрывает то, что нельзя проверить юнит-тестами без поднятого приложения:
слои моделей, объём зоны, несколько бригад на секторе, массовые действия и
запрет записи для роли «Читатель».

Запуск (сервер должен быть уже поднят, база — заполнена seed.py):

    python tools/smoke_api.py                      # http://127.0.0.1:8000
    python tools/smoke_api.py --base http://host:port

Скрипт создаёт и удаляет собственные объекты и рассчитан на повторные
запуски: имена уникальны, чужие данные не трогаются. TestClient из FastAPI
не используется намеренно — он тянет httpx, которого нет в requirements.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
MODELS_DIR = BASE_DIR / "storage" / "models"
#: Метка запуска — попадает в имена, чтобы повторный прогон ничего не путал.
RUN = uuid.uuid4().hex[:6]

failed = 0
passed = 0


def request(method, path, token=None, body=None, expect=200, base=""):
    global failed, passed
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            status, raw = resp.status, resp.read()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read()
    if status == expect:
        passed += 1
    else:
        failed += 1
        print(f"  ✗ {method} {path} -> {status}, ожидалось {expect}: {raw[:200]!r}")
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return raw


def upload(path, token, filename, content, base, expect=201):
    """multipart/form-data вручную — без внешних зависимостей."""
    global failed, passed
    boundary = f"----{uuid.uuid4().hex}"
    body = b"".join([
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'.encode(),
        b"Content-Type: application/octet-stream\r\n\r\n",
        content,
        f"\r\n--{boundary}--\r\n".encode(),
    ])
    req = urllib.request.Request(
        base + path,
        data=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            status, raw = resp.status, resp.read()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read()
    if status == expect:
        passed += 1
    else:
        failed += 1
        print(f"  ✗ upload {filename} -> {status}, ожидалось {expect}: {raw[:200]!r}")
    return json.loads(raw) if raw else None


def check(label, condition, detail=""):
    global failed, passed
    if condition:
        passed += 1
        print(f"  ✓ {label}")
    else:
        failed += 1
        print(f"  ✗ {label} {detail}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:8000", help="адрес сервера")
    args = parser.parse_args()
    base = args.base.rstrip("/")

    def call(method, path, token=None, body=None, expect=200):
        return request(method, path, token, body, expect, base)

    print(f"Сервер: {base}\n")

    print("Авторизация и роли")
    admin = call("POST", "/api/auth/login", body={"username": "admin", "password": "admin123"})
    if not admin:
        print("Не удалось войти администратором — сервер поднят? база заполнена seed.py?")
        return 1
    atok = admin["access_token"]

    # Читатель может отсутствовать (база заполнена старым seed.py) — тогда
    # его раздел просто пропускается, а не роняет всю проверку.
    reader = call("POST", "/api/auth/login",
                  body={"username": "inspector", "password": "inspector123"})
    rtok = reader.get("access_token") if isinstance(reader, dict) else None
    if rtok:
        check("роль читателя — reader", reader["user"]["role"] == "reader")
    else:
        print("  — раздел «Читатель» пропущен: нет пользователя inspector")

    pid = call("GET", "/api/projects", token=atok)[0]["id"]

    print("\nСлепок проекта")
    snap = call("GET", f"/api/projects/{pid}/snapshot", token=atok)
    check("в слепке есть список слоёв", isinstance(snap.get("models"), list))
    check("у зоны список бригад", all(isinstance(s.get("brigades"), list) for s in snap["sectors"]))
    check("у зоны есть height", all("height" in s for s in snap["sectors"]))

    print("\nЗона с объёмом")
    zone = call("POST", f"/api/projects/{pid}/sectors", token=atok, expect=201,
                body={"name": f"Проверка {RUN}",
                      "coordinates": [[0, 0, 0], [4, 0, 0], [4, 0, 4], [0, 0, 4]],
                      "height": 3.5})
    sid = zone["id"]
    check("высота сохранена", zone["height"] == 3.5, zone["height"])
    call("POST", f"/api/projects/{pid}/sectors", token=atok, expect=422,
         body={"name": "перебор", "coordinates": [[0, 0, 0], [1, 0, 0], [1, 0, 1]],
               "height": 100000})
    call("POST", f"/api/projects/{pid}/sectors", token=atok, expect=400,
         body={"name": "мало точек", "coordinates": [[0, 0, 0], [1, 0, 0]]})

    print("\nНесколько бригад на одной зоне")
    brigades = call("GET", f"/api/projects/{pid}/brigades", token=atok)
    b1, b2 = brigades[0]["id"], brigades[1]["id"]
    call("POST", f"/api/projects/{pid}/sectors/{sid}/brigades", token=atok, expect=201,
         body={"brigade_id": b1})
    two = call("POST", f"/api/projects/{pid}/sectors/{sid}/brigades", token=atok, expect=201,
               body={"brigade_id": b2})
    check("на зоне две бригады", [b["id"] for b in two["brigades"]] == [b1, b2])
    same = call("POST", f"/api/projects/{pid}/sectors/{sid}/brigades", token=atok, expect=201,
                body={"brigade_id": b1})
    check("повторное добавление не дублирует", len(same["brigades"]) == 2)
    one = call("DELETE", f"/api/projects/{pid}/sectors/{sid}/brigades/{b1}", token=atok)
    check("снятие одной не трогает вторую", [b["id"] for b in one["brigades"]] == [b2])
    call("PUT", f"/api/projects/{pid}/sectors/{sid}/brigades", token=atok,
         body={"brigade_ids": [999999]}, expect=404)

    print("\nМассовые действия")
    zone2 = call("POST", f"/api/projects/{pid}/sectors", token=atok, expect=201,
                 body={"name": f"Проверка-2 {RUN}",
                       "coordinates": [[9, 0, 9], [12, 0, 9], [12, 0, 12]], "height": 0})
    targets = [sid, zone2["id"]]
    task_name = f"Массовая задача {RUN}"
    bulk = call("POST", f"/api/projects/{pid}/sectors/bulk/tasks", token=atok, expect=201,
                body={"sector_ids": targets,
                      "task": {"name": task_name, "definition": "", "status": "todo",
                               "progress": 0}})
    check("задача заведена в обеих зонах", len(bulk["sectors"]) == 2)
    ids = [t["id"] for s in bulk["sectors"] for t in s["tasks"] if t["name"] == task_name]
    # Ключевое: в каждой зоне СВОЯ запись задачи, иначе отметка «готово»
    # в одной зоне закрывала бы работу во всех остальных.
    check("в каждой зоне своя запись задачи", len(ids) == len(set(ids)) == 2, ids)

    call("POST", f"/api/projects/{pid}/sectors/bulk/problems", token=atok, expect=201,
         body={"sector_ids": targets,
               "problem": {"name": f"Проблема {RUN}", "definition": "", "is_resolved": False}})
    call("POST", f"/api/projects/{pid}/sectors/bulk/tasks", token=atok, expect=404,
         body={"sector_ids": [999999],
               "task": {"name": "x", "definition": "", "status": "todo", "progress": 0}})
    call("POST", f"/api/projects/{pid}/sectors/bulk/tasks", token=atok, expect=422,
         body={"sector_ids": [],
               "task": {"name": "x", "definition": "", "status": "todo", "progress": 0}})

    print("\nСлои моделей")
    demo = MODELS_DIR / "demo_building.glb"
    if demo.exists():
        content = demo.read_bytes()
        before = call("GET", f"/api/projects/{pid}/models", token=atok)
        layer = upload(f"/api/projects/{pid}/models", atok, f"Слой {RUN}.glb", content, base)
        after = call("GET", f"/api/projects/{pid}/models", token=atok)
        check("слой добавлен, прежние на месте", len(after) == len(before) + 1)
        check("имя слоя из имени файла", layer["name"] == f"Слой {RUN}", layer["name"])
        upload(f"/api/projects/{pid}/models", atok, "не-модель.txt", b"hello", base, expect=400)
        upload(f"/api/projects/{pid}/models", atok, "подделка.glb", b"NOT GLTF", base, expect=400)
        if rtok:
            upload(f"/api/projects/{pid}/models", rtok, "нельзя.glb", content, base, expect=403)
        call("DELETE", f"/api/projects/{pid}/models/{layer['id']}", token=atok, expect=204)
        call("DELETE", f"/api/projects/{pid}/models/{layer['id']}", token=atok, expect=404)
    else:
        print(f"  — пропущено: нет {demo}")

    if rtok:
        print("\nРоль «Читатель» не может изменять данные")
        check("читатель видит слепок",
              call("GET", f"/api/projects/{pid}/snapshot", token=rtok) is not None)
        call("POST", f"/api/projects/{pid}/sectors", token=rtok, expect=403,
             body={"name": "нельзя", "coordinates": [[0, 0, 0], [1, 0, 0], [1, 0, 1]]})
        call("PATCH", f"/api/projects/{pid}/sectors/{sid}", token=rtok, expect=403,
             body={"name": "нельзя"})
        call("DELETE", f"/api/projects/{pid}/sectors/{sid}", token=rtok, expect=403)
        call("POST", f"/api/projects/{pid}/brigades", token=rtok, expect=403,
             body={"name": "нельзя", "brigadir": "", "cnt_people": 1})
        call("POST", f"/api/projects/{pid}/sectors/bulk/delete", token=rtok, expect=403,
             body={"sector_ids": [sid]})

    print("\nМассовое удаление (заодно уборка за собой)")
    res = call("POST", f"/api/projects/{pid}/sectors/bulk/delete", token=atok,
               body={"sector_ids": targets})
    check("удалены обе зоны", sorted(res["deleted_ids"]) == sorted(targets), res)
    call("GET", f"/api/projects/{pid}/sectors/{sid}", token=atok, expect=404)

    print(f"\nПройдено: {passed}, провалено: {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
