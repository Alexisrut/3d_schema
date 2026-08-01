/**
 * «Выделение по деталям» (п. 3.2 доработок, вторая редакция).
 *
 * Прежняя редакция («умное выделение») просила обвести контур и сама решала,
 * какие детали он задел. Решение приходилось угадывать: контур ложился на
 * поверхность модели, а деталь могла уходить вверх или вниз от неё, и допуск
 * по вертикали то захватывал лишнее, то терял нужное. Пользователь видел
 * результат только после закрепления зоны.
 *
 * Теперь выбор явный: пользователь тыкает по деталям, каждая подсвечивается
 * сразу, повторный клик снимает. Площадь зоны строится по выбранным деталям,
 * высота предлагается по их габаритам и правится на втором шаге.
 *
 * Модуль чистый: на вход идут уже посчитанные габариты, поэтому логику можно
 * проверить тестами без three.js и без сцены.
 */
import { convexHull2D, type Rect2, type Vec2 } from '@/three/geometry'

/** Габариты детали модели в мировых координатах. */
export interface DetailBounds {
  /** Имя меша — по нему деталь находится в сцене и подсвечивается. */
  name: string
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

export interface DetailSelection {
  /** Контур основания зоны: [[x, y, z], ...] на отметке низа деталей. */
  coordinates: number[][]
  /** Высота по габаритам выбранных деталей — предложение для второго шага. */
  height: number
  /** Отметка низа: по ней зона ложится на те же перекрытия, что и детали. */
  baseY: number
}

/** Минимальная высота зоны, если выбраны только плоские детали (плита, стяжка). */
export const MIN_DETAIL_HEIGHT = 0.1

/** След детали в плоскости XZ. */
export function detailFootprint(detail: DetailBounds): Rect2 {
  return { minX: detail.minX, minY: detail.minZ, maxX: detail.maxX, maxY: detail.maxZ }
}

/**
 * Добавить или убрать деталь из набора.
 *
 * Порядок сохраняется в порядке выбора: он виден пользователю в счётчике и
 * в подсказке, а сортировка по имени перемешивала бы список на каждом клике.
 */
export function toggleDetailName(names: readonly string[], name: string): string[] {
  return names.includes(name) ? names.filter((item) => item !== name) : [...names, name]
}

/**
 * Собрать зону из выбранных деталей.
 *
 * Граница — выпуклая оболочка следов деталей: она плотнее общего
 * прямоугольника и не тянет зону на пустое место между разнесёнными
 * объектами. Основание кладётся на низ самой низкой детали, предлагаемая
 * высота — до верха самой высокой.
 *
 * Возвращает null, если оболочка вырождена: одна деталь нулевой площади или
 * несколько деталей, стоящих строго по одной линии, зоны не образуют.
 */
export function buildSectorFromDetails(details: readonly DetailBounds[]): DetailSelection | null {
  if (details.length === 0) return null

  const corners: Vec2[] = []
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const detail of details) {
    const rect = detailFootprint(detail)
    corners.push(
      [rect.minX, rect.minY],
      [rect.maxX, rect.minY],
      [rect.maxX, rect.maxY],
      [rect.minX, rect.maxY],
    )
    minY = Math.min(minY, detail.minY)
    maxY = Math.max(maxY, detail.maxY)
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return null

  const hull = convexHull2D(corners)
  if (hull.length < 3) return null

  return {
    coordinates: hull.map(([x, z]) => [x, minY, z]),
    height: Math.max(MIN_DETAIL_HEIGHT, maxY - minY),
    baseY: minY,
  }
}
