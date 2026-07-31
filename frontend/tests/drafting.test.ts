/**
 * Тесты двухэтапной разметки и атомарной отмены.
 * Запуск:  node tests/run.mjs
 */
import assert from 'node:assert/strict'

import {
  DEFAULT_EXTRUDE_HEIGHT,
  EMPTY_DRAFT,
  MAX_EXTRUDE_HEIGHT,
  addDraftPoint,
  beginExtrude,
  canBeginExtrude,
  canCommitDraft,
  cancelDraft,
  clampHeight,
  draftHasUndo,
  isDrafting,
  setDraftHeight,
  startDraft,
  undoDraft,
  type DraftState,
} from '../src/lib/drafting'

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

const P1 = [0, 0, 0]
const P2 = [4, 0, 0]
const P3 = [4, 0, 4]
const P4 = [0, 0, 4]

/** Черновик с готовым контуром из четырёх точек. */
function square(): DraftState {
  return [P1, P2, P3, P4].reduce(addDraftPoint, startDraft())
}

console.log('drafting.ts — шаг 1: контур')

test('в начале нечего отменять и нечего закреплять', () => {
  assert.equal(isDrafting(EMPTY_DRAFT), false)
  assert.equal(draftHasUndo(EMPTY_DRAFT), false)
  assert.equal(canCommitDraft(EMPTY_DRAFT), false)
})

test('старт разметки открывает шаг контура', () => {
  const draft = startDraft()
  assert.equal(draft.stage, 'polygon')
  assert.deepEqual(draft.points, [])
  assert.equal(isDrafting(draft), true)
})

test('точки накапливаются в порядке кликов', () => {
  const draft = square()
  assert.deepEqual(draft.points, [P1, P2, P3, P4])
})

test('вне режима разметки точки не принимаются', () => {
  assert.deepEqual(addDraftPoint(EMPTY_DRAFT, P1).points, [])
})

test('меньше трёх точек — закреплять нельзя', () => {
  let draft = startDraft()
  assert.equal(canCommitDraft(draft), false)
  draft = addDraftPoint(draft, P1)
  draft = addDraftPoint(draft, P2)
  assert.equal(canCommitDraft(draft), false)
  draft = addDraftPoint(draft, P3)
  assert.equal(canCommitDraft(draft), true)
})

console.log('\ndrafting.ts — шаг 2: объём')

test('к выдавливанию нельзя перейти без замкнутой площади', () => {
  const two = addDraftPoint(addDraftPoint(startDraft(), P1), P2)
  assert.equal(canBeginExtrude(two), false)
  assert.equal(beginExtrude(two).stage, 'polygon')
})

test('переход к выдавливанию ставит высоту по умолчанию', () => {
  const draft = beginExtrude(square())
  assert.equal(draft.stage, 'extrude')
  assert.equal(draft.height, DEFAULT_EXTRUDE_HEIGHT)
  // Контур при переходе не теряется.
  assert.deepEqual(draft.points, [P1, P2, P3, P4])
})

test('высота меняется только на шаге выдавливания', () => {
  assert.equal(setDraftHeight(square(), 7).height, 0)
  assert.equal(setDraftHeight(beginExtrude(square()), 7).height, 7)
})

test('высота зажимается в допустимые пределы', () => {
  assert.equal(clampHeight(-5), 0)
  assert.equal(clampHeight(MAX_EXTRUDE_HEIGHT + 1000), MAX_EXTRUDE_HEIGHT)
  assert.equal(clampHeight(Number.NaN), 0)
  assert.equal(clampHeight(12.5), 12.5)
  const draft = setDraftHeight(beginExtrude(square()), 99999)
  assert.equal(draft.height, MAX_EXTRUDE_HEIGHT)
})

test('на шаге выдавливания клик по модели не меняет контур', () => {
  const draft = addDraftPoint(beginExtrude(square()), [9, 9, 9])
  assert.deepEqual(draft.points, [P1, P2, P3, P4])
})

console.log('\ndrafting.ts — отмена ровно одного действия')

test('отмена убирает одну последнюю точку, а не все', () => {
  const draft = square()
  const first = undoDraft(draft)
  assert.equal(first.undone, 'point')
  assert.deepEqual(first.draft.points, [P1, P2, P3])
  const second = undoDraft(first.draft)
  assert.equal(second.undone, 'point')
  assert.deepEqual(second.draft.points, [P1, P2])
})

test('точки отменяются до последней, потом отмена выдыхается', () => {
  let draft = addDraftPoint(startDraft(), P1)
  let result = undoDraft(draft)
  assert.equal(result.undone, 'point')
  assert.deepEqual(result.draft.points, [])
  // Больше в черновике отменять нечего — очередь стека действий сцены.
  result = undoDraft(result.draft)
  assert.equal(result.undone, null)
  assert.equal(draftHasUndo(result.draft), false)
})

test('первая отмена после выдавливания возвращает к контуру, не удаляя точку', () => {
  const extruded = setDraftHeight(beginExtrude(square()), 4)
  const result = undoDraft(extruded)
  assert.equal(result.undone, 'extrude')
  assert.equal(result.draft.stage, 'polygon')
  assert.equal(result.draft.height, 0)
  // Ключевое: точки остались все четыре.
  assert.deepEqual(result.draft.points, [P1, P2, P3, P4])
})

test('вторая отмена после выдавливания снимает одну точку', () => {
  const back = undoDraft(setDraftHeight(beginExtrude(square()), 4)).draft
  const result = undoDraft(back)
  assert.equal(result.undone, 'point')
  assert.deepEqual(result.draft.points, [P1, P2, P3])
})

test('серия отмен разбирает черновик по одному шагу', () => {
  let draft = setDraftHeight(beginExtrude(square()), 5)
  const trace: string[] = []
  for (let i = 0; i < 6; i += 1) {
    const result = undoDraft(draft)
    trace.push(String(result.undone))
    draft = result.draft
  }
  assert.deepEqual(trace, ['extrude', 'point', 'point', 'point', 'point', 'null'])
  assert.deepEqual(draft.points, [])
})

test('после выдавливания и возврата можно выдавить снова', () => {
  const back = undoDraft(beginExtrude(square())).draft
  assert.equal(canBeginExtrude(back), true)
  assert.equal(beginExtrude(back, 6).height, 6)
})

test('отмена в пустом черновике ничего не ломает', () => {
  const result = undoDraft(EMPTY_DRAFT)
  assert.equal(result.undone, null)
  assert.equal(result.draft, EMPTY_DRAFT)
})

test('отмена не мутирует прежнее состояние', () => {
  const draft = square()
  const before = [...draft.points]
  undoDraft(draft)
  assert.deepEqual(draft.points, before)
})

test('выход из разметки обнуляет черновик целиком', () => {
  const draft = cancelDraft()
  assert.equal(draft.stage, 'idle')
  assert.deepEqual(draft.points, [])
  assert.equal(draftHasUndo(draft), false)
})

test('доступность кнопки отмены совпадает с наличием шага', () => {
  assert.equal(draftHasUndo(startDraft()), false)
  assert.equal(draftHasUndo(addDraftPoint(startDraft(), P1)), true)
  assert.equal(draftHasUndo(beginExtrude(square())), true)
})

console.log(`\nПройдено: ${passed}, провалено: ${failed}`)
if (failed > 0) process.exit(1)
