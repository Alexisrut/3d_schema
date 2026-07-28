#!/usr/bin/env python3
"""Проверка структуры .glb: заголовок, чанки, выравнивание, границы аксессоров.

Не заменяет полноценный glTF-валидатор, но ловит ошибки, из-за которых
three.js/GLTFLoader падает при загрузке.
"""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

COMPONENT_SIZE = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
TYPE_COUNT = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}


def validate(path: Path) -> list[str]:
    errors: list[str] = []
    raw = path.read_bytes()

    if len(raw) < 12:
        return ["файл короче заголовка GLB"]

    magic, version, total = struct.unpack_from("<III", raw, 0)
    if magic != 0x46546C67:
        errors.append("неверная сигнатура (ожидалось 'glTF')")
    if version != 2:
        errors.append(f"версия контейнера {version}, ожидалась 2")
    if total != len(raw):
        errors.append(f"в заголовке длина {total}, фактически {len(raw)}")

    offset = 12
    json_blob: bytes | None = None
    bin_blob = b""
    while offset + 8 <= len(raw):
        chunk_len, chunk_type = struct.unpack_from("<II", raw, offset)
        offset += 8
        if chunk_len % 4 != 0:
            errors.append(f"длина чанка {chunk_len} не кратна 4")
        chunk = raw[offset : offset + chunk_len]
        if len(chunk) != chunk_len:
            errors.append("чанк обрезан")
            break
        if chunk_type == 0x4E4F534A:
            json_blob = chunk
        elif chunk_type == 0x004E4942:
            bin_blob = chunk
        offset += chunk_len

    if json_blob is None:
        return [*errors, "не найден JSON-чанк"]

    try:
        gltf = json.loads(json_blob.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        return [*errors, f"JSON-чанк не разбирается: {exc}"]

    if gltf.get("asset", {}).get("version") != "2.0":
        errors.append("asset.version должен быть '2.0'")

    buffers = gltf.get("buffers", [])
    if buffers and buffers[0].get("byteLength", 0) > len(bin_blob):
        errors.append("buffers[0].byteLength больше фактического BIN-чанка")

    views = gltf.get("bufferViews", [])
    for i, view in enumerate(views):
        end = view.get("byteOffset", 0) + view["byteLength"]
        if end > len(bin_blob):
            errors.append(f"bufferView[{i}] выходит за пределы буфера ({end} > {len(bin_blob)})")

    for i, acc in enumerate(gltf.get("accessors", [])):
        comp = COMPONENT_SIZE.get(acc["componentType"])
        if comp is None:
            errors.append(f"accessor[{i}]: неизвестный componentType")
            continue
        stride = comp * TYPE_COUNT[acc["type"]]
        view = views[acc["bufferView"]]
        needed = acc.get("byteOffset", 0) + acc["count"] * stride
        if needed > view["byteLength"]:
            errors.append(
                f"accessor[{i}] требует {needed} Б, а bufferView даёт {view['byteLength']} Б"
            )
        base = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
        if base % comp != 0:
            errors.append(f"accessor[{i}]: смещение {base} не выровнено по {comp}")
        if acc["type"] == "VEC3" and acc.get("bufferView") == 0 and "min" not in acc:
            errors.append(f"accessor[{i}]: у POSITION обязательны min/max")

    node_count = len(gltf.get("nodes", []))
    mesh_count = len(gltf.get("meshes", []))
    mat_count = len(gltf.get("materials", []))
    for i, node in enumerate(gltf.get("nodes", [])):
        if "mesh" in node and not (0 <= node["mesh"] < mesh_count):
            errors.append(f"node[{i}] ссылается на несуществующий меш")
    for i, mesh in enumerate(gltf.get("meshes", [])):
        for prim in mesh.get("primitives", []):
            if "material" in prim and not (0 <= prim["material"] < mat_count):
                errors.append(f"mesh[{i}]: неверный индекс материала")
    for scene in gltf.get("scenes", []):
        for n in scene.get("nodes", []):
            if not (0 <= n < node_count):
                errors.append("scene ссылается на несуществующий узел")

    if not errors:
        print(
            f"OK: {path.name} — узлов {node_count}, мешей {mesh_count}, "
            f"материалов {mat_count}, BIN {len(bin_blob)} Б"
        )
    return errors


def main() -> int:
    if len(sys.argv) < 2:
        print("использование: validate_glb.py <файл.glb>", file=sys.stderr)
        return 2
    problems = validate(Path(sys.argv[1]))
    for p in problems:
        print(f"ОШИБКА: {p}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
