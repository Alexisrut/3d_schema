<script setup lang="ts">
/**
 * Мост между TresJS и остальным приложением. Компонент ничего не рисует:
 * он живёт внутри <TresCanvas>, забирает камеру и рендерер из контекста и
 * берёт на себя всё императивное взаимодействие —
 *  • орбита / зум / панорамирование (п. 3.1 ТЗ);
 *  • raycast по модели для расстановки опорных точек (п. 3.3);
 *  • выбор сектора или элемента модели кликом (п. 3.2);
 *  • drag-and-drop бригады прямо на сектор в 3D (п. 3.4).
 */
import { onBeforeUnmount, onMounted, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { useTresContext } from '@tresjs/core'

import {
  draggingBrigadeId,
  dragHoverSectorId,
  frameTick,
  modelRoot,
  sceneCamera,
  sceneRenderer,
  sectorMeshes,
} from '@/three/sceneBus'
import { fitCameraToObject } from '@/three/ghosting'

const props = defineProps<{
  drawing: boolean
}>()

const emit = defineEmits<{
  (e: 'point', point: [number, number, number]): void
  (e: 'select-sector', sectorId: number): void
  (e: 'select-mesh', name: string): void
  (e: 'clear-selection'): void
  (e: 'drop-brigade', payload: { sectorId: number; brigadeId: number }): void
}>()

const { camera, renderer } = useTresContext()

const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()

let controls: OrbitControls | null = null
let canvasEl: HTMLCanvasElement | null = null
let rafId = 0
let frame = 0

// Отличаем клик от вращения камеры: считаем кликом короткое нажатие без сдвига.
let downX = 0
let downY = 0
let downAt = 0

function updatePointer(event: { clientX: number; clientY: number }): boolean {
  if (!canvasEl) return false
  const rect = canvasEl.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return false
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
  return true
}

function castAgainst(objects: THREE.Object3D[]): THREE.Intersection | null {
  const activeCamera = camera.value
  if (!activeCamera || objects.length === 0) return null
  raycaster.setFromCamera(pointer, activeCamera as THREE.Camera)
  const hits = raycaster.intersectObjects(objects, true)
  return hits.length > 0 ? hits[0] : null
}

function sectorMeshList(): THREE.Mesh[] {
  return Array.from(sectorMeshes.values())
}

function sectorIdFromObject(object: THREE.Object3D | null): number | null {
  let current: THREE.Object3D | null = object
  while (current) {
    const id = current.userData?.sectorId
    if (typeof id === 'number') return id
    current = current.parent
  }
  return null
}

function onPointerDown(event: PointerEvent): void {
  downX = event.clientX
  downY = event.clientY
  downAt = performance.now()
}

function onPointerUp(event: PointerEvent): void {
  if (event.button !== 0) return
  const moved = Math.hypot(event.clientX - downX, event.clientY - downY)
  if (moved > 5 || performance.now() - downAt > 600) return
  if (!updatePointer(event)) return

  // Режим разметки: ставим опорную точку в месте попадания луча по модели.
  if (props.drawing) {
    const target = modelRoot.value ? [modelRoot.value] : []
    const hit = castAgainst(target)
    if (hit) {
      emit('point', [hit.point.x, hit.point.y, hit.point.z])
    }
    return
  }

  // Обычный режим: считаем оба попадания и сравниваем глубину. Иначе клик по
  // фасаду, за которым спрятана зона на перекрытии, выделял бы невидимую зону.
  const sectorHit = castAgainst(sectorMeshList())
  const modelHit = modelRoot.value ? castAgainst([modelRoot.value]) : null

  const sectorId = sectorHit ? sectorIdFromObject(sectorHit.object) : null
  const sectorIsCloser =
    sectorHit !== null &&
    sectorId !== null &&
    (modelHit === null || sectorHit.distance <= modelHit.distance + 0.01)

  if (sectorIsCloser && sectorId !== null) {
    emit('select-sector', sectorId)
    return
  }

  if (modelHit) {
    emit('select-mesh', modelHit.object.name || modelHit.object.uuid)
    return
  }

  emit('clear-selection')
}

function onDragOver(event: DragEvent): void {
  if (draggingBrigadeId.value === null) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  if (!updatePointer(event)) return
  const hit = castAgainst(sectorMeshList())
  dragHoverSectorId.value = hit ? sectorIdFromObject(hit.object) : null
}

function onDragLeave(): void {
  dragHoverSectorId.value = null
}

function onDrop(event: DragEvent): void {
  event.preventDefault()
  const raw = event.dataTransfer?.getData('application/x-brigade-id') ?? ''
  const brigadeId = Number.parseInt(raw, 10)
  dragHoverSectorId.value = null
  draggingBrigadeId.value = null
  if (!Number.isFinite(brigadeId)) return
  if (!updatePointer(event)) return
  const hit = castAgainst(sectorMeshList())
  const sectorId = hit ? sectorIdFromObject(hit.object) : null
  if (sectorId !== null) emit('drop-brigade', { sectorId, brigadeId })
}

function attach(el: HTMLCanvasElement): void {
  canvasEl = el
  el.addEventListener('pointerdown', onPointerDown)
  el.addEventListener('pointerup', onPointerUp)
  el.addEventListener('dragover', onDragOver)
  el.addEventListener('dragleave', onDragLeave)
  el.addEventListener('drop', onDrop)
}

function detach(): void {
  if (!canvasEl) return
  canvasEl.removeEventListener('pointerdown', onPointerDown)
  canvasEl.removeEventListener('pointerup', onPointerUp)
  canvasEl.removeEventListener('dragover', onDragOver)
  canvasEl.removeEventListener('dragleave', onDragLeave)
  canvasEl.removeEventListener('drop', onDrop)
  canvasEl = null
}

function setupControls(): void {
  const activeCamera = camera.value as THREE.PerspectiveCamera | undefined
  const activeRenderer = renderer.value as THREE.WebGLRenderer | undefined
  if (!activeCamera || !activeRenderer) return

  sceneCamera.value = activeCamera
  sceneRenderer.value = activeRenderer

  if (!canvasEl) attach(activeRenderer.domElement)

  if (controls) controls.dispose()
  controls = new OrbitControls(activeCamera, activeRenderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.screenSpacePanning = true       // панорамирование правой кнопкой / двумя пальцами
  controls.maxPolarAngle = Math.PI * 0.495 // не даём «нырнуть» под землю
  controls.minDistance = 1
  controls.maxDistance = 5000
  controls.update()
}

function loop(): void {
  rafId = requestAnimationFrame(loop)
  controls?.update()
  frame += 1
  // Виджеты обновляем через кадр — этого достаточно и вдвое дешевле.
  if (frame % 2 === 0) frameTick.value = frame
}

watch(
  () => [camera.value, renderer.value],
  () => setupControls(),
  { immediate: true },
)

// Как только модель загрузилась — вписываем её в кадр.
watch(modelRoot, (root) => {
  const activeCamera = camera.value as THREE.PerspectiveCamera | undefined
  if (!root || !activeCamera || !controls) return
  const { target } = fitCameraToObject(activeCamera, root)
  controls.target.copy(target)
  controls.update()
})

onMounted(() => {
  setupControls()
  loop()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
  controls?.dispose()
  controls = null
  detach()
  sceneCamera.value = null
  sceneRenderer.value = null
})

defineExpose({
  resetView(): void {
    const activeCamera = camera.value as THREE.PerspectiveCamera | undefined
    if (!activeCamera || !modelRoot.value || !controls) return
    const { target } = fitCameraToObject(activeCamera, modelRoot.value)
    controls.target.copy(target)
    controls.update()
  },
})
</script>

<template>
  <!-- Компонент существует только ради побочных эффектов. -->
</template>
