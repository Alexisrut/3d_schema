/**
 * Тесты объёма зоны (двухэтапная разметка) и математики перетаскивания вершин.
 * Запуск:  node tests/run.mjs
 */
import assert from 'node:assert/strict'

import {
  billboardAnchor,
  buildPolygonGeometry,
  buildPrismGeometry,
  footprintArea,
  prismVolume,
  rayPlaneIntersection,
  type Vec3,
} from '../src/three/geometry'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  ✗ ${name}`)
    console.error(`    ${(error as Error).message}`)
  }
}

function close(actual: number, expected: number, tolerance = 1e-5): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `ожидалось ${expected}, получено ${actual}`,
  )
}

const SQUARE: number[][] = [
  [0, 0, 0],
  [4, 0, 0],
  [4, 0, 4],
  [0, 0, 4],
]

/** Объём замкнутого меша через теорему о расходимости — независимая проверка. */
function meshVolume(positions: Float32Array, indices: number[]): number {
  let total = 0
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3
    const b = indices[i + 1] * 3
    const c = indices[i + 2] * 3
    const ax = positions[a]
    const ay = positions[a + 1]
    const az = positions[a + 2]
    const bx = positions[b]
    const by = positions[b + 1]
    const bz = positions[b + 2]
    const cx = positions[c]
    const cy = positions[c + 1]
    const cz = positions[c + 2]
    total +=
      ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
  }
  return Math.abs(total) / 6
}

/** Суммарная площадь всех треугольников меша. */
function surfaceArea(positions: Float32Array, indices: number[]): number {
  let total = 0
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i] * 3, indices[i + 1] * 3, indices[i + 2] * 3]
    const u = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]]
    const v = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]]
    const cross = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ]
    total += Math.sqrt(cross[0] ** 2 + cross[1] ** 2 + cross[2] ** 2) / 2
  }
  return total
}

console.log('geometry.ts — объём зоны')

test('высота 0 даёт ту же геометрию, что и плоский полигон', () => {
  const flat = buildPolygonGeometry(SQUARE, 0.05)
  const prism = buildPrismGeometry(SQUARE, 0, 0.05)
  assert.deepEqual([...prism.positions], [...flat.positions])
  assert.deepEqual(prism.indices, flat.indices)
})

test('отрицательная и нечисловая высота не создают призму', () => {
  const flat = buildPolygonGeometry(SQUARE, 0.05)
  assert.equal(buildPrismGeometry(SQUARE, -3, 0.05).positions.length, flat.positions.length)
  assert.equal(
    buildPrismGeometry(SQUARE, Number.NaN, 0.05).positions.length,
    flat.positions.length,
  )
})

test('призма содержит вдвое больше вершин, чем основание', () => {
  const prism = buildPrismGeometry(SQUARE, 3, 0)
  assert.equal(prism.positions.length, SQUARE.length * 3 * 2)
  assert.ok(Math.max(...prism.indices) < SQUARE.length * 2)
  assert.ok(Math.min(...prism.indices) >= 0)
})

test('верхняя грань поднята ровно на высоту', () => {
  const height = 3.5
  const prism = buildPrismGeometry(SQUARE, height, 0)
  for (let i = 0; i < SQUARE.length; i += 1) {
    const bottom = prism.positions[i * 3 + 1]
    const top = prism.positions[(SQUARE.length + i) * 3 + 1]
    close(top - bottom, height)
    // Выдавливание строго вертикальное: x и z не меняются.
    close(prism.positions[(SQUARE.length + i) * 3], prism.positions[i * 3])
    close(prism.positions[(SQUARE.length + i) * 3 + 2], prism.positions[i * 3 + 2])
  }
})

test('объём меша совпадает с площадью основания × высота', () => {
  const prism = buildPrismGeometry(SQUARE, 3, 0)
  close(meshVolume(prism.positions, prism.indices), 4 * 4 * 3, 1e-4)
})

test('призма замкнута: площадь = 2 основания + боковины', () => {
  const prism = buildPrismGeometry(SQUARE, 3, 0)
  // 2 * 16 (низ и верх) + 4 стены по 4 * 3
  close(surfaceArea(prism.positions, prism.indices), 2 * 16 + 4 * 12, 1e-4)
})

/** Все грани смотрят наружу? Проверяем через направление от центра тела. */
function outwardFaceCount(positions: Float32Array, indices: number[]): [number, number] {
  let center = [0, 0, 0]
  const vertexCount = positions.length / 3
  for (let i = 0; i < vertexCount; i += 1) {
    center[0] += positions[i * 3] / vertexCount
    center[1] += positions[i * 3 + 1] / vertexCount
    center[2] += positions[i * 3 + 2] / vertexCount
  }
  let outward = 0
  let inward = 0
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i] * 3, indices[i + 1] * 3, indices[i + 2] * 3]
    const u = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]]
    const v = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]]
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const mid = [
      (positions[a] + positions[b] + positions[c]) / 3 - center[0],
      (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3 - center[1],
      (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3 - center[2],
    ]
    if (n[0] * mid[0] + n[1] * mid[1] + n[2] * mid[2] > 0) outward += 1
    else inward += 1
  }
  return [outward, inward]
}

test('все грани призмы смотрят наружу (обход согласован)', () => {
  const prism = buildPrismGeometry(SQUARE, 3, 0)
  const [outward, inward] = outwardFaceCount(prism.positions, prism.indices)
  assert.equal(inward, 0, `внутрь смотрят ${inward} треугольников из ${outward + inward}`)
})

test('обход основания по часовой стрелке тоже даёт наружные нормали', () => {
  // Тот же квадрат, обойденный в обратную сторону: у пользователя порядок
  // кликов произвольный, и от него не должно зависеть освещение зоны.
  const prism = buildPrismGeometry([...SQUARE].reverse(), 3, 0)
  const [outward, inward] = outwardFaceCount(prism.positions, prism.indices)
  assert.equal(inward, 0, `внутрь смотрят ${inward} треугольников из ${outward + inward}`)
})

test('объём не зависит от направления обхода основания', () => {
  const forward = buildPrismGeometry(SQUARE, 3, 0)
  const backward = buildPrismGeometry([...SQUARE].reverse(), 3, 0)
  close(meshVolume(forward.positions, forward.indices), 48, 1e-4)
  close(meshVolume(backward.positions, backward.indices), 48, 1e-4)
})

test('невыпуклое основание выдавливается без потери объёма', () => {
  const lShape: number[][] = [
    [0, 0, 0],
    [3, 0, 0],
    [3, 0, 1],
    [1, 0, 1],
    [1, 0, 3],
    [0, 0, 3],
  ]
  const prism = buildPrismGeometry(lShape, 2, 0)
  close(meshVolume(prism.positions, prism.indices), footprintArea(lShape) * 2, 1e-4)
})

test('площадь основания — проекция на XZ, а не наклонная площадь', () => {
  close(footprintArea(SQUARE), 16)
  // Квадрат 2×2, наклонённый на 45°: наклонная площадь 4, проекция — меньше.
  const tilted: number[][] = [
    [0, 0, 0],
    [2, 0, 0],
    [2, Math.SQRT2, Math.SQRT2],
    [0, Math.SQRT2, Math.SQRT2],
  ]
  close(footprintArea(tilted), 2 * Math.SQRT2)
})

test('объём зоны', () => {
  close(prismVolume(SQUARE, 3), 48)
  assert.equal(prismVolume(SQUARE, 0), 0)
  assert.equal(prismVolume(SQUARE, -5), 0)
  assert.equal(prismVolume([[0, 0, 0]], 3), 0)
})

test('виджет зоны с объёмом висит над её верхней гранью', () => {
  const flat = billboardAnchor(SQUARE, 2, 0)
  const tall = billboardAnchor(SQUARE, 2, 6)
  close(flat[1], 2)
  close(tall[1], 8)
  // Смещения по горизонтали нет — виджет строго над центром.
  close(tall[0], flat[0])
  close(tall[2], flat[2])
})

console.log('\ngeometry.ts — перетаскивание вершин')

test('луч сверху вниз попадает в горизонтальную плоскость', () => {
  const hit = rayPlaneIntersection([1, 10, 2], [0, -1, 0], [0, 0, 0], [0, 1, 0])
  assert.ok(hit)
  close(hit![0], 1)
  close(hit![1], 0)
  close(hit![2], 2)
})

test('наклонный луч попадает в ожидаемую точку', () => {
  const direction: Vec3 = [1, -1, 0]
  const hit = rayPlaneIntersection([0, 5, 0], direction, [0, 0, 0], [0, 1, 0])
  assert.ok(hit)
  close(hit![0], 5)
  close(hit![1], 0)
})

test('плоскость смещена по высоте — попадание на её уровне', () => {
  const hit = rayPlaneIntersection([0, 10, 0], [0, -1, 0], [0, 3.5, 0], [0, 1, 0])
  assert.ok(hit)
  close(hit![1], 3.5)
})

test('луч, параллельный плоскости, не даёт попадания', () => {
  assert.equal(rayPlaneIntersection([0, 5, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0]), null)
})

test('плоскость за спиной — попадания нет', () => {
  // Камера смотрит вверх, плоскость под ней: вершина не должна «телепортироваться».
  assert.equal(rayPlaneIntersection([0, 5, 0], [0, 1, 0], [0, 0, 0], [0, 1, 0]), null)
})

test('вертикальная плоскость (зона на стене) тоже пересекается', () => {
  const hit = rayPlaneIntersection([0, 1, 10], [0, 0, -1], [0, 0, 0], [0, 0, 1])
  assert.ok(hit)
  close(hit![2], 0)
  close(hit![1], 1)
})

test('ненормированная нормаль плоскости не искажает результат', () => {
  const hit = rayPlaneIntersection([1, 10, 2], [0, -1, 0], [0, 4, 0], [0, 25, 0])
  assert.ok(hit)
  close(hit![1], 4)
})

console.log(`\nПройдено: ${passed}, провалено: ${failed}`)
if (failed > 0) process.exit(1)
