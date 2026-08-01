/**
 * Тесты выбора попадания с учётом отсечения по этажам.
 * Запуск:  node tests/run.mjs
 *
 * Проверяется исправление главного бага: при включённом фильтре этажей клик
 * между уровнями обязан попадать в видимую поверхность, а не в срезанную
 * крышу, которая на экране отсутствует, но для луча по-прежнему существует.
 */
import assert from 'node:assert/strict'

import { CLIP_EPS, pickWithinClip, withinClip } from '../src/three/clipping'

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

/** Попадания идут так же, как их отдаёт three.js: по возрастанию расстояния. */
function hits(...ys: number[]): Array<{ point: { y: number }; tag: number }> {
  return ys.map((y, i) => ({ point: { y }, tag: i }))
}

console.log('clipping.ts — видимый диапазон')

test('без ограничений отметка всегда видима', () => {
  assert.equal(withinClip(100, null, null), true)
  assert.equal(withinClip(-100, undefined, undefined), true)
})

test('нижняя граница отсекает то, что под ней', () => {
  assert.equal(withinClip(2, 5, null), false)
  assert.equal(withinClip(7, 5, null), true)
})

test('верхняя граница отсекает то, что над ней', () => {
  assert.equal(withinClip(9, null, 5), false)
  assert.equal(withinClip(3, null, 5), true)
})

test('диапазон «между» пропускает только середину', () => {
  assert.equal(withinClip(1, 3, 6), false)
  assert.equal(withinClip(4.5, 3, 6), true)
  assert.equal(withinClip(8, 3, 6), false)
})

test('кромка среза засчитывается — иначе клик по самой плоскости промахивался бы', () => {
  assert.equal(withinClip(3, 3, 6), true)
  assert.equal(withinClip(6, 3, 6), true)
  // Погрешность округления луча не должна отбрасывать попадание.
  assert.equal(withinClip(3 - CLIP_EPS / 2, 3, 6), true)
  assert.equal(withinClip(6 + CLIP_EPS / 2, 3, 6), true)
})

test('за пределами допуска отметка уже отсечена', () => {
  assert.equal(withinClip(3 - CLIP_EPS * 10, 3, 6), false)
  assert.equal(withinClip(6 + CLIP_EPS * 10, 3, 6), false)
})

console.log('\nclipping.ts — выбор попадания')

test('без отсечения берётся первое попадание, как и раньше', () => {
  const list = hits(30, 10, 4)
  assert.equal(pickWithinClip(list, null, null)?.tag, 0)
})

test('главный баг: крыша пропускается, точка ложится между этажами', () => {
  // Луч сверху вниз: сначала крыша (28 м), потом видимое перекрытие (7 м).
  // Фильтр «между 3 и 10» оставляет на экране только перекрытие.
  const list = hits(28, 7, 3.2)
  const picked = pickWithinClip(list, 3, 10)
  assert.equal(picked?.point.y, 7, 'выбрана не видимая поверхность')
})

test('порядок попаданий не меняется — берётся ближайшее из видимых', () => {
  const list = hits(28, 9, 5, 1)
  assert.equal(pickWithinClip(list, 3, 10)?.tag, 1)
})

test('режим «выше»: всё под отметкой пропускается', () => {
  const list = hits(2, 4, 12)
  assert.equal(pickWithinClip(list, 6, null)?.point.y, 12)
})

test('режим «ниже»: всё над отметкой пропускается', () => {
  const list = hits(20, 15, 4)
  assert.equal(pickWithinClip(list, null, 6)?.point.y, 4)
})

test('в диапазоне нет ни одного попадания — null, а не случайное', () => {
  const list = hits(28, 24, 20)
  assert.equal(pickWithinClip(list, 3, 10), null)
})

test('пустой список даёт null', () => {
  assert.equal(pickWithinClip([], null, null), null)
  assert.equal(pickWithinClip([], 1, 2), null)
})

console.log('\nclipping.ts — «попаданий нет» и «все срезаны» — разные случаи')

/**
 * Вызывающий обязан различать два вида null, иначе клик по фону обрабатывается
 * как клик по пустоте разреза и ставит опорную точку в сотнях метров от
 * здания. Здесь проверяется, что признак вычисляется однозначно.
 */
function blockedByClip(list: ReturnType<typeof hits>, min: number | null, max: number | null): boolean {
  return pickWithinClip(list, min, max) === null && list.length > 0
}

test('клик мимо модели: попаданий нет — запасного варианта быть не должно', () => {
  assert.equal(blockedByClip(hits(), 3, 10), false)
})

test('клик по срезанной части: попадания есть, все вне диапазона', () => {
  assert.equal(blockedByClip(hits(28, 24), 3, 10), true)
})

test('клик по видимой поверхности: признак не поднимается', () => {
  assert.equal(blockedByClip(hits(28, 7), 3, 10), false)
})

test('без отсечения признак не поднимается никогда', () => {
  assert.equal(blockedByClip(hits(28, 7, 1), null, null), false)
  assert.equal(blockedByClip(hits(), null, null), false)
})

console.log(`\nПройдено: ${passed}, провалено: ${failed}`)
if (failed > 0) process.exit(1)
