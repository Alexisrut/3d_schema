#!/usr/bin/env python3
"""Генератор демонстрационной .glb-модели здания — только стандартная библиотека.

Нужен, чтобы систему можно было посмотреть до того, как из Revit выгрузят
настоящую модель. Реальный файл заказчика загружается через интерфейс
администратора и полностью заменяет эту заглушку.

Запуск:  python tools/make_demo_model.py storage/models/demo_building.glb
"""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

# --------------------------------------------------------------------- геометрия
# Единичный куб с центром в начале координат: 24 вершины (по 4 на грань),
# чтобы у каждой грани была собственная нормаль, и 36 индексов.
_FACES = [
    # (нормаль, четыре вершины против часовой стрелки при взгляде снаружи)
    ((0, 0, 1), [(-0.5, -0.5, 0.5), (0.5, -0.5, 0.5), (0.5, 0.5, 0.5), (-0.5, 0.5, 0.5)]),
    ((0, 0, -1), [(0.5, -0.5, -0.5), (-0.5, -0.5, -0.5), (-0.5, 0.5, -0.5), (0.5, 0.5, -0.5)]),
    ((1, 0, 0), [(0.5, -0.5, 0.5), (0.5, -0.5, -0.5), (0.5, 0.5, -0.5), (0.5, 0.5, 0.5)]),
    ((-1, 0, 0), [(-0.5, -0.5, -0.5), (-0.5, -0.5, 0.5), (-0.5, 0.5, 0.5), (-0.5, 0.5, -0.5)]),
    ((0, 1, 0), [(-0.5, 0.5, 0.5), (0.5, 0.5, 0.5), (0.5, 0.5, -0.5), (-0.5, 0.5, -0.5)]),
    ((0, -1, 0), [(-0.5, -0.5, -0.5), (0.5, -0.5, -0.5), (0.5, -0.5, 0.5), (-0.5, -0.5, 0.5)]),
]


def _unit_cube() -> tuple[list[float], list[float], list[int]]:
    positions: list[float] = []
    normals: list[float] = []
    indices: list[int] = []
    for face_index, (normal, verts) in enumerate(_FACES):
        base = face_index * 4
        for vx, vy, vz in verts:
            positions.extend((vx, vy, vz))
            normals.extend(normal)
        indices.extend((base, base + 1, base + 2, base, base + 2, base + 3))
    return positions, normals, indices


# ---------------------------------------------------------------------- материалы
MATERIALS = [
    {"name": "Concrete", "pbrMetallicRoughness": {
        "baseColorFactor": [0.72, 0.72, 0.70, 1.0], "metallicFactor": 0.0, "roughnessFactor": 0.9}},
    {"name": "Slab", "pbrMetallicRoughness": {
        "baseColorFactor": [0.62, 0.63, 0.66, 1.0], "metallicFactor": 0.0, "roughnessFactor": 0.85}},
    {"name": "Column", "pbrMetallicRoughness": {
        "baseColorFactor": [0.55, 0.56, 0.60, 1.0], "metallicFactor": 0.1, "roughnessFactor": 0.7}},
    {"name": "Ground", "pbrMetallicRoughness": {
        "baseColorFactor": [0.35, 0.37, 0.34, 1.0], "metallicFactor": 0.0, "roughnessFactor": 1.0}},
]


def build_nodes() -> list[dict]:
    """Каркас: земля + 4 этажа (перекрытие, колонны, две стены)."""
    nodes: list[dict] = []

    def box(name: str, material: int, center, size) -> None:
        nodes.append({
            "name": name,
            "mesh": material,          # меши 1:1 соответствуют материалам
            "translation": [float(center[0]), float(center[1]), float(center[2])],
            "scale": [float(size[0]), float(size[1]), float(size[2])],
        })

    width, depth = 24.0, 16.0
    floor_h = 3.6
    floors = 4

    box("Ground", 3, (0, -0.25, 0), (60, 0.5, 60))

    for level in range(floors):
        y_slab = level * floor_h
        box(f"Slab_L{level + 1}", 1, (0, y_slab, 0), (width, 0.35, depth))

        for sx in (-1, 0, 1):
            for sz in (-1, 1):
                cx = sx * (width / 2 - 1.5)
                cz = sz * (depth / 2 - 1.5)
                box(
                    f"Column_L{level + 1}_{sx}_{sz}",
                    2,
                    (cx, y_slab + floor_h / 2, cz),
                    (0.6, floor_h, 0.6),
                )

        # Две несущие стены — чтобы модель не выглядела «прозрачной»
        box(f"Wall_L{level + 1}_N", 0, (0, y_slab + floor_h / 2, -depth / 2 + 0.15),
            (width, floor_h - 0.4, 0.3))
        box(f"Wall_L{level + 1}_W", 0, (-width / 2 + 0.15, y_slab + floor_h / 2, 0),
            (0.3, floor_h - 0.4, depth))

    # Кровля
    box("Roof", 1, (0, floors * floor_h, 0), (width, 0.35, depth))
    return nodes


def build_glb() -> bytes:
    positions, normals, indices = _unit_cube()

    pos_bytes = struct.pack(f"<{len(positions)}f", *positions)
    nrm_bytes = struct.pack(f"<{len(normals)}f", *normals)
    idx_bytes = struct.pack(f"<{len(indices)}H", *indices)

    def pad4(data: bytes, filler: bytes = b"\x00") -> bytes:
        remainder = len(data) % 4
        return data if remainder == 0 else data + filler * (4 - remainder)

    pos_bytes = pad4(pos_bytes)
    nrm_bytes = pad4(nrm_bytes)
    idx_bytes = pad4(idx_bytes)

    bin_blob = pos_bytes + nrm_bytes + idx_bytes

    nodes = build_nodes()

    gltf = {
        "asset": {"version": "2.0", "generator": "3d-monitoring demo generator"},
        "scene": 0,
        "scenes": [{"name": "Building", "nodes": list(range(len(nodes)))}],
        "nodes": nodes,
        "meshes": [
            {
                "name": material["name"],
                "primitives": [
                    {
                        "attributes": {"POSITION": 0, "NORMAL": 1},
                        "indices": 2,
                        "material": material_index,
                        "mode": 4,
                    }
                ],
            }
            for material_index, material in enumerate(MATERIALS)
        ],
        "materials": MATERIALS,
        "buffers": [{"byteLength": len(bin_blob)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(pos_bytes), "target": 34962},
            {"buffer": 0, "byteOffset": len(pos_bytes), "byteLength": len(nrm_bytes),
             "target": 34962},
            {"buffer": 0, "byteOffset": len(pos_bytes) + len(nrm_bytes),
             "byteLength": len(idx_bytes), "target": 34963},
        ],
        "accessors": [
            {
                "bufferView": 0, "componentType": 5126, "count": len(positions) // 3,
                "type": "VEC3", "min": [-0.5, -0.5, -0.5], "max": [0.5, 0.5, 0.5],
            },
            {
                "bufferView": 1, "componentType": 5126, "count": len(normals) // 3,
                "type": "VEC3",
            },
            {
                "bufferView": 2, "componentType": 5123, "count": len(indices),
                "type": "SCALAR",
            },
        ],
    }

    json_blob = pad4(json.dumps(gltf, separators=(",", ":")).encode("utf-8"), b" ")

    total = 12 + 8 + len(json_blob) + 8 + len(bin_blob)
    out = bytearray()
    out += struct.pack("<III", 0x46546C67, 2, total)          # 'glTF', версия 2
    out += struct.pack("<II", len(json_blob), 0x4E4F534A)     # чанк JSON
    out += json_blob
    out += struct.pack("<II", len(bin_blob), 0x004E4942)      # чанк BIN
    out += bin_blob
    return bytes(out)


def main() -> int:
    target = Path(sys.argv[1] if len(sys.argv) > 1 else "storage/models/demo_building.glb")
    target.parent.mkdir(parents=True, exist_ok=True)
    data = build_glb()
    target.write_bytes(data)
    print(f"Готово: {target} ({len(data) / 1024:.1f} КБ)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
