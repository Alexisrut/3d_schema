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

/** Площадь многоугольника в 3D — для подписи зоны в интерфейсе. */
export function polygonArea3D(rawPoints: number[][]): number {
  const points = rawPoints.map(toVec3)
  if (points.length < 3) return 0
  const normal = polygonNormal(points)
  const origin = centroid(points)
  const { u, v } = planeBasis(normal)
  return Math.abs(signedArea(projectToPlane(points, origin, u, v)))
}

/** Точка, над которой висит 3D-виджет сектора. */
export function billboardAnchor(rawPoints: number[][], offset = 1.6): Vec3 {
  const points = rawPoints.map(toVec3)
  const center = centroid(points)
  return [center[0], center[1] + offset, center[2]]
}
