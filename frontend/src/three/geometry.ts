/**
 * Чистая геометрия разметки зон — без импорта three.js, чтобы модуль можно было
 * прогнать тестами в Node.
 *
 * Задача: пользователь расставил произвольное число точек поверх .glb-модели;
 * из них нужно получить плоский многоугольник (в том числе невыпуклый),
 * который ляжет на модель как отдельный mesh.
 */

export type Vec3 = [number, number, number]
export type Vec2 = [number, number]

const EPS = 1e-9

export function toVec3(point: number[]): Vec3 {
  return [point[0] ?? 0, point[1] ?? 0, point[2] ?? 0]
}

export function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

export function length(a: Vec3): number {
  return Math.sqrt(dot(a, a))
}

export function normalize(a: Vec3): Vec3 {
  const len = length(a)
  if (len < EPS) return [0, 1, 0]
  return [a[0] / len, a[1] / len, a[2] / len]
}

/**
 * Нормаль многоугольника по методу Ньюэлла — устойчива к тому, что клики
 * пользователя никогда не лежат идеально в одной плоскости.
 *
 * Знак нормали приводится к «наружу от здания»: для горизонтальных зон
 * (перекрытия, кровля) она всегда смотрит вверх, независимо от того, в какую
 * сторону пользователь обходил контур. Это нужно, чтобы подъём полигона над
 * поверхностью происходил в сторону наблюдателя, а не внутрь плиты.
 */
export function polygonNormal(points: Vec3[]): Vec3 {
  let nx = 0
  let ny = 0
  let nz = 0
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i]
    const next = points[(i + 1) % points.length]
    nx += (current[1] - next[1]) * (current[2] + next[2])
    ny += (current[2] - next[2]) * (current[0] + next[0])
    nz += (current[0] - next[0]) * (current[1] + next[1])
  }
  const n = normalize([nx, ny, nz])
  return n[1] < -EPS ? [-n[0], -n[1], -n[2]] : n
}

/** Ортонормированный базис в плоскости с заданной нормалью. */
export function planeBasis(normal: Vec3): { u: Vec3; v: Vec3 } {
  const n = normalize(normal)
  // Опорная ось, заведомо не коллинеарная нормали.
  const helper: Vec3 = Math.abs(n[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]
  const u = normalize(cross(helper, n))
  const v = normalize(cross(n, u))
  return { u, v }
}

export function centroid(points: Vec3[]): Vec3 {
  if (points.length === 0) return [0, 0, 0]
  const sum = points.reduce<Vec3>(
    (acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]],
    [0, 0, 0],
  )
  return [sum[0] / points.length, sum[1] / points.length, sum[2] / points.length]
}

export function projectToPlane(points: Vec3[], origin: Vec3, u: Vec3, v: Vec3): Vec2[] {
  return points.map((p) => {
    const d = subtract(p, origin)
    return [dot(d, u), dot(d, v)] as Vec2
  })
}

export function signedArea(points: Vec2[]): number {
  let area = 0
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    area += a[0] * b[1] - b[0] * a[1]
  }
  return area / 2
}

function triangleArea2(a: Vec2, b: Vec2, c: Vec2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const d1 = triangleArea2(p, a, b)
  const d2 = triangleArea2(p, b, c)
  const d3 = triangleArea2(p, c, a)
  const hasNeg = d1 < -EPS || d2 < -EPS || d3 < -EPS
  const hasPos = d1 > EPS || d2 > EPS || d3 > EPS
  return !(hasNeg && hasPos)
}

/**
 * Триангуляция простого многоугольника методом отсечения ушей.
 * Работает и с невыпуклыми контурами — ТЗ разрешает «сложные формы».
 * Возвращает плоский список индексов исходных точек (по 3 на треугольник).
 */
export function triangulate2D(points: Vec2[]): number[] {
  const count = points.length
  if (count < 3) return []

  // Приводим контур к обходу против часовой стрелки.
  let order = points.map((_, i) => i)
  if (signedArea(points) < 0) order = order.reverse()

  const indices: number[] = []
  const remaining = [...order]
  let guard = 0
  const maxIterations = count * count + 16

  while (remaining.length > 3 && guard < maxIterations) {
    guard += 1
    let earFound = false

    for (let i = 0; i < remaining.length; i += 1) {
      const prevIndex = remaining[(i - 1 + remaining.length) % remaining.length]
      const currIndex = remaining[i]
      const nextIndex = remaining[(i + 1) % remaining.length]

      const a = points[prevIndex]
      const b = points[currIndex]
      const c = points[nextIndex]

      // Выпуклая вершина? (обход CCW => площадь > 0)
      if (triangleArea2(a, b, c) <= EPS) continue

      // Не содержит ли треугольник другие вершины контура?
      let contains = false
      for (const other of remaining) {
        if (other === prevIndex || other === currIndex || other === nextIndex) continue
        if (pointInTriangle(points[other], a, b, c)) {
          contains = true
          break
        }
      }
      if (contains) continue

      indices.push(prevIndex, currIndex, nextIndex)
      remaining.splice(i, 1)
      earFound = true
      break
    }

    if (!earFound) {
      // Вырожденный или самопересекающийся контур — отрезаем «на глаз»,
      // чтобы пользователь всё равно увидел зону, а не пустоту.
      const prevIndex = remaining[remaining.length - 1]
      const currIndex = remaining[0]
      const nextIndex = remaining[1]
      indices.push(prevIndex, currIndex, nextIndex)
      remaining.splice(0, 1)
    }
  }

  if (remaining.length === 3) {
    indices.push(remaining[0], remaining[1], remaining[2])
  }

  return indices
}

export interface PolygonGeometryData {
  /** Плоский массив координат вершин (x, y, z, x, y, z, ...). */
  positions: Float32Array
  /** Индексы треугольников. */
  indices: number[]
  normal: Vec3
  centroid: Vec3
}

/**
 * Из опорных точек пользователя — данные для THREE.BufferGeometry.
 * Точки слегка приподнимаются вдоль нормали, чтобы зона не «мерцала»
 * на поверхности плиты (z-fighting).
 */
export function buildPolygonGeometry(rawPoints: number[][], lift = 0.05): PolygonGeometryData {
  const points = rawPoints.map(toVec3)
  const normal = polygonNormal(points)
  const origin = centroid(points)
  const { u, v } = planeBasis(normal)
  const flat = projectToPlane(points, origin, u, v)
  const indices = triangulate2D(flat)

  const positions = new Float32Array(points.length * 3)
  points.forEach((p, i) => {
    positions[i * 3] = p[0] + normal[0] * lift
    positions[i * 3 + 1] = p[1] + normal[1] * lift
    positions[i * 3 + 2] = p[2] + normal[2] * lift
  })

  return { positions, indices, normal, centroid: origin }
}

/** Вертикаль мира: вдоль неё выдавливается объём зоны (шаг 2 разметки). */
export const UP: Vec3 = [0, 1, 0]

/**
 * Объём зоны: основание, выдавленное вертикально на `height`.
 *
 * Возвращает замкнутую призму — низ, верх и боковые стенки, — чтобы зона
 * охватывала настоящее 3D-пространство этажа, а не только его пол.
 * При height <= 0 вырождается в плоский полигон: так выглядят все зоны,
 * созданные до появления объёма, и переключение туда-обратно не требует
 * отдельной ветки в вызывающем коде.
 */
export function buildPrismGeometry(
  rawPoints: number[][],
  height: number,
  lift = 0.05,
  /**
   * Верхняя грань, если её вершины двигали вручную (п. 3.3 доработок).
   * Должна содержать столько же точек, сколько основание, иначе боковины
   * не сойдутся — при несовпадении молча возвращаемся к ровному выдавливанию.
   */
  topPoints?: number[][] | null,
): PolygonGeometryData {
  const flatData = buildPolygonGeometry(rawPoints, lift)
  const custom =
    topPoints && topPoints.length === rawPoints.length && rawPoints.length >= 3
      ? topPoints
      : null
  if (!custom && (!(height > 0) || rawPoints.length < 3)) return flatData

  const points = rawPoints.map(toVec3)
  const count = rawPoints.length
  const base = flatData.positions
  const positions = new Float32Array(count * 6)

  // Низ — уже приподнятое основание. Верх — либо заданный вручную контур,
  // либо основание, смещённое по вертикали на высоту.
  positions.set(base, 0)
  for (let i = 0; i < count; i += 1) {
    if (custom) {
      const point = toVec3(custom[i])
      positions[count * 3 + i * 3] = point[0]
      positions[count * 3 + i * 3 + 1] = point[1]
      positions[count * 3 + i * 3 + 2] = point[2]
    } else {
      positions[count * 3 + i * 3] = base[i * 3] + UP[0] * height
      positions[count * 3 + i * 3 + 1] = base[i * 3 + 1] + UP[1] * height
      positions[count * 3 + i * 3 + 2] = base[i * 3 + 2] + UP[2] * height
    }
  }

  const indices: number[] = []

  // Триангуляция основания всегда смотрит «вверх», в сторону нормали:
  // triangulate2D приводит контур к обходу против часовой стрелки в базисе
  // (u, v), а этот базис правый — cross(u, v) === n, — а сама нормаль
  // приведена к неотрицательному Y в polygonNormal. Поэтому направление
  // граней здесь не нужно измерять: оно известно заранее.
  //
  // Верх: та же триангуляция, сдвинутая на слой вершин, — смотрит вверх.
  for (const index of flatData.indices) indices.push(index + count)
  // Низ: тот же обход в обратном порядке — смотрит вниз, наружу призмы.
  for (let i = 0; i < flatData.indices.length; i += 3) {
    indices.push(flatData.indices[i + 2], flatData.indices[i + 1], flatData.indices[i])
  }

  // Боковины: по два треугольника на ребро. Куда смотрит стенка, задаёт
  // направление обхода основания, а не базис проекции, — поэтому знак
  // площади в плоскости XZ приходится учитывать отдельно. При
  // положительном знаке порядок (i, next, next+count) даёт нормаль ВНУТРЬ
  // призмы, и его нужно развернуть; иначе освещение стенок окажется
  // вывернутым, а расчёт объёма по такому мешу — неверным.
  const clockwiseFromAbove = footprintSignedArea(points) > 0
  for (let i = 0; i < count; i += 1) {
    const next = (i + 1) % count
    if (clockwiseFromAbove) {
      indices.push(i, i + count, next)
      indices.push(i + count, next + count, next)
    } else {
      indices.push(i, next, next + count)
      indices.push(i, next + count, i + count)
    }
  }

  return {
    positions,
    indices,
    normal: flatData.normal,
    centroid: flatData.centroid,
  }
}

/**
 * Знаковая площадь основания в плоскости XZ.
 *
 * Знак — это направление обхода контура, если смотреть на объект сверху;
 * от него зависит, куда повёрнуты боковые грани объёма.
 */
export function footprintSignedArea(points: Vec3[]): number {
  if (points.length < 3) return 0
  return signedArea(points.map((p) => [p[0], p[2]] as Vec2))
}

/**
 * Площадь основания в горизонтальной проекции — множитель объёма.
 *
 * Считается именно проекция на плоскость XZ, а не площадь наклонного
 * основания: выдавливание идёт вертикально, и объём наклонной призмы равен
 * площади её «тени», умноженной на высоту.
 */
export function footprintArea(rawPoints: number[][]): number {
  return Math.abs(footprintSignedArea(rawPoints.map(toVec3)))
}

/**
 * Объём зоны в м³ — для карточки. При height = 0 равен нулю.
 *
 * С правленой верхней гранью берётся средняя высота по вершинам: точный
 * объём наклонного тела считать незачем, а «средняя высота × след» даёт
 * цифру, которая не спорит с тем, что видит пользователь.
 */
export function prismVolume(
  rawPoints: number[][],
  height: number,
  topPoints?: number[][] | null,
): number {
  const area = footprintArea(rawPoints)
  if (topPoints && topPoints.length === rawPoints.length && rawPoints.length >= 3) {
    const base = rawPoints.map(toVec3)
    const top = topPoints.map(toVec3)
    const sum = base.reduce((acc, point, i) => acc + Math.max(0, top[i][1] - point[1]), 0)
    return area * (sum / base.length)
  }
  if (!(height > 0)) return 0
  return area * height
}

/** Верхняя грань по умолчанию: основание, поднятое на высоту. */
export function defaultTopPoints(rawPoints: number[][], height: number): number[][] {
  return rawPoints.map((point) => [point[0], (point[1] ?? 0) + height, point[2]])
}

// ------------------------------------------- плоские операции для выделения
/**
 * Точка внутри многоугольника? Проверка лучом (ray casting) в плоскости XZ.
 *
 * Нужна «магическому выделению»: деталь считается попавшей в область, если
 * её след пересекается с обведённым контуром.
 */
export function pointInPolygon2D(point: Vec2, polygon: Vec2[]): boolean {
  if (polygon.length < 3) return false
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    // Луч вправо от точки: считаем пересечения рёбер.
    const crosses = yi > point[1] !== yj > point[1]
    if (!crosses) continue
    const x = xi + ((point[1] - yi) / (yj - yi)) * (xj - xi)
    if (point[0] < x) inside = !inside
  }
  return inside
}

/** Пересекаются ли отрезки AB и CD (включая касание). */
export function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const orient = (p: Vec2, q: Vec2, r: Vec2): number => {
    const value = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    if (Math.abs(value) < EPS) return 0
    return value > 0 ? 1 : -1
  }
  const onSegment = (p: Vec2, q: Vec2, r: Vec2): boolean =>
    Math.min(p[0], r[0]) - EPS <= q[0] &&
    q[0] <= Math.max(p[0], r[0]) + EPS &&
    Math.min(p[1], r[1]) - EPS <= q[1] &&
    q[1] <= Math.max(p[1], r[1]) + EPS

  const o1 = orient(a, b, c)
  const o2 = orient(a, b, d)
  const o3 = orient(c, d, a)
  const o4 = orient(c, d, b)

  if (o1 !== o2 && o3 !== o4) return true
  // Вырожденные случаи: коллинеарные отрезки, касание концом.
  if (o1 === 0 && onSegment(a, c, b)) return true
  if (o2 === 0 && onSegment(a, d, b)) return true
  if (o3 === 0 && onSegment(c, a, d)) return true
  if (o4 === 0 && onSegment(c, b, d)) return true
  return false
}

/** Прямоугольник в плоскости XZ — след детали модели. */
export interface Rect2 {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function rectCorners(rect: Rect2): Vec2[] {
  return [
    [rect.minX, rect.minY],
    [rect.maxX, rect.minY],
    [rect.maxX, rect.maxY],
    [rect.minX, rect.maxY],
  ]
}

/**
 * Пересекается ли след детали с обведённым контуром.
 *
 * Проверяются все три случая: угол прямоугольника внутри контура, вершина
 * контура внутри прямоугольника (контур целиком внутри детали) и пересечение
 * рёбер. Достаточно одного — деталь захватывается ЦЕЛИКОМ, даже если попала
 * в область краем: в этом и смысл «магического выделения».
 */
export function polygonIntersectsRect(polygon: Vec2[], rect: Rect2): boolean {
  if (polygon.length < 3) return false
  const corners = rectCorners(rect)

  for (const corner of corners) {
    if (pointInPolygon2D(corner, polygon)) return true
  }
  for (const vertex of polygon) {
    if (
      vertex[0] >= rect.minX - EPS &&
      vertex[0] <= rect.maxX + EPS &&
      vertex[1] >= rect.minY - EPS &&
      vertex[1] <= rect.maxY + EPS
    ) {
      return true
    }
  }
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]
    const b = polygon[(i + 1) % polygon.length]
    for (let j = 0; j < corners.length; j += 1) {
      const c = corners[j]
      const d = corners[(j + 1) % corners.length]
      if (segmentsIntersect(a, b, c, d)) return true
    }
  }
  return false
}

/**
 * Выпуклая оболочка набора точек (обход Эндрю).
 *
 * «Магическое выделение» строит из следов захваченных деталей один контур.
 * Оболочка, а не общий прямоугольник: она плотнее облегает набор и не тянет
 * зону на пустое место между разнесёнными деталями по диагонали.
 */
export function convexHull2D(points: Vec2[]): Vec2[] {
  const unique = dedupePoints(points)
  if (unique.length < 3) return unique

  const sorted = [...unique].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: Vec2, a: Vec2, b: Vec2): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

  const build = (source: Vec2[]): Vec2[] => {
    const chain: Vec2[] = []
    for (const point of source) {
      while (
        chain.length >= 2 &&
        cross(chain[chain.length - 2], chain[chain.length - 1], point) <= EPS
      ) {
        chain.pop()
      }
      chain.push(point)
    }
    chain.pop() // последняя точка повторится во второй половине обхода
    return chain
  }

  const hull = [...build(sorted), ...build([...sorted].reverse())]
  return hull.length >= 3 ? hull : unique
}

function dedupePoints(points: Vec2[]): Vec2[] {
  const seen = new Set<string>()
  const result: Vec2[] = []
  for (const point of points) {
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue
    // Округление до миллиметра: координаты из модели приходят с плавающим
    // хвостом, и без него оболочка обрастает дублями-соседями.
    const key = `${point[0].toFixed(3)}:${point[1].toFixed(3)}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(point)
  }
  return result
}

/**
 * Пересечение луча с плоскостью — основа перетаскивания вершин зоны.
 *
 * Вершину нельзя двигать «куда попало»: она обязана остаться в плоскости
 * своего полигона, иначе зона перестанет быть плоской и триангуляция
 * поплывёт. Поэтому экранный луч курсора пересекается с этой плоскостью.
 *
 * Возвращает null, если луч плоскости параллелен или уходит от неё назад.
 */
export function rayPlaneIntersection(
  origin: Vec3,
  direction: Vec3,
  planePoint: Vec3,
  planeNormal: Vec3,
): Vec3 | null {
  const n = normalize(planeNormal)
  const denominator = dot(n, direction)
  if (Math.abs(denominator) < 1e-6) return null
  const t = dot(n, subtract(planePoint, origin)) / denominator
  if (t <= 0) return null
  return [
    origin[0] + direction[0] * t,
    origin[1] + direction[1] * t,
    origin[2] + direction[2] * t,
  ]
}

/** Площадь многоугольника в 3D — для подписи зоны в интерфейсе. */
export function polygonArea3D(rawPoints: number[][]): number {
  const points = rawPoints.map(toVec3)
  if (points.length < 3) return 0
  const normal = polygonNormal(points)
  const origin = centroid(points)
  const { u, v } = planeBasis(normal)
  return Math.abs(signedArea(projectToPlane(points, origin, u, v)))
}

/**
 * Точка, над которой висит 3D-виджет сектора.
 *
 * У зоны с объёмом виджет поднимается над её верхней гранью, а не над
 * основанием: иначе поп-ап оказывался бы внутри самой призмы.
 */
export function billboardAnchor(rawPoints: number[][], offset = 1.6, height = 0): Vec3 {
  const points = rawPoints.map(toVec3)
  const center = centroid(points)
  const top = height > 0 ? height : 0
  return [center[0], center[1] + top + offset, center[2]]
}
