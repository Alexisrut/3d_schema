<script setup lang="ts">
/**
 * Мост между TresJS и остальным приложением. Компонент ничего не рисует:
 * он живёт внутри <TresCanvas>, забирает камеру и рендерер из контекста и
 * берёт на себя всё императивное взаимодействие —
 *  • орбита / зум / панорамирование (п. 3.1 ТЗ);
 *  • raycast по модели для расстановки опорных точек (п. 3.3);
 *  • выбор зоны или элемента модели кликом, в том числе Shift/Ctrl (п. 2.1);
 *  • перетаскивание вершин зоны в режиме редактирования (п. 1.2);
 *  • drag-and-drop бригады прямо на зону в 3D (п. 3.4).
 */
import { onBeforeUnmount, onMounted, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { useTresContext } from '@tresjs/core'

import {
  configureControls,
  zoomScaleFromWheel,
  zoomTowardPoint,
  type Point3,
} from '@/three/controls'
import { rayPlaneIntersection, type Vec3 } from '@/three/geometry'
import { modeFromEvent, type SelectMode } from '@/lib/selection'
import {
  bindInvalidate,
  bumpFrameTick,
  draggingBrigadeId,
  draggingVertex,
  dragHoverSectorId,
  hoveredVertexKey,
  modelRoots,
  invalidateScene,
  onFrame,
  publishRenderer,
  retireRenderer,
  sectorMeshes,
  vertexHandles,
  type VertexRing,
} from '@/three/sceneBus'
import { fitCameraToObjects } from '@/three/ghosting'

const props = defineProps<{
  drawing: boolean
  /** Режим правки границ: клик по маркеру начинает перетаскивание. */
  editMode: boolean
  /** Нижняя граница показа по оси Y; null — без ограничения. */
  clipMin?: number | null
  /** Верхняя граница показа по оси Y; null — без ограничения. */
  clipMax?: number | null
}>()

const emit = defineEmits<{
  (e: 'point', point: [number, number, number]): void
  (e: 'select-sector', payload: { sectorId: number; mode: SelectMode }): void
  (e: 'select-mesh', name: string): void
  /** Отметка выбранной детали по оси Y — предложение для нового этажа. */
  (e: 'pick-elevation', elevation: number): void
  (e: 'clear-selection'): void
  (e: 'drop-brigade', payload: { sectorId: number; brigadeId: number }): void
  (
    e: 'vertex-move',
    payload: {
      sectorId: number
      index: number
      ring: VertexRing
      point: [number, number, number]
    },
  ): void
  (e: 'vertex-commit', payload: { sectorId: number; ring: VertexRing }): void
}>()

/**
 * TresJS пересоздаёт содержимое <TresCanvas> при изменении графа сцены —
 * например, когда догружается очередной слой .glb. Компонент при этом
 * монтируется заново, а прежний экземпляр не всегда размонтируется.
 *
 * Экземпляров может оказаться несколько, а канвас, камера и рендерер у них
 * общие. Поэтому активным считается последний смонтированный: он снимает
 * слушатели и кадровый цикл предыдущего. Иначе один клик обрабатывался бы
 * столько раз, сколько накопилось экземпляров (и ставил бы столько же
 * опорных точек), а в фоне крутились бы лишние requestAnimationFrame.
 */
let releaseActive: (() => void) | null = null

const { camera, renderer, scene, invalidate } = useTresContext()

const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()

let controls: OrbitControls | null = null
let canvasEl: HTMLCanvasElement | null = null
/** Отписка от общего кадрового цикла. */
let stopFrames: (() => void) | null = null
/** Камера уже вписана в модель? Повторно вид не сбрасываем. */
let framedRoots = 0
/** Что этот экземпляр опубликовал на шине — только это он и снимает. */
let published: { camera: THREE.PerspectiveCamera; renderer: THREE.WebGLRenderer } | null = null

// Отличаем клик от вращения камеры: считаем кликом короткое нажатие без сдвига.
let downX = 0
let downY = 0
let downAt = 0
/** Тянем вершину: плоскость её зоны и признак, что это был не клик. */
let dragPlane: { point: Vec3; normal: Vec3 } | null = null
let dragMoved = false
let capturedPointerId: number | null = null

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
  return Array.from(sectorMeshes.values()).filter((mesh) => mesh.visible)
}

function handleList(): THREE.Mesh[] {
  return Array.from(vertexHandles.values())
}

function modelList(): THREE.Object3D[] {
  return modelRoots.value
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

// -------------------------------------------------- зум к точке под курсором
/**
 * Точка, к которой приближает колесо.
 *
 * Сначала ищем реальную геометрию под курсором — модель или зону. Если под
 * курсором пусто (небо, фон), берём точку на плоскости, проходящей через
 * текущую цель перпендикулярно взгляду: зум тогда ведёт себя как обычный,
 * но в сторону курсора, а не «прыгает» в центр сцены.
 */
/**
 * Кэш точки под курсором на время одного жеста прокрутки.
 *
 * Луч по модели из тысяч деталей стоит несколько миллисекунд, а тачпад шлёт
 * десятки событий в секунду — на тяжёлой выгрузке зум ощутимо запаздывал.
 * Пересчитывать не нужно: смысл зума к курсору в том, что точка под
 * курсором остаётся на месте, поэтому пока курсор стоит, якорь тот же.
 * Кэш сбрасывается при сдвиге курсора и по паузе — сцена могла измениться.
 */
let anchorCache: { x: number; y: number; at: number; point: Point3 } | null = null
const ANCHOR_CACHE_MS = 400
const ANCHOR_CACHE_PX = 4

function anchorUnderCursor(activeCamera: THREE.Camera, screenX: number, screenY: number): Point3 | null {
  const now = performance.now()
  if (
    anchorCache &&
    now - anchorCache.at < ANCHOR_CACHE_MS &&
    Math.abs(anchorCache.x - screenX) <= ANCHOR_CACHE_PX &&
    Math.abs(anchorCache.y - screenY) <= ANCHOR_CACHE_PX
  ) {
    anchorCache.at = now
    return anchorCache.point
  }

  const hit = castAgainst([...modelList(), ...sectorMeshList()])
  if (hit) {
    const point: Point3 = [hit.point.x, hit.point.y, hit.point.z]
    anchorCache = { x: screenX, y: screenY, at: now, point }
    return point
  }

  if (!controls) return null
  // castAgainst уже выставил луч из курсора; переиспользуем его.
  raycaster.setFromCamera(pointer, activeCamera)
  const origin = raycaster.ray.origin
  const direction = raycaster.ray.direction
  const view = new THREE.Vector3()
  activeCamera.getWorldDirection(view)
  const targetPoint = controls.target
  const fallback = rayPlaneIntersection(
    [origin.x, origin.y, origin.z],
    [direction.x, direction.y, direction.z],
    [targetPoint.x, targetPoint.y, targetPoint.z],
    [view.x, view.y, view.z],
  )
  if (fallback) anchorCache = { x: screenX, y: screenY, at: now, point: fallback }
  return fallback
}

function onWheel(event: WheelEvent): void {
  const activeCamera = camera.value as THREE.PerspectiveCamera | undefined
  // controls.enabled снят на время перетаскивания вершины — колесо тогда
  // тоже не должно двигать камеру.
  if (!controls || !controls.enabled || !activeCamera) return

  // Событие перехвачено у родителя в фазе перехвата: и страница не
  // прокручивается, и собственный обработчик OrbitControls его не увидит,
  // иначе зум применился бы дважды — к курсору и к центру.
  event.preventDefault()
  event.stopPropagation()

  if (!updatePointer(event)) return

  const anchor = anchorUnderCursor(activeCamera, event.clientX, event.clientY)
  if (!anchor) return

  const next = zoomTowardPoint({
    cameraPosition: [
      activeCamera.position.x,
      activeCamera.position.y,
      activeCamera.position.z,
    ],
    target: [controls.target.x, controls.target.y, controls.target.z],
    anchor,
    scale: zoomScaleFromWheel(event.deltaY, event.deltaMode),
    minDistance: controls.minDistance,
    maxDistance: controls.maxDistance,
  })

  activeCamera.position.set(next.position[0], next.position[1], next.position[2])
  controls.target.set(next.target[0], next.target[1], next.target[2])
  controls.update()
  invalidateScene()
  bumpFrameTick()
}

// ------------------------------------------------------- перетаскивание вершин
function beginVertexDrag(event: PointerEvent): boolean {
  if (!props.editMode || props.drawing) return false
  const handles = handleList()
  if (handles.length === 0) return false
  if (!updatePointer(event)) return false

  const hit = castAgainst(handles)
  if (!hit) return false

  const marker = hit.object
  const sectorId = marker.userData?.sectorId
  const index = marker.userData?.vertexIndex
  const ring = (marker.userData?.vertexRing as VertexRing | undefined) ?? 'base'
  if (typeof sectorId !== 'number' || typeof index !== 'number') return false

  // Вершина обязана остаться в плоскости своего кольца, иначе контур
  // перестанет быть плоским. Для основания плоскость задаёт нормаль зоны,
  // для верхней грани — горизонталь на её отметке: так пользователь
  // очерчивает форму верха, а не заваливает её произвольно в пространстве.
  const mesh = sectorMeshes.get(sectorId)
  const normal: Vec3 =
    ring === 'top'
      ? [0, 1, 0]
      : ((mesh?.userData?.planeNormal as Vec3 | undefined) ?? [0, 1, 0])
  const anchor = marker.position
  dragPlane = { point: [anchor.x, anchor.y, anchor.z], normal }
  draggingVertex.value = { sectorId, index, ring }
  dragMoved = false

  // Захват указателя: курсор может уйти за пределы канваса, а тянуть
  // вершину при этом надо продолжать.
  if (canvasEl) {
    try {
      canvasEl.setPointerCapture(event.pointerId)
      capturedPointerId = event.pointerId
    } catch {
      /* захват необязателен — без него драг просто прервётся у края */
    }
  }
  // Орбиту отключаем, иначе то же движение будет крутить камеру.
  if (controls) controls.enabled = false
  event.preventDefault()
  return true
}

function moveVertex(event: PointerEvent): void {
  const active = draggingVertex.value
  const plane = dragPlane
  const activeCamera = camera.value as THREE.Camera | undefined
  if (!active || !plane || !activeCamera) return
  if (!updatePointer(event)) return

  raycaster.setFromCamera(pointer, activeCamera)
  const origin = raycaster.ray.origin
  const direction = raycaster.ray.direction
  const hit = rayPlaneIntersection(
    [origin.x, origin.y, origin.z],
    [direction.x, direction.y, direction.z],
    plane.point,
    plane.normal,
  )
  if (!hit) return
  dragMoved = true
  emit('vertex-move', {
    sectorId: active.sectorId,
    index: active.index,
    ring: active.ring,
    point: hit,
  })
}

function endVertexDrag(): void {
  const active = draggingVertex.value
  if (canvasEl && capturedPointerId !== null) {
    try {
      canvasEl.releasePointerCapture(capturedPointerId)
    } catch {
      /* указатель мог быть уже отпущен системой */
    }
  }
  capturedPointerId = null
  draggingVertex.value = null
  dragPlane = null
  if (controls) controls.enabled = true
  // Сохраняем только если вершина действительно сдвинулась: клик по маркеру
  // без движения не должен уходить в стек отмены пустым шагом.
  if (active && dragMoved) emit('vertex-commit', { sectorId: active.sectorId, ring: active.ring })
  dragMoved = false
}

function updateHover(event: PointerEvent): void {
  if (!props.editMode || draggingVertex.value !== null) return
  const handles = handleList()
  if (handles.length === 0) {
    hoveredVertexKey.value = null
    return
  }
  if (!updatePointer(event)) return
  const hit = castAgainst(handles)
  const next = (hit?.object.userData?.vertexKey as string | undefined) ?? null
  if (next === hoveredVertexKey.value) return
  hoveredVertexKey.value = next
  invalidateScene()
}

// ------------------------------------------------------------------- указатель
function onPointerDown(event: PointerEvent): void {
  downX = event.clientX
  downY = event.clientY
  downAt = performance.now()
  if (event.button === 0) beginVertexDrag(event)
}

function onPointerMove(event: PointerEvent): void {
  if (draggingVertex.value !== null) {
    moveVertex(event)
    return
  }
  updateHover(event)
}

function onPointerUp(event: PointerEvent): void {
  if (draggingVertex.value !== null) {
    endVertexDrag()
    return
  }
  if (event.button !== 0) return
  const moved = Math.hypot(event.clientX - downX, event.clientY - downY)
  if (moved > 5 || performance.now() - downAt > 600) return
  if (!updatePointer(event)) return

  // Режим разметки: ставим опорную точку в месте попадания луча по модели.
  if (props.drawing) {
    const hit = castAgainst(modelList())
    if (hit) {
      emit('point', [hit.point.x, hit.point.y, hit.point.z])
    }
    return
  }

  const mode = modeFromEvent(event)

  // Обычный режим: считаем оба попадания и сравниваем глубину. Иначе клик по
  // фасаду, за которым спрятана зона на перекрытии, выделял бы невидимую зону.
  const sectorHit = castAgainst(sectorMeshList())
  const modelHit = castAgainst(modelList())

  const sectorId = sectorHit ? sectorIdFromObject(sectorHit.object) : null
  const sectorIsCloser =
    sectorHit !== null &&
    sectorId !== null &&
    (modelHit === null || sectorHit.distance <= modelHit.distance + 0.01)

  if (sectorIsCloser && sectorId !== null) {
    emit('select-sector', { sectorId, mode })
    return
  }

  if (modelHit) {
    emit('select-mesh', modelHit.object.name || modelHit.object.uuid)
    // Отметка этажа снимается с НИЗА детали: колонна стоит на перекрытии,
    // и её основание — это и есть уровень, на котором она смонтирована.
    // Центр или точка попадания давали бы отметку «где-то по середине».
    const box = new THREE.Box3().setFromObject(modelHit.object)
    if (!box.isEmpty()) emit('pick-elevation', box.min.y)
    return
  }

  // Клик по пустоте с зажатым модификатором — не сброс: пользователь
  // набирает выделение и промахнулся мимо зоны.
  if (mode === 'replace') emit('clear-selection')
}

function onPointerCancel(): void {
  if (draggingVertex.value !== null) endVertexDrag()
}

// ------------------------------------------------------------- drag-and-drop
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

/**
 * Где перехватывается колесо.
 *
 * Слушатель вешается на РОДИТЕЛЯ канваса в фазе перехвата: так он гарантированно
 * срабатывает раньше собственного обработчика OrbitControls, который висит на
 * самом канвасе, независимо от порядка их регистрации. Останавливая событие
 * там, мы исключаем двойной зум — свой к курсору и штатный к центру.
 *
 * Штатный зум при этом НЕ отключается (`enableZoom` остаётся true): на нём
 * держится щипковый зум двумя пальцами, а его событий мы не трогаем.
 */
let wheelHost: HTMLElement | null = null

function attach(el: HTMLCanvasElement): void {
  canvasEl = el
  el.addEventListener('pointerdown', onPointerDown)
  el.addEventListener('pointermove', onPointerMove)
  el.addEventListener('pointerup', onPointerUp)
  el.addEventListener('pointercancel', onPointerCancel)
  el.addEventListener('dragover', onDragOver)
  el.addEventListener('dragleave', onDragLeave)
  el.addEventListener('drop', onDrop)

  wheelHost = el.parentElement ?? el
  // passive: false обязателен — иначе preventDefault не сработает и страница
  // будет прокручиваться вместе с зумом.
  wheelHost.addEventListener('wheel', onWheel, { capture: true, passive: false })
}

function detach(): void {
  if (wheelHost) {
    wheelHost.removeEventListener('wheel', onWheel, { capture: true })
    wheelHost = null
  }
  if (!canvasEl) return
  canvasEl.removeEventListener('pointerdown', onPointerDown)
  canvasEl.removeEventListener('pointermove', onPointerMove)
  canvasEl.removeEventListener('pointerup', onPointerUp)
  canvasEl.removeEventListener('pointercancel', onPointerCancel)
  canvasEl.removeEventListener('dragover', onDragOver)
  canvasEl.removeEventListener('dragleave', onDragLeave)
  canvasEl.removeEventListener('drop', onDrop)
  canvasEl = null
}

function setupControls(): void {
  const activeCamera = camera.value as THREE.PerspectiveCamera | undefined
  const activeRenderer = renderer.value as THREE.WebGLRenderer | undefined
  if (!activeCamera || !activeRenderer) return

  publishRenderer(activeCamera, activeRenderer, scene?.value ?? null)
  // Отрисовка по требованию: функцию перерисовки отдаём в шину, чтобы её
  // могли дёрнуть панели и компоненты вне контекста TresJS.
  bindInvalidate(typeof invalidate === 'function' ? invalidate : null)
  published = { camera: activeCamera, renderer: activeRenderer }

  if (!canvasEl) attach(activeRenderer.domElement)

  // Пересоздавать OrbitControls нельзя: вместе с ними теряется точка
  // вращения, и камера прыгает в центр сцены при каждом обновлении контекста.
  if (controls) {
    if (controls.object !== activeCamera) controls.dispose()
    else return
  }

  controls = new OrbitControls(activeCamera, activeRenderer.domElement)
  // Все настройки — включая раскладку кнопок и панорамирование (п. 1.4
  // доработок) — в @/three/controls: там они покрыты тестом.
  configureControls(controls)
  applyClipping()
}

/**
 * Отсечение сцены по этажам (п. 3.1 доработок).
 *
 * Режем плоскостями рендерера, а не прячем меши целиком: «показывать только
 * объём между отметками» иначе не выполнить — перекрытие, пересекающее
 * границу, должно обрезаться, а не исчезать вместе с половиной этажа.
 * Плоскости глобальные, поэтому режутся и зоны — сечение выглядит цельным.
 */
function invalidateAnchorCache(): void {
  anchorCache = null
}

function applyClipping(): void {
  const activeRenderer = renderer.value as THREE.WebGLRenderer | undefined
  if (!activeRenderer) return

  const planes: THREE.Plane[] = []
  // Plane(n, c) оставляет полупространство n·p + c >= 0.
  if (props.clipMin !== null && props.clipMin !== undefined) {
    planes.push(new THREE.Plane(new THREE.Vector3(0, 1, 0), -props.clipMin))
  }
  if (props.clipMax !== null && props.clipMax !== undefined) {
    planes.push(new THREE.Plane(new THREE.Vector3(0, -1, 0), props.clipMax))
  }

  activeRenderer.clippingPlanes = planes
  activeRenderer.localClippingEnabled = planes.length > 0
  invalidateAnchorCache()
  invalidateScene()
}

watch(() => [props.clipMin, props.clipMax], applyClipping)

/**
 * Один шаг кадрового цикла.
 *
 * `controls.update()` возвращает true, если камера сдвинулась, — при
 * включённом сглаживании она продолжает ехать ещё несколько кадров после
 * отпускания мыши. Перерисовываем и пересчитываем 3D-виджеты ТОЛЬКО в эти
 * кадры: в покое сцена не трогается вовсе.
 */
function tick(): void {
  if (!controls) return
  const moved = controls.update()
  if (!moved) return
  invalidateScene()
  // Счётчик кадров двигаем тем же условием: на нём висит перепроецирование
  // 3D-виджетов, и в покое пересчитывать их незачем.
  bumpFrameTick()
}

watch(
  () => [camera.value, renderer.value],
  () => setupControls(),
  { immediate: true },
)

// Как только появился первый слой — вписываем сцену в кадр. Дальше камеру
// не трогаем: пользователь мог выбрать вид, а следом догрузиться ещё слой.
watch(modelRoots, (roots) => {
  const activeCamera = camera.value as THREE.PerspectiveCamera | undefined
  const activeRenderer = renderer.value as THREE.WebGLRenderer | undefined
  if (roots.length === 0) {
    framedRoots = 0
    return
  }
  if (framedRoots > 0 || !activeCamera || !controls) return
  // Пока канвас не получил размеры, aspect камеры невалиден и вид «впишется»
  // мимо. Не помечаем сцену вписанной — попробуем на следующем слое или
  // по кнопке «Сбросить вид».
  if (!activeRenderer || activeRenderer.domElement.clientWidth === 0) return
  framedRoots = roots.length
  const { target } = fitCameraToObjects(activeCamera, roots)
  controls.target.copy(target)
  controls.update()
  invalidateScene()
  bumpFrameTick()
})

/** Освободить всё, что захватил этот экземпляр. */
function release(): void {
  stopFrames?.()
  stopFrames = null
  controls?.dispose()
  controls = null
  detach()
  // Плоскости отсечения живут на рендерере: не снять их — и следующий
  // проект откроется наполовину срезанным.
  const activeRenderer = renderer.value as THREE.WebGLRenderer | undefined
  if (activeRenderer) {
    activeRenderer.clippingPlanes = []
    activeRenderer.localClippingEnabled = false
  }
}

onMounted(() => {
  // Предыдущий экземпляр (если TresJS оставил его в живых) отпускает канвас.
  releaseActive?.()
  releaseActive = release
  setupControls()
  stopFrames = onFrame(tick)
})

onBeforeUnmount(() => {
  release()
  if (releaseActive === release) {
    releaseActive = null
    bindInvalidate(null)
    // Камеру и рендерер с шины снимает ViewerView (resetSceneBus) при уходе
    // со страницы: объекты общие для всех экземпляров, и обнулять их здесь
    // значило бы гасить сцену, которой продолжает пользоваться живой сосед.
    retireRenderer(published?.camera ?? null, published?.renderer ?? null)
    published = null
  }
})

defineExpose({
  resetView(): void {
    const activeCamera = camera.value as THREE.PerspectiveCamera | undefined
    if (!activeCamera || modelRoots.value.length === 0 || !controls) return
    const { target } = fitCameraToObjects(activeCamera, modelRoots.value)
    controls.target.copy(target)
    controls.update()
    invalidateScene()
    bumpFrameTick()
  },
})
</script>

<template>
  <!-- Компонент существует только ради побочных эффектов. -->
</template>
