/**
 * Общая точка доступа к объектам сцены.
 *
 * TresJS создаёт камеру и рендерер внутри <TresCanvas>, а HTML-слой с
 * 3D-виджетами и панель бригад живут снаружи канваса. Шина связывает их,
 * не протаскивая пропсы через всё дерево.
 */
import { shallowRef, ref } from 'vue'
import type * as THREE from 'three'

export const sceneCamera = shallowRef<THREE.PerspectiveCamera | null>(null)
export const sceneRenderer = shallowRef<THREE.WebGLRenderer | null>(null)
export const modelRoot = shallowRef<THREE.Object3D | null>(null)

/** Меши секторов — по ним ведётся raycast для клика и drag-and-drop. */
export const sectorMeshes = new Map<number, THREE.Mesh>()

/** Счётчик кадров: HTML-виджеты пересчитывают позиции по его изменению. */
export const frameTick = ref(0)

/** Сектор, над которым сейчас «висит» перетаскиваемая бригада. */
export const dragHoverSectorId = ref<number | null>(null)

/** Перетаскиваемая бригада (id) — общий контекст для drag-and-drop. */
export const draggingBrigadeId = ref<number | null>(null)

export function registerSectorMesh(id: number, mesh: THREE.Mesh | null): void {
  if (mesh) sectorMeshes.set(id, mesh)
  else sectorMeshes.delete(id)
}

export function resetSceneBus(): void {
  sceneCamera.value = null
  sceneRenderer.value = null
  modelRoot.value = null
  sectorMeshes.clear()
  dragHoverSectorId.value = null
  draggingBrigadeId.value = null
}
