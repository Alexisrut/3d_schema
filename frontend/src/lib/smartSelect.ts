/**
 * «Магическое выделение» (п. 3.2 доработок).
 *
 * Обычная разметка обводит пустой объём: где провёл контур — там и зона.
 * Умное выделение работает иначе: контур лишь указывает, ЧТО захватить.
 * Каждая деталь модели, задетая контуром хотя бы краем, попадает в зону
 * ЦЕЛИКОМ, а итоговая граница строится по их общим габаритам.
 *
 * Пример из ТЗ: обвели угол парковки и кусок уличной зоны — в сектор уходят
 * парковка и уличная зона полностью, а не обрезки под контуром.
 *
 * Модуль чистый: на вход идут уже посчитанные габариты деталей, поэтому
 * логику можно проверить тестами без three.js и без сцены.
 */
import { convexHull2D, polygonIntersectsRect, type Rect2, type Vec2 } from '@/three/geometry'

/** Габариты детали модели в мировых координатах. */
export interface DetailBounds {
  /** Имя меша — попадает в подпись зоны и в отладку. */
  name: string
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

export interface SmartSelection {
  /** Контур основания зоны: [[x, y, z], ...] на отметке низа деталей. */
  coordinates: number[][]
  /** Высота выдавливания — от низа самой низкой детали до верха самой высокой. */
  height: number
  /** Что захвачено — показывается пользователю перед закреплением. */
  details: string[]
}

/**
 * Насколько контур «дотягивается» до детали по вертикали.
 *
 * Клики пользователя ложатся на поверхность модели, а деталь может уходить
 * вверх или вниз от этой отметки. Полностью игнорировать высоту нельзя:
 * иначе выделение на первом этаже захватило бы и кровлю над ним.
 */
export const DEFAULT_VERTICAL_REACH = 4

export interface SmartSelectOptions {
  /** Допуск по вертикали от плоскости контура, м. */
  verticalReach?: number
  /** Минимальная высота зоны, если детали оказались плоскими. */
  minHeight?: number
}

/** След детали в плоскости XZ. */
export function detailFootprint(detail: DetailBounds): Rect2 {
  return { minX: detail.minX, minY: detail.minZ, maxX: detail.maxX, maxY: detail.maxZ }
}

/**
 * Детали, задетые контуром.
 *
 * Условий два: след детали пересекается с контуром в плане И деталь
 * дотягивается по вертикали до уровня контура. Второе отсекает этажи выше
 * и ниже — без него «выделение по плану» захватывало бы всё здание насквозь.
 */
export function detailsInside(
  polygon: number[][],
  details: DetailBounds[],
  options: SmartSelectOptions = {},
): DetailBounds[] {
  if (polygon.length < 3) return []
  const reach = options.verticalReach ?? DEFAULT_VERTICAL_REACH

  const flat: Vec2[] = polygon.map((point) => [point[0], point[2]])
  const levels = polygon.map((point) => point[1] ?? 0)
  const planeMin = Math.min(...levels) - reach
  const planeMax = Math.max(...levels) + reach

  return details.filter((detail) => {
    if (detail.maxY < planeMin || detail.minY > planeMax) return false
    return polygonIntersectsRect(flat, detailFootprint(detail))
  })
}

/**
 * Собрать зону из захваченных деталей.
 *
 * Граница — выпуклая оболочка следов деталей: она плотнее общего
 * прямоугольника и не тянет зону на пустое место между разнесёнными
 * объектами. Основание кладётся на низ самой низкой детали, высота — до
 * верха самой высокой.
 */
export function buildSmartSector(
  polygon: number[][],
  details: DetailBounds[],
  options: SmartSelectOptions = {},
): SmartSelection | null {
  const captured = detailsInside(polygon, details, options)
  if (captured.length === 0) return null

  const corners: Vec2[] = []
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const detail of captured) {
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

  const hull = convexHull2D(corners)
  if (hull.length < 3) return null

  const minHeight = options.minHeight ?? 0.1
  const height = Math.max(minHeight, maxY - minY)

  return {
    // Основание чуть выше низа деталей — чтобы зона не тонула в плите.
    coordinates: hull.map(([x, z]) => [x, minY, z]),
    height,
    details: captured.map((detail) => detail.name),
  }
}
