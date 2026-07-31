/**
 * Общая точка доступа к объектам сцены.
 *
 * TresJS создаёт камеру и рендерер внутри <TresCanvas>, а HTML-слой с
 * 3D-виджетами и панели живут снаружи канваса. Шина связывает их,
 * не протаскивая пропсы через всё дерево.
 */
import { computed, shallowRef, ref } from 'vue'
import type * as THREE from 'three'

export const sceneCamera = shallowRef<THREE.PerspectiveCamera | null>(null)
export const sceneRenderer = shallowRef<THREE.WebGLRenderer | null>(null)

/**
 * Корни загруженных .glb — по одному на слой сцены.
 *
 * Список, а не единственный объект: моделей на объекте несколько (АР, КЖ,
 * инженерия), и по ним всем ведётся raycast, а камера вписывает их сумму.
 * Хранится как обычный массив в shallowRef: слои меняются редко, а
 * подписчикам нужна именно замена ссылки.
 */
export const modelRoots = shallowRef<THREE.Object3D[]>([])

/** Первый слой — для мест, где нужна «какая-нибудь» модель. */
export const primaryModelRoot = computed(() => modelRoots.value[0] ?? null)

/** Загружен ли хотя бы один слой. */
export const hasModel = computed(() => modelRoots.value.length > 0)

/** Меши секторов — по ним ведётся raycast для клика и drag-and-drop. */
export const sectorMeshes = new Map<number, THREE.Mesh>()

/** Маркеры вершин активной зоны — цели перетаскивания границ. */
export const vertexHandles = new Map<string, THREE.Mesh>()

/** Счётчик кадров: HTML-виджеты пересчитывают позиции по его изменению. */
export const frameTick = ref(0)

// --------------------------------------------------------------- кадровый цикл
/**
 * Единый requestAnimationFrame на всю сцену.
 *
 * Цикл живёт в шине, а не в компоненте, потому что TresJS пересоздаёт
 * содержимое <TresCanvas> при изменении графа сцены (например, когда
 * догружается очередной слой .glb), и экземпляров моста может оказаться
 * несколько. Пока цикл принадлежал компоненту, уход одного экземпляра
 * останавливал кадры для всех остальных: 3D-виджеты замирали на месте, а
 * сглаживание камеры переставало обновляться.
 *
 * Подписчики (обычно один — обновление OrbitControls) считаются по
 * ссылкам: цикл идёт, пока есть хоть один.
 */
const frameCallbacks = new Set<() => void>()
let frameLoopId = 0
let frameCounter = 0

function runFrameLoop(): void {
  frameLoopId = requestAnimationFrame(runFrameLoop)
  for (const callback of frameCallbacks) {
    try {
      callback()
    } catch (error) {
      // Один сбойный подписчик не должен останавливать счётчик кадров:
      // на нём держатся позиции 3D-виджетов, и «замерзали» бы они все.
      console.error('Ошибка в кадровом обработчике сцены', error)
    }
  }
  frameCounter += 1
  // Виджеты обновляем через кадр — этого достаточно и вдвое дешевле.
  if (frameCounter % 2 === 0) frameTick.value = frameCounter
}

/** Подписаться на кадры. Возвращает функцию отписки. */
export function onFrame(callback: () => void): () => void {
  frameCallbacks.add(callback)
  if (frameLoopId === 0) runFrameLoop()
  return () => {
    frameCallbacks.delete(callback)
    if (frameCallbacks.size === 0 && frameLoopId !== 0) {
      cancelAnimationFrame(frameLoopId)
      frameLoopId = 0
    }
  }
}

/** Сектор, над которым сейчас «висит» перетаскиваемая бригада. */
export const dragHoverSectorId = ref<number | null>(null)

/** Перетаскиваемая бригада (id) — общий контекст для drag-and-drop. */
export const draggingBrigadeId = ref<number | null>(null)

/** Какое кольцо маркеров: основание зоны или её верхняя грань. */
export type VertexRing = 'base' | 'top'

/**
 * Вершина, которую сейчас тащат: `{ sectorId, index, ring }` либо null.
 *
 * Пока она задана, орбита камеры отключена — иначе перетаскивание маркера
 * одновременно вращало бы сцену.
 */
export const draggingVertex = ref<{
  sectorId: number
  index: number
  ring: VertexRing
} | null>(null)

/** Вершина под курсором — подсвечивается, чтобы было видно, за что тянуть. */
export const hoveredVertexKey = ref<string | null>(null)

export function vertexKey(sectorId: number, index: number, ring: VertexRing = 'base'): string {
  return `${sectorId}:${ring}:${index}`
}

/**
 * Опубликовать камеру и рендерер сцены.
 *
 * Раздельные функции публикации и снятия нужны из-за порядка, в котором Vue
 * пересоздаёт компоненты: новый экземпляр монтируется ДО того, как старый
 * размонтируется. Если снимать значения безусловно, уходящий компонент
 * обнуляет то, что уже опубликовал пришедший, — и HTML-слой 3D-виджетов
 * остаётся с пустой камерой навсегда. Поэтому снимаем только своё.
 */
export function publishRenderer(
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGLRenderer,
): void {
  sceneCamera.value = camera
  sceneRenderer.value = renderer
}

export function retireRenderer(
  camera: THREE.PerspectiveCamera | null,
  renderer: THREE.WebGLRenderer | null,
): void {
  if (camera && sceneCamera.value === camera) sceneCamera.value = null
  if (renderer && sceneRenderer.value === renderer) sceneRenderer.value = null
}

export function registerSectorMesh(id: number, mesh: THREE.Mesh | null): void {
  if (mesh) sectorMeshes.set(id, mesh)
  else sectorMeshes.delete(id)
}

export function registerVertexHandle(key: string, mesh: THREE.Mesh | null): void {
  if (mesh) vertexHandles.set(key, mesh)
  else vertexHandles.delete(key)
}

export function clearVertexHandles(): void {
  vertexHandles.clear()
  hoveredVertexKey.value = null
}

export function registerModelRoot(root: THREE.Object3D | null, previous?: THREE.Object3D | null): void {
  const next = previous
    ? modelRoots.value.filter((item) => item !== previous)
    : [...modelRoots.value]
  if (root && !next.includes(root)) next.push(root)
  modelRoots.value = next
}

export function unregisterModelRoot(root: THREE.Object3D | null): void {
  if (!root) return
  modelRoots.value = modelRoots.value.filter((item) => item !== root)
}

export function resetSceneBus(): void {
  frameCallbacks.clear()
  if (frameLoopId !== 0) {
    cancelAnimationFrame(frameLoopId)
    frameLoopId = 0
  }
  sceneCamera.value = null
  sceneRenderer.value = null
  modelRoots.value = []
  sectorMeshes.clear()
  vertexHandles.clear()
  dragHoverSectorId.value = null
  draggingBrigadeId.value = null
  draggingVertex.value = null
  hoveredVertexKey.value = null
}
