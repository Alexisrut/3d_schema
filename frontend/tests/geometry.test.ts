/**
 * Тесты геометрии разметки зон.
 * Запуск:  npx tsx tests/geometry.test.ts
 */
import assert from 'node:assert/strict'

import {
  buildPolygonGeometry,
  billboardAnchor,
  centroid,
  polygonArea3D,
  polygonNormal,
  signedArea,
  triangulate2D,
  type Vec2,
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

function close(actual: number, expected: number, tolerance = 1e-6): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `ожидалось ${expected}, получено ${actual}`,
  )
}

/** Проверка, что треугольники покрывают полигон целиком и без дублей площади. */
function triangulatedArea(points: Vec2[], indices: number[]): number {
  let area = 0
  for (let i = 0; i < indices.length; i += 3) {
    const a = points[indices[i]]
    const b = points[indices[i + 1]]
    const c = points[indices[i + 2]]
    area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2
  }
  return area
}

console.log('geometry.ts')

test('нормаль горизонтального квадрата направлена вверх', () => {
  const square = [
    [0, 0, 0],
    [4, 0, 0],
    [4, 0, 4],
    [0, 0, 4],
  ].map((p) => [p[0], p[1], p[2]] as [number, number, number])
  const n = polygonNormal(square)
  close(Math.abs(n[1]), 1, 1e-6)
  close(n[0], 0, 1e-6)
  close(n[2], 0, 1e-6)
})

test('нормаль вертикальной стены горизонтальна', () => {
  const wall: [number, number, number][] = [
    [0, 0, 0],
    [5, 0, 0],
    [5, 3, 0],
    [0, 3, 0],
  ]
  const n = polygonNormal(wall)
  close(Math.abs(n[2]), 1, 1e-6)
})

test('центроид квадрата — его центр', () => {
  const c = centroid([
    [0, 0, 0],
    [2, 0, 0],
    [2, 0, 2],
    [0, 0, 2],
  ])
  close(c[0], 1)
  close(c[1], 0)
  close(c[2], 1)
})

test('знаковая площадь: обход по часовой стрелке отрицателен', () => {
  const ccw: Vec2[] = [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
  ]
  assert.ok(signedArea(ccw) > 0)
  assert.ok(signedArea([...ccw].reverse()) < 0)
})

test('выпуклый четырёхугольник даёт 2 треугольника', () => {
  const square: Vec2[] = [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
  ]
  const indices = triangulate2D(square)
  assert.equal(indices.length, 6)
  close(triangulatedArea(square, indices), 4, 1e-6)
})

test('невыпуклый L-образный контур триангулируется без потери площади', () => {
  // L-образная зона: площадь = 3*3 - 1*1... считаем явно
  const shape: Vec2[] = [
    [0, 0],
    [3, 0],
    [3, 1],
    [1, 1],
    [1, 3],
    [0, 3],
  ]
  const indices = triangulate2D(shape)
  assert.equal(indices.length, (shape.length - 2) * 3)
  close(triangulatedArea(shape, indices), Math.abs(signedArea(shape)), 1e-6)
})

test('контур из 12 точек-звезды триангулируется корректно', () => {
  const star: Vec2[] = []
  for (let i = 0; i < 12; i += 1) {
    const angle = (i / 12) * Math.PI * 2
    const radius = i % 2 === 0 ? 4 : 1.8
    star.push([Math.cos(angle) * radius, Math.sin(angle) * radius])
  }
  const indices = triangulate2D(star)
  assert.equal(indices.length, (star.length - 2) * 3)
  close(triangulatedArea(star, indices), Math.abs(signedArea(star)), 1e-6)
})

test('обход по часовой стрелке тоже триангулируется', () => {
  const cw: Vec2[] = [
    [0, 2],
    [2, 2],
    [2, 0],
    [0, 0],
  ]
  const indices = triangulate2D(cw)
  assert.equal(indices.length, 6)
  close(triangulatedArea(cw, indices), 4, 1e-6)
})

test('меньше трёх точек — пустая триангуляция, без исключений', () => {
  assert.deepEqual(triangulate2D([]), [])
  assert.deepEqual(triangulate2D([[0, 0]]), [])
  assert.deepEqual(
    triangulate2D([
      [0, 0],
      [1, 1],
    ]),
    [],
  )
})

test('вырожденный контур (все точки на прямой) не зацикливается', () => {
  const degenerate: Vec2[] = [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
  ]
  const indices = triangulate2D(degenerate)
  assert.equal(indices.length % 3, 0)
})

test('buildPolygonGeometry возвращает согласованные массивы', () => {
  const points = [
    [0, 0, 0],
    [4, 0, 0],
    [4, 0, 4],
    [0, 0, 4],
  ]
  const data = buildPolygonGeometry(points, 0.05)
  assert.equal(data.positions.length, points.length * 3)
  assert.equal(data.indices.length, 6)
  assert.ok(Math.max(...data.indices) < points.length)
  // Подъём вдоль нормали: y смещён на 0.05
  close(data.positions[1], 0.05, 1e-6)
  close(data.centroid[0], 2)
  close(data.centroid[2], 2)
})

test('площадь зоны в 3D считается на наклонной плоскости', () => {
  // Квадрат 2x2, наклонённый на 45° — площадь остаётся 4
  const tilted = [
    [0, 0, 0],
    [2, 0, 0],
    [2, Math.SQRT2, Math.SQRT2],
    [0, Math.SQRT2, Math.SQRT2],
  ]
  close(polygonArea3D(tilted), 4, 1e-6)
})

test('якорь виджета висит над центром зоны', () => {
  const anchor = billboardAnchor(
    [
      [0, 1, 0],
      [2, 1, 0],
      [2, 1, 2],
      [0, 1, 2],
    ],
    1.5,
  )
  close(anchor[0], 1)
  close(anchor[1], 2.5)
  close(anchor[2], 1)
})

console.log(`\nПройдено: ${passed}, провалено: ${failed}`)
if (failed > 0) process.exit(1)
