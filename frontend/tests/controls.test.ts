/**
 * Тесты настроек камеры: панорамирование включено и разложено по кнопкам.
 *
 * Проверять это в браузере руками ненадёжно — раскладку кнопок ломает одна
 * строка, а замечают такое только когда прораб не может сдвинуть картинку.
 *
 * Запуск:  node tests/run.mjs
 */
import assert from 'node:assert/strict'
import * as THREE from 'three'

import {
  MAX_NOTCHES_PER_EVENT,
  MAX_POLAR_ANGLE,
  ZOOM_FACTOR,
  configureControls,
  wheelNotches,
  zoomScaleFromWheel,
  zoomTowardPoint,
  type ControlsLike,
  type Point3,
} from '../src/three/controls'

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

/** Заглушка OrbitControls: те же поля, что настраивает configureControls. */
function stub(): ControlsLike & { updates: number } {
  const state = {
    enableDamping: false,
    dampingFactor: 0,
    enableZoom: false,
    enableRotate: false,
    enablePan: false,
    screenSpacePanning: false,
    panSpeed: 0,
    mouseButtons: {} as { LEFT?: number; MIDDLE?: number; RIGHT?: number },
    touches: {} as { ONE?: number; TWO?: number },
    maxPolarAngle: 0,
    minDistance: 0,
    maxDistance: 0,
    updates: 0,
    update() {
      state.updates += 1
    },
  }
  return state
}

console.log('controls.ts — камера и панорамирование')

test('панорамирование включено', () => {
  const controls = configureControls(stub())
  assert.equal(controls.enablePan, true)
  // Экранное панорамирование: картинка едет параллельно экрану, а не по
  // плоскости земли, — иначе на виде сверху сдвиг «вбок» уводит камеру вниз.
  assert.equal(controls.screenSpacePanning, true)
  assert.ok(controls.panSpeed > 0)
})

test('правая кнопка мыши двигает картинку', () => {
  const controls = configureControls(stub())
  assert.equal(controls.mouseButtons.RIGHT, THREE.MOUSE.PAN)
})

test('средняя кнопка тоже двигает картинку, как в CAD', () => {
  const controls = configureControls(stub())
  assert.equal(controls.mouseButtons.MIDDLE, THREE.MOUSE.PAN)
  // Средняя кнопка НЕ должна остаться «наездом» — это поведение по умолчанию,
  // от которого мы сознательно уходим.
  assert.notEqual(controls.mouseButtons.MIDDLE, THREE.MOUSE.DOLLY)
})

test('левая кнопка по-прежнему вращает сцену', () => {
  const controls = configureControls(stub())
  assert.equal(controls.mouseButtons.LEFT, THREE.MOUSE.ROTATE)
  assert.equal(controls.enableRotate, true)
})

test('зум остаётся включённым (колесо мыши)', () => {
  const controls = configureControls(stub())
  assert.equal(controls.enableZoom, true)
})

test('два пальца — сдвиг и щипковый зум', () => {
  const controls = configureControls(stub())
  assert.equal(controls.touches.TWO, THREE.TOUCH.DOLLY_PAN)
  assert.equal(controls.touches.ONE, THREE.TOUCH.ROTATE)
})

test('камера не проваливается под землю', () => {
  const controls = configureControls(stub())
  assert.equal(controls.maxPolarAngle, MAX_POLAR_ANGLE)
  assert.ok(controls.maxPolarAngle < Math.PI / 2)
})

test('дистанции и сглаживание заданы разумно', () => {
  const controls = configureControls(stub())
  assert.equal(controls.enableDamping, true)
  assert.ok(controls.dampingFactor > 0 && controls.dampingFactor < 1)
  assert.ok(controls.minDistance > 0)
  assert.ok(controls.maxDistance > controls.minDistance)
})

test('настройки применяются одним update()', () => {
  const controls = configureControls(stub()) as ReturnType<typeof stub>
  assert.equal(controls.updates, 1)
})

console.log('\ncontrols.ts — зум к точке под курсором')

function close(actual: number, expected: number, tolerance = 1e-6): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `ожидалось ${expected}, получено ${actual}`,
  )
}

function distance(a: Point3, b: Point3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/** Куда проецируется точка на экран — упрощённо, вдоль оси взгляда. */
function screenOffset(camera: Point3, target: Point3, point: Point3): [number, number] {
  // Камера смотрит из camera в target; строим базис и раскладываем вектор
  // «камера → точка» по экранным осям.
  const forward = [target[0] - camera[0], target[1] - camera[1], target[2] - camera[2]]
  const flen = Math.hypot(...forward)
  const f = forward.map((v) => v / flen)
  const up = [0, 1, 0]
  const right = [
    f[1] * up[2] - f[2] * up[1],
    f[2] * up[0] - f[0] * up[2],
    f[0] * up[1] - f[1] * up[0],
  ]
  const rlen = Math.hypot(...right)
  const r = right.map((v) => v / rlen)
  const u = [
    r[1] * f[2] - r[2] * f[1],
    r[2] * f[0] - r[0] * f[2],
    r[0] * f[1] - r[1] * f[0],
  ]
  const d = [point[0] - camera[0], point[1] - camera[1], point[2] - camera[2]]
  const depth = d[0] * f[0] + d[1] * f[1] + d[2] * f[2]
  const x = d[0] * r[0] + d[1] * r[1] + d[2] * r[2]
  const y = d[0] * u[0] + d[1] * u[1] + d[2] * u[2]
  // Перспектива: экранные координаты — отношение к глубине.
  return [x / depth, y / depth]
}

test('прокрутка «на себя» приближает, «от себя» отдаляет', () => {
  assert.ok(zoomScaleFromWheel(-100) < 1)
  assert.ok(zoomScaleFromWheel(100) > 1)
  close(zoomScaleFromWheel(100), ZOOM_FACTOR)
  close(zoomScaleFromWheel(0), 1)
})

test('щелчки нормализуются по deltaMode', () => {
  // Пиксели, строки и страницы приводятся к сопоставимому шагу.
  close(wheelNotches(100, 0), 1)
  close(wheelNotches(6.25, 1), 1)
  close(wheelNotches(1, 2), 1)
})

test('рывок тачпада ограничен по величине', () => {
  assert.equal(wheelNotches(100000), MAX_NOTCHES_PER_EVENT)
  assert.equal(wheelNotches(-100000), -MAX_NOTCHES_PER_EVENT)
  assert.equal(wheelNotches(Number.NaN), 0)
})

test('камера приближается именно к точке под курсором', () => {
  const camera: Point3 = [0, 10, 20]
  const target: Point3 = [0, 0, 0]
  // Курсор наведён на угол здания в стороне от центра.
  const anchor: Point3 = [8, 0, 4]
  const before = distance(camera, anchor)
  const next = zoomTowardPoint({ cameraPosition: camera, target, anchor, scale: 0.5 })
  const after = distance(next.position, anchor)
  close(after, before * 0.5, 1e-9)
})

test('точка под курсором остаётся на том же месте экрана', () => {
  const camera: Point3 = [0, 10, 20]
  const target: Point3 = [0, 0, 0]
  const anchor: Point3 = [6, 1, 3]
  const wasAt = screenOffset(camera, target, anchor)
  const next = zoomTowardPoint({ cameraPosition: camera, target, anchor, scale: 0.6 })
  const nowAt = screenOffset(next.position, next.target, anchor)
  // Это и есть смысл «зума к курсору»: якорь не уезжает по экрану.
  close(nowAt[0], wasAt[0], 1e-9)
  close(nowAt[1], wasAt[1], 1e-9)
})

test('цель едет вместе с камерой — центр вращения не остаётся позади', () => {
  const camera: Point3 = [0, 10, 20]
  const target: Point3 = [0, 0, 0]
  const anchor: Point3 = [10, 0, 0]
  const next = zoomTowardPoint({ cameraPosition: camera, target, anchor, scale: 0.5 })
  assert.notDeepEqual(next.target, target)
  // Цель приблизилась к якорю ровно вдвое, как и камера.
  close(distance(next.target, anchor), distance(target, anchor) * 0.5, 1e-9)
})

test('якорь в центре экрана даёт обычный зум', () => {
  const camera: Point3 = [0, 0, 20]
  const target: Point3 = [0, 0, 0]
  const next = zoomTowardPoint({ cameraPosition: camera, target, anchor: target, scale: 0.5 })
  assert.deepEqual(next.target, [0, 0, 0])
  close(next.position[2], 10)
})

test('ближе минимальной дистанции камера не подходит', () => {
  const camera: Point3 = [0, 0, 10]
  const target: Point3 = [0, 0, 0]
  const next = zoomTowardPoint({
    cameraPosition: camera,
    target,
    anchor: [0, 0, 0],
    scale: 0.01,
    minDistance: 2,
    maxDistance: 100,
  })
  close(distance(next.position, next.target), 2)
})

test('дальше максимальной дистанции камера не уходит', () => {
  const next = zoomTowardPoint({
    cameraPosition: [0, 0, 10],
    target: [0, 0, 0],
    anchor: [0, 0, 0],
    scale: 100,
    minDistance: 1,
    maxDistance: 50,
  })
  close(distance(next.position, next.target), 50)
})

test('упор в предел не разворачивает камеру', () => {
  const next = zoomTowardPoint({
    cameraPosition: [0, 0, 10],
    target: [0, 0, 0],
    anchor: [0, 0, 0],
    scale: 0.01,
    minDistance: 2,
    maxDistance: 100,
  })
  // Знак направления взгляда сохранён: камера осталась по ту же сторону цели.
  assert.ok(next.position[2] > 0)
})

test('вырожденные входные данные не ломают камеру', () => {
  const camera: Point3 = [1, 2, 3]
  const target: Point3 = [1, 2, 3]
  const same = zoomTowardPoint({ cameraPosition: camera, target, anchor: camera, scale: 0.5 })
  assert.deepEqual(same.position, camera)
  assert.deepEqual(same.target, target)

  const nan = zoomTowardPoint({
    cameraPosition: [0, 0, 10],
    target: [0, 0, 0],
    anchor: [0, 0, 0],
    scale: Number.NaN,
  })
  assert.ok(nan.position.every(Number.isFinite))
  close(nan.position[2], 10)
})

test('последовательные щелчки складываются, а не сбрасываются', () => {
  const anchor: Point3 = [5, 0, 5]
  let position: Point3 = [0, 10, 20]
  let target: Point3 = [0, 0, 0]
  const start = distance(position, anchor)
  for (let i = 0; i < 3; i += 1) {
    const next = zoomTowardPoint({ cameraPosition: position, target, anchor, scale: 0.5 })
    position = next.position
    target = next.target
  }
  close(distance(position, anchor), start * 0.125, 1e-9)
})

console.log(`\nПройдено: ${passed}, провалено: ${failed}`)
if (failed > 0) process.exit(1)
