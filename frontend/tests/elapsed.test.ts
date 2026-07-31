/**
 * Тесты таймера активности карточки.
 * Запуск:  node tests/run.mjs
 */
import assert from 'node:assert/strict'

import { formatElapsed, parseServerTime } from '../src/lib/elapsed'

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

const BASE = Date.UTC(2026, 6, 31, 12, 0, 0) // 31.07.2026 12:00 UTC

/** Метка времени в том виде, в каком её отдаёт SQLite: без часового пояса. */
function naive(offsetMinutes: number): string {
  return new Date(BASE - offsetMinutes * 60_000).toISOString().replace('Z', '')
}

console.log('elapsed.ts — таймер активности')

test('время без зоны читается как UTC, а не как локальное', () => {
  // Ключевая ловушка: Date.parse('2026-07-31T12:00:00') трактует строку как
  // местное время, и таймер уезжал бы на величину часового пояса.
  assert.equal(parseServerTime('2026-07-31T12:00:00'), BASE)
  assert.equal(parseServerTime('2026-07-31T12:00:00Z'), BASE)
})

test('метка с явной зоной не портится', () => {
  assert.equal(parseServerTime('2026-07-31T15:00:00+03:00'), BASE)
})

test('минуты до часа выводятся без часов', () => {
  assert.equal(formatElapsed(naive(0), BASE), '0 мин')
  assert.equal(formatElapsed(naive(1), BASE), '1 мин')
  assert.equal(formatElapsed(naive(59), BASE), '59 мин')
})

test('часы и минуты с ведущим нулём', () => {
  assert.equal(formatElapsed(naive(60), BASE), '1 ч 00 мин')
  assert.equal(formatElapsed(naive(65), BASE), '1 ч 05 мин')
  assert.equal(formatElapsed(naive(185), BASE), '3 ч 05 мин')
})

test('длинные сроки не переводятся в дни — на стройке считают часами', () => {
  assert.equal(formatElapsed(naive(60 * 30), BASE), '30 ч 00 мин')
})

test('часы клиента впереди сервера не дают отрицательного времени', () => {
  // «-2 мин» выглядит поломкой, а не расхождением часов.
  assert.equal(formatElapsed(naive(-120), BASE), '0 мин')
})

test('битая метка не роняет карточку', () => {
  assert.equal(formatElapsed('', BASE), '—')
  assert.equal(formatElapsed('не дата', BASE), '—')
})

test('секунды округляются вниз до минуты', () => {
  const almost = new Date(BASE - 119_000).toISOString().replace('Z', '')
  assert.equal(formatElapsed(almost, BASE), '1 мин')
})

console.log(`\nПройдено: ${passed}, провалено: ${failed}`)
if (failed > 0) process.exit(1)
