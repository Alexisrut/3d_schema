/**
 * Тесты мультивыделения (Shift/Ctrl) и переключателя прозрачности.
 * Запуск:  node tests/run.mjs
 */
import assert from 'node:assert/strict'

import {
  EMPTY_SELECTION,
  applySelection,
  isGhost,
  isHidden,
  modeFromEvent,
  nextVisibility,
  nextVisibilityForGroup,
  pruneSelection,
  type SelectionState,
  type Visibility,
} from '../src/lib/selection'

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

const ORDER = [10, 20, 30, 40, 50]

console.log('selection.ts — модификаторы')

test('обычный клик, Ctrl, Cmd и Shift разбираются верно', () => {
  assert.equal(modeFromEvent({}), 'replace')
  assert.equal(modeFromEvent({ ctrlKey: true }), 'toggle')
  assert.equal(modeFromEvent({ metaKey: true }), 'toggle')
  assert.equal(modeFromEvent({ shiftKey: true }), 'range')
  // Shift важнее Ctrl: так ведут себя списки в проводнике и в CAD.
  assert.equal(modeFromEvent({ shiftKey: true, ctrlKey: true }), 'range')
})

console.log('\nselection.ts — обычный клик и Ctrl')

test('обычный клик оставляет одну строку', () => {
  const state = applySelection({ ids: [10, 20, 30], anchor: 10 }, 40, 'replace', ORDER)
  assert.deepEqual(state.ids, [40])
  assert.equal(state.anchor, 40)
})

test('Ctrl добавляет строку к выделению', () => {
  let state = applySelection(EMPTY_SELECTION, 20, 'toggle', ORDER)
  state = applySelection(state, 40, 'toggle', ORDER)
  assert.deepEqual(state.ids, [20, 40])
})

test('Ctrl по выбранной строке снимает её', () => {
  const state = applySelection({ ids: [20, 40], anchor: 40 }, 20, 'toggle', ORDER)
  assert.deepEqual(state.ids, [40])
})

test('Ctrl может снять выделение полностью', () => {
  const state = applySelection({ ids: [20], anchor: 20 }, 20, 'toggle', ORDER)
  assert.deepEqual(state.ids, [])
})

test('порядок выделения — порядок добавления', () => {
  let state = applySelection(EMPTY_SELECTION, 50, 'toggle', ORDER)
  state = applySelection(state, 10, 'toggle', ORDER)
  state = applySelection(state, 30, 'toggle', ORDER)
  assert.deepEqual(state.ids, [50, 10, 30])
})

console.log('\nselection.ts — Shift-диапазон')

test('Shift выбирает диапазон от опоры вниз', () => {
  const start = applySelection(EMPTY_SELECTION, 20, 'replace', ORDER)
  const state = applySelection(start, 40, 'range', ORDER)
  assert.deepEqual(state.ids, [20, 30, 40])
})

test('Shift работает и вверх по списку', () => {
  const start = applySelection(EMPTY_SELECTION, 40, 'replace', ORDER)
  const state = applySelection(start, 10, 'range', ORDER)
  assert.deepEqual(state.ids, [10, 20, 30, 40])
})

test('серия Shift-кликов отсчитывается от одной опоры', () => {
  const start = applySelection(EMPTY_SELECTION, 30, 'replace', ORDER)
  const wide = applySelection(start, 50, 'range', ORDER)
  assert.deepEqual(wide.ids, [30, 40, 50])
  // Второй Shift-клик сужает диапазон, а не наращивает его от 50.
  const narrow = applySelection(wide, 40, 'range', ORDER)
  assert.deepEqual(narrow.ids, [30, 40])
})

test('Shift по той же строке оставляет её одну', () => {
  const start = applySelection(EMPTY_SELECTION, 30, 'replace', ORDER)
  assert.deepEqual(applySelection(start, 30, 'range', ORDER).ids, [30])
})

test('Shift без опоры ведёт себя как обычный клик', () => {
  const state = applySelection(EMPTY_SELECTION, 30, 'range', ORDER)
  assert.deepEqual(state.ids, [30])
  assert.equal(state.anchor, 30)
})

test('исчезнувшая опора не выделяет случайный кусок списка', () => {
  // Зону 99 удалили, но она осталась опорой.
  const state = applySelection({ ids: [99], anchor: 99 }, 30, 'range', ORDER)
  assert.deepEqual(state.ids, [30])
})

test('строка вне списка не роняет диапазон', () => {
  const state = applySelection({ ids: [20], anchor: 20 }, 777, 'range', ORDER)
  assert.deepEqual(state.ids, [777])
})

console.log('\nselection.ts — чистка выделения')

test('удалённые объекты уходят из выделения', () => {
  const state = pruneSelection({ ids: [10, 20, 30], anchor: 20 }, [10, 30])
  assert.deepEqual(state.ids, [10, 30])
  assert.equal(state.anchor, null)
})

test('живая опора сохраняется', () => {
  const state = pruneSelection({ ids: [10, 20], anchor: 10 }, [10])
  assert.deepEqual(state.ids, [10])
  assert.equal(state.anchor, 10)
})

test('без изменений возвращается тот же объект', () => {
  const before: SelectionState = { ids: [10, 20], anchor: 10 }
  assert.equal(pruneSelection(before, [10, 20, 30]), before)
})

console.log('\nselection.ts — прозрачность')

test('состояния идут по кругу', () => {
  assert.equal(nextVisibility('normal'), 'ghost')
  assert.equal(nextVisibility('ghost'), 'hidden')
  assert.equal(nextVisibility('hidden'), 'normal')
  assert.equal(nextVisibility(undefined), 'ghost')
})

test('однородная группа переключается как один объект', () => {
  const map: Record<number, Visibility> = { 10: 'normal', 20: 'normal' }
  assert.equal(nextVisibilityForGroup([10, 20], map), 'ghost')
  assert.equal(nextVisibilityForGroup([10, 20], { 10: 'ghost', 20: 'ghost' }), 'hidden')
})

test('смешанная группа сначала приводится к полупрозрачной', () => {
  assert.equal(nextVisibilityForGroup([10, 20], { 10: 'normal', 20: 'hidden' }), 'ghost')
})

test('объекты без записи считаются обычными', () => {
  assert.equal(nextVisibilityForGroup([10, 20], { 10: 'normal' }), 'ghost')
  assert.equal(isHidden(99, {}), false)
  assert.equal(isGhost(99, {}), false)
})

test('пустая группа не роняет расчёт', () => {
  assert.equal(nextVisibilityForGroup([], {}), 'ghost')
})

test('признаки скрытия и полупрозрачности', () => {
  const map: Record<number, Visibility> = { 1: 'hidden', 2: 'ghost', 3: 'normal' }
  assert.equal(isHidden(1, map), true)
  assert.equal(isGhost(1, map), false)
  assert.equal(isGhost(2, map), true)
  assert.equal(isHidden(3, map), false)
})

console.log(`\nПройдено: ${passed}, провалено: ${failed}`)
if (failed > 0) process.exit(1)
