/**
 * Тесты «выделения по деталям» и плоских операций под него.
 * Запуск:  node tests/run.mjs
 */
import assert from 'node:assert/strict'

import {
  buildSectorFromDetails,
  MIN_DETAIL_HEIGHT,
  toggleDetailName,
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

console.log('\nsmartSelect.ts — набор деталей')

test('клик добавляет деталь, повторный — убирает', () => {
  let names = toggleDetailName([], 'Колонна-1')
  assert.deepEqual(names, ['Колонна-1'])
  names = toggleDetailName(names, 'Плита-2')
  assert.deepEqual(names, ['Колонна-1', 'Плита-2'])
  names = toggleDetailName(names, 'Колонна-1')
  assert.deepEqual(names, ['Плита-2'])
})

test('порядок набора сохраняется — счётчик не должен прыгать', () => {
  let names: string[] = []
  for (const n of ['Я', 'А', 'М']) names = toggleDetailName(names, n)
  assert.deepEqual(names, ['Я', 'А', 'М'])
})

test('снятие последней детали даёт пустой набор, а не null', () => {
  const names = toggleDetailName(['Одна'], 'Одна')
  assert.deepEqual(names, [])
})

console.log('\nsmartSelect.ts — зона по выбранным деталям')

/** Уличная зона и парковка рядом, здание — выше. */
const DETAILS: DetailBounds[] = [
  { name: 'Уличная зона', minX: 0, maxX: 20, minZ: 0, maxZ: 10, minY: 0, maxY: 0.4 },
  { name: 'Парковка', minX: 20, maxX: 40, minZ: 0, maxZ: 10, minY: 0, maxY: 0.3 },
  { name: 'Газон', minX: 60, maxX: 80, minZ: 0, maxZ: 10, minY: 0, maxY: 0.2 },
  { name: 'Кровля', minX: 0, maxX: 40, minZ: 0, maxZ: 10, minY: 20, maxY: 21 },
]

function byName(...names: string[]): DetailBounds[] {
  return names.map((n) => DETAILS.find((d) => d.name === n) as DetailBounds)
}

test('зона накрывает выбранные детали целиком', () => {
  const result = buildSectorFromDetails(byName('Уличная зона', 'Парковка'))
  assert.ok(result)
  const xs = result!.coordinates.map((p) => p[0])
  const zs = result!.coordinates.map((p) => p[2])
  assert.equal(Math.min(...xs), 0)
  assert.equal(Math.max(...xs), 40)
  assert.equal(Math.min(...zs), 0)
  assert.equal(Math.max(...zs), 10)
})

test('невыбранная деталь в зону не попадает', () => {
  // Газон стоит на 60..80 по X — если бы он захватывался, оболочка
  // растянулась бы до 80 и накрыла пустое место между объектами.
  const result = buildSectorFromDetails(byName('Уличная зона', 'Парковка'))
  assert.ok(result)
  assert.equal(Math.max(...result!.coordinates.map((p) => p[0])), 40)
})

test('детали на разных отметках выбираются вместе — вертикального допуска больше нет', () => {
  // В прежней редакции кровля на 20 м не захватывалась выделением по земле.
  // Теперь выбор явный: раз пользователь ткнул — значит, так и хотел.
  const result = buildSectorFromDetails(byName('Уличная зона', 'Кровля'))
  assert.ok(result)
  assert.equal(result!.baseY, 0)
  assert.ok(Math.abs(result!.height - 21) < 1e-6, String(result!.height))
})

test('предлагаемая высота — от низа до верха выбранных деталей', () => {
  const result = buildSectorFromDetails(byName('Уличная зона', 'Парковка'))
  assert.ok(result)
  assert.ok(Math.abs(result!.height - 0.4) < 1e-6, String(result!.height))
})

test('плоская деталь получает минимальную высоту, а не нулевую', () => {
  const flat: DetailBounds[] = [
    { name: 'Плита', minX: 0, maxX: 10, minZ: 0, maxZ: 10, minY: 2, maxY: 2 },
  ]
  const result = buildSectorFromDetails(flat)
  assert.ok(result)
  assert.equal(result!.height, MIN_DETAIL_HEIGHT)
})

test('основание кладётся на низ деталей', () => {
  const raised: DetailBounds[] = [
    { name: 'Площадка', minX: 0, maxX: 10, minZ: 0, maxZ: 10, minY: 3, maxY: 4 },
  ]
  const result = buildSectorFromDetails(raised)
  assert.ok(result)
  assert.equal(result!.baseY, 3)
  assert.ok(result!.coordinates.every((p) => Math.abs(p[1] - 3) < 1e-6), result!.coordinates)
})

test('одна деталь — уже готовая зона', () => {
  const result = buildSectorFromDetails(byName('Парковка'))
  assert.ok(result)
  assert.equal(result!.coordinates.length, 4)
})

test('пустой набор возвращает null, а не пустую зону', () => {
  assert.equal(buildSectorFromDetails([]), null)
})

test('вырожденная деталь нулевой площади зоны не образует', () => {
  const degenerate: DetailBounds[] = [
    { name: 'Точка', minX: 5, maxX: 5, minZ: 5, maxZ: 5, minY: 0, maxY: 3 },
  ]
  assert.equal(buildSectorFromDetails(degenerate), null)
})

console.log(`\nПройдено: ${passed}, провалено: ${failed}`)
if (failed > 0) process.exit(1)
