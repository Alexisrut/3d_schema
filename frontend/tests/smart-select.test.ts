/**
 * Тесты «магического выделения» и плоских операций под него.
 * Запуск:  node tests/run.mjs
 */
import assert from 'node:assert/strict'

import {
  buildSmartSector,
  detailsInside,
  type DetailBounds,
} from '../src/lib/smartSelect'
import {
  convexHull2D,
  pointInPolygon2D,
  polygonIntersectsRect,
  segmentsIntersect,
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

const SQUARE: Vec2[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
]

console.log('geometry.ts — плоские операции')

test('точка внутри и снаружи контура', () => {
  assert.equal(pointInPolygon2D([5, 5], SQUARE), true)
  assert.equal(pointInPolygon2D([15, 5], SQUARE), false)
  assert.equal(pointInPolygon2D([-1, -1], SQUARE), false)
})

test('невыпуклый контур: выемка снаружи', () => {
  // L-образная зона: точка в вырезе не считается внутренней.
  const shape: Vec2[] = [
    [0, 0],
    [10, 0],
    [10, 4],
    [4, 4],
    [4, 10],
    [0, 10],
  ]
  assert.equal(pointInPolygon2D([2, 2], shape), true)
  assert.equal(pointInPolygon2D([8, 8], shape), false)
})

test('пересечение отрезков, включая касание', () => {
  assert.equal(segmentsIntersect([0, 0], [10, 10], [0, 10], [10, 0]), true)
  assert.equal(segmentsIntersect([0, 0], [1, 1], [5, 5], [6, 6]), false)
  // Касание концом — тоже пересечение: деталь, задетая ребром, захватывается.
  assert.equal(segmentsIntersect([0, 0], [5, 0], [5, 0], [5, 5]), true)
})

test('контур пересекает прямоугольник во всех трёх случаях', () => {
  // 1) угол детали внутри контура
  assert.equal(
    polygonIntersectsRect(SQUARE, { minX: 8, minY: 8, maxX: 20, maxY: 20 }),
    true,
  )
  // 2) контур целиком внутри детали
  assert.equal(
    polygonIntersectsRect(SQUARE, { minX: -5, minY: -5, maxX: 25, maxY: 25 }),
    true,
  )
  // 3) только рёбра пересекаются, вершин друг в друге нет
  assert.equal(
    polygonIntersectsRect(SQUARE, { minX: -5, minY: 4, maxX: 25, maxY: 6 }),
    true,
  )
  // мимо
  assert.equal(
    polygonIntersectsRect(SQUARE, { minX: 20, minY: 20, maxX: 30, maxY: 30 }),
    false,
  )
})

test('выпуклая оболочка отбрасывает внутренние точки', () => {
  const hull = convexHull2D([
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [5, 5], // внутри — в оболочку не попадает
    [3, 7],
  ])
  assert.equal(hull.length, 4)
  for (const corner of SQUARE) {
    assert.ok(
      hull.some((p) => Math.abs(p[0] - corner[0]) < 1e-6 && Math.abs(p[1] - corner[1]) < 1e-6),
      `угол ${corner} потерян`,
    )
  }
})

test('оболочка не ломается на дублях и вырожденных наборах', () => {
  assert.deepEqual(convexHull2D([]), [])
  assert.equal(convexHull2D([[1, 1], [1, 1], [1, 1]]).length, 1)
  // Все точки на прямой — оболочки нет, возвращаем что есть.
  assert.ok(convexHull2D([[0, 0], [1, 0], [2, 0]]).length <= 3)
})

console.log('\nsmartSelect.ts — захват деталей целиком')

/** Уличная зона и парковка рядом, здание — выше. */
const DETAILS: DetailBounds[] = [
  { name: 'Уличная зона', minX: 0, maxX: 20, minZ: 0, maxZ: 10, minY: 0, maxY: 0.4 },
  { name: 'Парковка', minX: 20, maxX: 40, minZ: 0, maxZ: 10, minY: 0, maxY: 0.3 },
  { name: 'Газон', minX: 60, maxX: 80, minZ: 0, maxZ: 10, minY: 0, maxY: 0.2 },
  { name: 'Кровля', minX: 0, maxX: 40, minZ: 0, maxZ: 10, minY: 20, maxY: 21 },
]

/** Контур, задевающий краешек уличной зоны и краешек парковки. */
const CORNER_TOUCH = [
  [18, 0.1, 4],
  [24, 0.1, 4],
  [24, 0.1, 6],
  [18, 0.1, 6],
]

test('деталь, задетая краем, захватывается целиком', () => {
  const captured = detailsInside(CORNER_TOUCH, DETAILS)
  const names = captured.map((d) => d.name).sort()
  assert.deepEqual(names, ['Парковка', 'Уличная зона'])
})

test('далёкая деталь не захватывается', () => {
  const names = detailsInside(CORNER_TOUCH, DETAILS).map((d) => d.name)
  assert.ok(!names.includes('Газон'))
})

test('деталь на другой отметке не захватывается', () => {
  // Кровля висит на 20 м — выделение по земле её брать не должно,
  // иначе «зона первого этажа» протыкала бы здание насквозь.
  const names = detailsInside(CORNER_TOUCH, DETAILS).map((d) => d.name)
  assert.ok(!names.includes('Кровля'))
})

test('запас по вертикали настраивается', () => {
  const names = detailsInside(CORNER_TOUCH, DETAILS, { verticalReach: 50 }).map((d) => d.name)
  assert.ok(names.includes('Кровля'))
})

test('зона строится по габаритам захваченных деталей, а не по контуру', () => {
  const result = buildSmartSector(CORNER_TOUCH, DETAILS)
  assert.ok(result)
  const xs = result!.coordinates.map((p) => p[0])
  const zs = result!.coordinates.map((p) => p[2])
  // Контур был 18..24 по X, а зона обязана накрыть обе детали целиком: 0..40.
  assert.equal(Math.min(...xs), 0)
  assert.equal(Math.max(...xs), 40)
  assert.equal(Math.min(...zs), 0)
  assert.equal(Math.max(...zs), 10)
  assert.deepEqual(result!.details.sort(), ['Парковка', 'Уличная зона'])
})

test('высота зоны берётся от низа до верха деталей', () => {
  const result = buildSmartSector(CORNER_TOUCH, DETAILS)
  assert.ok(result)
  // Уличная зона 0..0.4, парковка 0..0.3 → высота 0.4
  assert.ok(Math.abs(result!.height - 0.4) < 1e-6, String(result!.height))
})

test('плоские детали получают минимальную высоту, а не нулевую', () => {
  const flat: DetailBounds[] = [
    { name: 'Плита', minX: 0, maxX: 10, minZ: 0, maxZ: 10, minY: 0, maxY: 0 },
  ]
  const result = buildSmartSector(
    [[1, 0, 1], [5, 0, 1], [5, 0, 5]],
    flat,
    { minHeight: 0.5 },
  )
  assert.ok(result)
  assert.equal(result!.height, 0.5)
})

test('пустой захват возвращает null, а не пустую зону', () => {
  assert.equal(buildSmartSector([[100, 0, 100], [110, 0, 100], [110, 0, 110]], DETAILS), null)
  assert.equal(buildSmartSector([[0, 0, 0]], DETAILS), null)
  assert.equal(buildSmartSector(CORNER_TOUCH, []), null)
})

test('основание кладётся на низ деталей', () => {
  const raised: DetailBounds[] = [
    { name: 'Площадка', minX: 0, maxX: 10, minZ: 0, maxZ: 10, minY: 3, maxY: 4 },
  ]
  const result = buildSmartSector([[1, 3.5, 1], [5, 3.5, 1], [5, 3.5, 5]], raised)
  assert.ok(result)
  assert.ok(result!.coordinates.every((p) => Math.abs(p[1] - 3) < 1e-6), result!.coordinates)
})

console.log(`\nПройдено: ${passed}, провалено: ${failed}`)
if (failed > 0) process.exit(1)
