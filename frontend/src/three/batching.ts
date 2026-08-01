/**
 * Слияние геометрии модели в «рендер-прокси».
 *
 * Выгрузка из Revit — это тысячи отдельных мешей, и каждый из них стоит
 * отдельного вызова отрисовки. На реальной модели объекта (5.5 тыс. деталей)
 * это давало 5554 вызова и ~26 мс процессорного времени на кадр: вращение
 * камеры превращалось в слайд-шоу, причём упиралось не в видеокарту (замер
 * при разном разрешении почти не менялся), а в накладные расходы на каждый
 * вызов.
 *
 * Простое слияние всего в один меш убило бы половину функциональности: по
 * отдельным деталям работают выбор элемента, снятие отметки этажа и «умное
 * выделение». Поэтому исходные меши остаются в сцене НЕВИДИМЫМИ — луч
 * выбора попадает в них по-прежнему (Raycaster не проверяет visible), а
 * рисуется вместо них горстка слитых мешей.
 *
 * Что сохраняется без изменений:
 *  • выбор детали кликом и её подсветка;
 *  • режим «рентгена» (приглушение модели);
 *  • снятие отметки Y для этажей;
 *  • «умное выделение» по габаритам деталей;
 *  • отсечение плоскостями этажей (материалы те же самые).
 */
import * as THREE from 'three'

/** Атрибуты, которые переносим в слитую геометрию. Прочие для отрисовки не нужны. */
const MERGEABLE_ATTRIBUTES = ['position', 'normal', 'uv', 'uv1', 'color'] as const

/**
 * Предел вершин на одну «пачку».
 *
 * Один буфер на всю модель означал бы, что она либо целиком в кадре, либо
 * целиком отсечена. Разбиение по бюджету сохраняет отсечение по пирамиде
 * видимости на крупных объектах и не даёт буферу вырасти до размеров, на
 * которых драйверы начинают капризничать.
 */
const VERTEX_BUDGET = 262_144

export interface RenderProxy {
  /** Группа со слитыми мешами — её и надо добавить в сцену. */
  readonly group: THREE.Group
  /** Сколько вызовов отрисовки осталось вместо исходного числа мешей. */
  readonly batchCount: number
  /** Приглушить всю модель либо вернуть исходные материалы. */
  setGhost(ghost: boolean): void
  /**
   * Подсветить детали поверх приглушённой модели (null или пустой список —
   * снять). Деталей может быть несколько: их набирают в режиме «Выделение
   * по деталям».
   */
  setHighlight(sources: THREE.Mesh | readonly THREE.Mesh[] | null): void
  dispose(): void
}

interface Bucket {
  material: THREE.Material
  attributes: string[]
  meshes: THREE.Mesh[]
  vertices: number
}

function isMesh(object: THREE.Object3D): object is THREE.Mesh {
  return (object as THREE.Mesh).isMesh === true
}

/** Подпись набора атрибутов: геометрии с разным набором в один буфер не сливаются. */
function attributeSignature(geometry: THREE.BufferGeometry): string[] {
  return MERGEABLE_ATTRIBUTES.filter((name) => geometry.getAttribute(name) !== undefined)
}

/**
 * Разложить меши по «пачкам»: один материал, один набор атрибутов, бюджет вершин.
 *
 * Меши с массивом материалов пропускаем — у них геометрия разбита на группы,
 * и слияние потребовало бы пересобирать эти группы. На выгрузках из САПР это
 * редкий случай, а рисоваться они продолжат как есть.
 */
function bucketize(meshes: THREE.Mesh[]): { buckets: Bucket[]; skipped: THREE.Mesh[] } {
  const buckets: Bucket[] = []
  const open = new Map<string, Bucket>()
  const skipped: THREE.Mesh[] = []

  for (const mesh of meshes) {
    const geometry = mesh.geometry
    const position = geometry?.getAttribute('position')
    if (!geometry || !position || position.count === 0) continue
    if (Array.isArray(mesh.material) || !mesh.material) {
      skipped.push(mesh)
      continue
    }

    const attributes = attributeSignature(geometry)
    const key = `${mesh.material.uuid}|${attributes.join(',')}`
    let bucket = open.get(key)
    if (bucket && bucket.vertices + position.count > VERTEX_BUDGET) {
      // Пачка переполнена — закрываем её и начинаем новую с тем же ключом.
      open.delete(key)
      bucket = undefined
    }
    if (!bucket) {
      bucket = { material: mesh.material, attributes, meshes: [], vertices: 0 }
      buckets.push(bucket)
      open.set(key, bucket)
    }
    bucket.meshes.push(mesh)
    bucket.vertices += position.count
  }

  return { buckets, skipped }
}

/**
 * Слить одну пачку в единую геометрию.
 *
 * Вершины пересчитываются в локальные координаты корня модели: слитый меш
 * подставляется вместо исходных, у которых были собственные матрицы.
 * Нормали идут через обратно-транспонированную матрицу — при неравномерном
 * масштабе, который в выгрузках попадается, обычное умножение их перекосит.
 */
function mergeBucket(bucket: Bucket, toLocal: THREE.Matrix4): THREE.Mesh | null {
  let vertexTotal = 0
  let indexTotal = 0
  for (const mesh of bucket.meshes) {
    const count = mesh.geometry.getAttribute('position').count
    vertexTotal += count
    indexTotal += mesh.geometry.index ? mesh.geometry.index.count : count
  }
  if (vertexTotal === 0) return null

  const itemSizes = new Map<string, number>()
  for (const name of bucket.attributes) {
    itemSizes.set(name, bucket.meshes[0].geometry.getAttribute(name).itemSize)
  }
  const buffers = new Map<string, Float32Array>()
  for (const [name, itemSize] of itemSizes) {
    buffers.set(name, new Float32Array(vertexTotal * itemSize))
  }
  const indices =
    vertexTotal > 65_535 ? new Uint32Array(indexTotal) : new Uint16Array(indexTotal)

  const matrix = new THREE.Matrix4()
  const normalMatrix = new THREE.Matrix3()
  const vector = new THREE.Vector3()
  let vertexOffset = 0
  let indexOffset = 0

  for (const mesh of bucket.meshes) {
    const geometry = mesh.geometry
    const position = geometry.getAttribute('position')
    matrix.multiplyMatrices(toLocal, mesh.matrixWorld)
    normalMatrix.getNormalMatrix(matrix)

    for (const [name, itemSize] of itemSizes) {
      const source = geometry.getAttribute(name)
      const target = buffers.get(name) as Float32Array
      const base = vertexOffset * itemSize
      if (name === 'position') {
        for (let i = 0; i < source.count; i += 1) {
          vector.set(source.getX(i), source.getY(i), source.getZ(i)).applyMatrix4(matrix)
          target[base + i * 3] = vector.x
          target[base + i * 3 + 1] = vector.y
          target[base + i * 3 + 2] = vector.z
        }
      } else if (name === 'normal') {
        for (let i = 0; i < source.count; i += 1) {
          vector
            .set(source.getX(i), source.getY(i), source.getZ(i))
            .applyMatrix3(normalMatrix)
            .normalize()
          target[base + i * 3] = vector.x
          target[base + i * 3 + 1] = vector.y
          target[base + i * 3 + 2] = vector.z
        }
      } else {
        for (let i = 0; i < source.count; i += 1) {
          for (let c = 0; c < itemSize; c += 1) {
            target[base + i * itemSize + c] = source.getComponent(i, c)
          }
        }
      }
    }

    const index = geometry.index
    const count = index ? index.count : position.count
    for (let i = 0; i < count; i += 1) {
      indices[indexOffset + i] = (index ? index.getX(i) : i) + vertexOffset
    }
    vertexOffset += position.count
    indexOffset += count
  }

  const merged = new THREE.BufferGeometry()
  for (const [name, itemSize] of itemSizes) {
    merged.setAttribute(name, new THREE.BufferAttribute(buffers.get(name) as Float32Array, itemSize))
  }
  merged.setIndex(new THREE.BufferAttribute(indices, 1))
  merged.computeBoundingBox()
  merged.computeBoundingSphere()

  const batch = new THREE.Mesh(merged, bucket.material)
  batch.name = 'batch'
  batch.matrixAutoUpdate = false
  batch.userData.sourceMaterial = bucket.material
  return batch
}

/** Материал подсветки выбранной детали — общий на все слои. */
let highlightMaterial: THREE.MeshStandardMaterial | null = null

function getHighlightMaterial(): THREE.MeshStandardMaterial {
  if (!highlightMaterial) {
    highlightMaterial = new THREE.MeshStandardMaterial({
      color: 0x2f81f7,
      emissive: 0x1b4f9c,
      emissiveIntensity: 0.55,
      roughness: 0.45,
      metalness: 0.05,
      side: THREE.DoubleSide,
      // Копия детали лежит и внутри слитого меша. Смещение по глубине выводит
      // подсветку вперёд, иначе полупрозрачный «призрак» ложился бы поверх неё
      // и выделение выглядело бы выцветшим.
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    })
  }
  return highlightMaterial
}

/** Приглушённый материал модели — общий на все слои. */
let ghostMaterial: THREE.MeshStandardMaterial | null = null

function getGhostMaterial(): THREE.MeshStandardMaterial {
  if (!ghostMaterial) {
    ghostMaterial = new THREE.MeshStandardMaterial({
      color: 0x8fa3b8,
      transparent: true,
      opacity: 0.1,
      depthWrite: false,
      roughness: 1,
      metalness: 0,
      side: THREE.DoubleSide,
    })
  }
  return ghostMaterial
}

/**
 * Построить рендер-прокси для загруженной модели.
 *
 * Возвращает null, если сливать нечего (пустая модель) — вызывающий тогда
 * рисует исходные меши как раньше.
 */
export function buildRenderProxy(root: THREE.Object3D): RenderProxy | null {
  root.updateMatrixWorld(true)

  const meshes: THREE.Mesh[] = []
  root.traverse((child) => {
    if (isMesh(child)) meshes.push(child)
  })
  if (meshes.length === 0) return null

  const { buckets, skipped } = bucketize(meshes)
  if (buckets.length === 0 && skipped.length === 0) return null

  const toLocal = root.matrixWorld.clone().invert()
  const group = new THREE.Group()
  group.name = 'render-proxy'
  // Прокси встаёт рядом с корнем в общем контейнере слоя, поэтому повторяет
  // его собственное преобразование — вершины пересчитаны в систему корня.
  group.matrixAutoUpdate = false
  group.matrix.copy(root.matrix)

  const batches: THREE.Mesh[] = []
  for (const bucket of buckets) {
    const batch = mergeBucket(bucket, toLocal)
    if (batch) {
      batches.push(batch)
      group.add(batch)
    }
  }

  // Меши с несколькими материалами слить нельзя — показываем их лёгкими
  // копиями: геометрия и материалы общие с оригиналом, своя только матрица.
  const clones: THREE.Mesh[] = []
  for (const mesh of skipped) {
    const clone = new THREE.Mesh(mesh.geometry, mesh.material)
    clone.matrixAutoUpdate = false
    clone.matrix.multiplyMatrices(toLocal, mesh.matrixWorld)
    clone.userData.sourceMaterial = mesh.material
    clones.push(clone)
    group.add(clone)
  }

  const drawn = [...batches, ...clones]
  let highlights: THREE.Mesh[] = []

  const setGhost = (ghost: boolean): void => {
    for (const mesh of drawn) {
      mesh.material = ghost
        ? getGhostMaterial()
        : (mesh.userData.sourceMaterial as THREE.Material | THREE.Material[])
    }
  }

  const setHighlight = (sources: THREE.Mesh | readonly THREE.Mesh[] | null): void => {
    for (const mesh of highlights) group.remove(mesh)
    highlights = []
    if (!sources) return

    const list = Array.isArray(sources) ? sources : [sources as THREE.Mesh]
    for (const source of list) {
      if (!source?.geometry) continue
      // Геометрия общая с оригиналом: подсветка не копирует данные, а лишь
      // рисует ту же деталь другим материалом на её месте.
      const mesh = new THREE.Mesh(source.geometry, getHighlightMaterial())
      mesh.name = 'highlight'
      mesh.matrixAutoUpdate = false
      mesh.matrix.multiplyMatrices(toLocal, source.matrixWorld)
      mesh.renderOrder = 3
      group.add(mesh)
      highlights.push(mesh)
    }
  }

  const dispose = (): void => {
    setHighlight(null)
    for (const batch of batches) batch.geometry.dispose()
    // Копии многоматериальных мешей делят геометрию с оригиналом — её
    // освобождает владелец, слой модели.
    group.clear()
  }

  return { group, batchCount: drawn.length, setGhost, setHighlight, dispose }
}
