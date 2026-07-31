/**
 * Настройки орбитального управления камерой (п. 3.1 ТЗ, п. 1.4 доработок).
 *
 * Вынесено из компонента отдельным модулем, чтобы раскладку кнопок мыши можно
 * было проверить тестом: «включён ли Pan» — требование, которое иначе
 * проверяется только руками, а сломать его достаточно одной строкой.
 */
import * as THREE from 'three'

/**
 * Минимум от OrbitControls, который настраивает эта функция.
 *
 * Кнопки описаны как `number | null | undefined`: в типах three.js их можно
 * обнулить, чтобы отключить жест, и без null сюда не подставился бы сам
 * OrbitControls.
 */
export interface ControlsLike {
  enableDamping: boolean
  dampingFactor: number
  enableZoom: boolean
  enableRotate: boolean
  enablePan: boolean
  screenSpacePanning: boolean
  panSpeed: number
  mouseButtons: { LEFT?: number | null; MIDDLE?: number | null; RIGHT?: number | null }
  touches: { ONE?: number | null; TWO?: number | null }
  maxPolarAngle: number
  minDistance: number
  maxDistance: number
  update: () => void
}

/** Максимальный угол: ниже горизонта камеру не пускаем — «нырять» под землю незачем. */
export const MAX_POLAR_ANGLE = Math.PI * 0.495

export const MIN_DISTANCE = 1
export const MAX_DISTANCE = 5000

// ---------------------------------------------------- зум к точке под курсором
/** Во сколько раз меняется расстояние за один «щелчок» колеса. */
export const ZOOM_FACTOR = 1.15
/** Сколько пикселей прокрутки считается одним щелчком. */
export const WHEEL_PIXELS_PER_NOTCH = 100
/** Ограничение на один кадр: рывок тачпада не должен телепортировать камеру. */
export const MAX_NOTCHES_PER_EVENT = 4
/** Высота строки и страницы для deltaMode = 1 и 2. */
const LINE_HEIGHT = 16
const PAGE_HEIGHT = 100

const EPS = 1e-9

export type Point3 = [number, number, number]

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Прокрутка колеса → число «щелчков».
 *
 * `deltaMode` учитывается специально: мышь обычно шлёт пиксели, но Firefox и
 * часть драйверов присылают строки (1) или страницы (2), и без нормализации
 * шаг зума отличался бы на порядок между браузерами.
 */
export function wheelNotches(deltaY: number, deltaMode = 0): number {
  if (!Number.isFinite(deltaY)) return 0
  const unit = deltaMode === 1 ? LINE_HEIGHT : deltaMode === 2 ? PAGE_HEIGHT : 1
  const pixels = deltaY * unit
  return clamp(
    pixels / WHEEL_PIXELS_PER_NOTCH,
    -MAX_NOTCHES_PER_EVENT,
    MAX_NOTCHES_PER_EVENT,
  )
}

/**
 * Коэффициент изменения расстояния до цели.
 *
 * Больше 1 — отдаление, меньше 1 — приближение. Прокрутка «от себя»
 * (deltaY > 0) отдаляет: так ведут себя и браузер, и OrbitControls.
 */
export function zoomScaleFromWheel(deltaY: number, deltaMode = 0): number {
  return Math.pow(ZOOM_FACTOR, wheelNotches(deltaY, deltaMode))
}

export interface ZoomToPointInput {
  cameraPosition: Point3
  /** Текущая точка, вокруг которой вращается камера. */
  target: Point3
  /** Точка под курсором — к ней приближаемся. */
  anchor: Point3
  /** Коэффициент из zoomScaleFromWheel. */
  scale: number
  minDistance?: number
  maxDistance?: number
}

/**
 * Зум к точке под курсором (как в CAD), а не к центру экрана.
 *
 * Вся связка «камера + цель» масштабируется относительно якоря: и позиция, и
 * цель приближаются к нему в `scale` раз. Точка под курсором при этом остаётся
 * на том же месте экрана — именно этого ждёт пользователь, наезжая колесом на
 * нужный угол здания.
 *
 * Цель двигается вместе с камерой намеренно: если оставить её на месте, при
 * наезде на край модели камера упрётся в старый центр вращения и дальнейшая
 * орбита будет крутиться вокруг точки, которой уже нет в кадре.
 *
 * Расстояние зажимается в [minDistance, maxDistance]; на упоре двигается
 * камера, а цель остаётся там, куда её привёл зум, — иначе на пределе
 * приближения картинка «дёргалась» бы назад.
 */
export function zoomTowardPoint(input: ZoomToPointInput): {
  position: Point3
  target: Point3
} {
  const {
    cameraPosition,
    target,
    anchor,
    minDistance = MIN_DISTANCE,
    maxDistance = MAX_DISTANCE,
  } = input
  const scale = Number.isFinite(input.scale) && input.scale > 0 ? input.scale : 1

  const scaled = (from: Point3): Point3 => [
    anchor[0] + (from[0] - anchor[0]) * scale,
    anchor[1] + (from[1] - anchor[1]) * scale,
    anchor[2] + (from[2] - anchor[2]) * scale,
  ]

  const position = scaled(cameraPosition)
  const nextTarget = scaled(target)

  const offset: Point3 = [
    position[0] - nextTarget[0],
    position[1] - nextTarget[1],
    position[2] - nextTarget[2],
  ]
  const distance = Math.hypot(offset[0], offset[1], offset[2])
  // Камера ровно в цели — направление взгляда не определено, оставляем как было.
  if (distance < EPS) return { position: [...cameraPosition], target: [...target] }

  const clamped = clamp(distance, minDistance, maxDistance)
  if (Math.abs(clamped - distance) < EPS) return { position, target: nextTarget }

  const k = clamped / distance
  return {
    position: [
      nextTarget[0] + offset[0] * k,
      nextTarget[1] + offset[1] * k,
      nextTarget[2] + offset[2] * k,
    ],
    target: nextTarget,
  }
}

export function configureControls(controls: ControlsLike): ControlsLike {
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.enableZoom = true
  controls.enableRotate = true

  // Панорамирование: правая и средняя кнопки, как в CAD. Средняя по
  // умолчанию отдана «наезду», но в Revit и AutoCAD ею двигают картинку,
  // и мышечная память у прорабов именно такая. Зум остаётся на колесе.
  controls.enablePan = true
  controls.screenSpacePanning = true
  controls.panSpeed = 1
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.PAN,
    RIGHT: THREE.MOUSE.PAN,
  }
  // Два пальца — сдвиг и щипковый зум одновременно.
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }

  controls.maxPolarAngle = MAX_POLAR_ANGLE
  controls.minDistance = MIN_DISTANCE
  controls.maxDistance = MAX_DISTANCE
  controls.update()
  return controls
}
