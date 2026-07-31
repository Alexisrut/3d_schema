<script setup lang="ts">
/** Основной экран: слои .glb, зоны, бригады, задачи и проблемы. */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { api, modelUrl } from '@/api/client'
import type {
  Attachment,
  BrigadeWithAssignment,
  Level,
  NotifyRecipient,
  ProjectModel,
  SectorSummary,
  TaskStatus,
} from '@/api/types'
import BillboardLayer from '@/components/BillboardLayer.vue'
import BottomSheet from '@/components/BottomSheet.vue'
import BrigadePanel from '@/components/BrigadePanel.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import LayersPanel from '@/components/LayersPanel.vue'
import LevelsPanel from '@/components/LevelsPanel.vue'
import MobileBar, { type MobileTab } from '@/components/MobileBar.vue'
import SectorListPanel from '@/components/SectorListPanel.vue'
import SectorSidebar from '@/components/SectorSidebar.vue'
import ViewerToolbar from '@/components/ViewerToolbar.vue'
import SceneCanvas from '@/components/scene/SceneCanvas.vue'
import type { SelectMode, Visibility } from '@/lib/selection'
import { buildSmartSector, type DetailBounds } from '@/lib/smartSelect'
import { useViewport } from '@/lib/viewport'
import { useAuthStore } from '@/stores/auth'
import { useProjectStore } from '@/stores/project'
import { modelRoots, resetSceneBus, type VertexRing } from '@/three/sceneBus'
import { defaultTopPoints } from '@/three/geometry'
import { Box3 as ThreeBox3 } from 'three'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const store = useProjectStore()
const { isMobile } = useViewport()

const scene = ref<InstanceType<typeof SceneCanvas> | null>(null)
const modelError = ref<string | null>(null)
const namePromptOpen = ref(false)
/** Окно имени для зоны, собранной умным выделением. */
const smartPromptOpen = ref(false)
const newSectorName = ref('')
const toast = ref<string | null>(null)
const layersOpen = ref(true)
const uploadingModel = ref(false)
/** Идёт загрузка вложений карточки. */
const uploadingFiles = ref(false)
/** Пользователи с подтверждённой почтой — кандидаты в адресаты писем. */
const recipients = ref<NotifyRecipient[]>([])
const recipientsLoading = ref(false)

/** Что подтверждает открытое окно. null — окно закрыто. */
type PendingAction =
  | { kind: 'delete-sector'; sector: SectorSummary }
  | { kind: 'delete-sectors'; sectors: SectorSummary[] }
  | { kind: 'delete-brigade'; brigade: BrigadeWithAssignment }
  | { kind: 'delete-brigades'; brigades: BrigadeWithAssignment[] }
  | { kind: 'delete-model'; model: ProjectModel }
  | { kind: 'delete-models'; models: ProjectModel[] }
  | { kind: 'delete-level'; level: Level }

const pending = ref<PendingAction | null>(null)

const projectId = computed(() => Number(route.params.projectId))

/** Слои для сцены: только видимые, с токеном в URL. */
const sceneLayers = computed(() =>
  store.visibleModels
    .map((model) => ({ ...model, url: modelUrl(model.model_url) ?? '' }))
    .filter((layer) => layer.url !== ''),
)

// ------------------------------------------------------------ мобильный вид
/** Открытая шторка на телефоне; null — видна только сцена. */
const activeSheet = ref<MobileTab | null>(null)

/**
 * Карточка зоны на телефоне — та же шторка.
 *
 * Открывается по тем же признакам, что и боковая панель на десктопе, поэтому
 * все пути выбора зоны (тап по сцене, поп-ап, список) работают одинаково.
 */
const cardSheetOpen = computed(() => store.sidebarOpen || store.multiSelection)

const cardSheetTitle = computed(() => {
  if (store.multiSelection) return `Выбрано зон: ${store.selectedSectorIds.length}`
  return store.activeSector?.name ?? 'Зона'
})

/** Любая открытая шторка — по ней работает Esc и «назад». */
const anySheetOpen = computed(() => activeSheet.value !== null || cardSheetOpen.value)

function openSheet(tab: MobileTab): void {
  // Повторный тап по активной вкладке закрывает её — так ведут себя
  // нижние панели в мобильных приложениях.
  activeSheet.value = activeSheet.value === tab ? null : tab
}

function closeSheets(): void {
  activeSheet.value = null
  store.closeSidebar()
}

/** Разметка идёт на весь экран: шторки в этот момент только мешают. */
watch(
  () => store.draftStage,
  (stage) => {
    if (stage !== 'idle') activeSheet.value = null
  },
)

/**
 * Выбор зоны на телефоне закрывает список.
 *
 * Иначе шторка со списком осталась бы поверх сцены и перекрыла бы зону,
 * которую пользователь только что выбрал.
 */
watch(
  () => store.sidebarOpen,
  (open) => {
    if (open && isMobile.value) activeSheet.value = null
  },
)

/** Зона, вершины которой правим: только при одиночном выборе. */
const editSector = computed(() =>
  store.editMode && store.selectedSectorIds.length === 1 ? store.activeSector : null,
)

function notify(message: string): void {
  toast.value = message
  window.setTimeout(() => {
    if (toast.value === message) toast.value = null
  }, 3500)
}

function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

// ------------------------------------------------------------------ загрузка
onMounted(async () => {
  // Слушатель вешаем до await: иначе при быстром уходе со страницы
  // onBeforeUnmount снял бы ещё не добавленный обработчик, и он остался бы
  // висеть глобально.
  window.addEventListener('keydown', onKeydown)
  await store.open(projectId.value)
  void loadRecipients()
})

/** Список адресатов нужен только при заведении карточки — грузим один раз. */
async function loadRecipients(): Promise<void> {
  recipientsLoading.value = true
  try {
    recipients.value = await api.listRecipients(projectId.value)
  } catch {
    // Не критично: поле адресатов просто останется пустым с пояснением.
    recipients.value = []
  } finally {
    recipientsLoading.value = false
  }
}

watch(projectId, async (id) => {
  if (Number.isFinite(id)) await store.open(id)
})

/**
 * Ошибки стора показываем одним вотчером: часть действий вызывает стор
 * напрямую из дочерних компонентов, и там их иначе никто не покажет.
 */
watch(
  () => store.error,
  (message) => {
    if (!message) return
    notify(message)
    // Сбрасываем сразу: иначе следующая такая же ошибка не изменит значение
    // и вотчер не сработает.
    store.error = null
  },
)

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  store.close()
  resetSceneBus()
})

function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    void undo()
    return
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
    event.preventDefault()
    store.selectAllSectors()
    return
  }
  if (event.key === 'Escape') {
    // Esc снимает по одному уровню: окно → шторка → разметка → выделение.
    if (pending.value) pending.value = null
    else if (namePromptOpen.value) namePromptOpen.value = false
    else if (activeSheet.value !== null) activeSheet.value = null
    else if (store.drawing) store.resetDrawing()
    else store.clearSelection()
  }
}

async function undo(): Promise<void> {
  const undone = await store.undo()
  if (undone) notify(`Отменено: ${undone}`)
}

// ------------------------------------------------------------------ разметка
function toggleDrawing(): void {
  if (store.drawing) store.resetDrawing()
  else store.startDrawing()
}

// ------------------------------------------------- умное выделение (п. 3.2)
/**
 * Габариты всех деталей загруженных слоёв.
 *
 * Считаются на месте, по запросу: держать их в сторе значило бы тянуть туда
 * three.js, а обновлять при каждом кадре — гонять bounding box на десятки
 * тысяч мешей впустую.
 */
function collectDetails(): DetailBounds[] {
  const details: DetailBounds[] = []
  const box = new ThreeBox3()
  for (const root of modelRoots.value) {
    root.traverse((child) => {
      const mesh = child as unknown as { isMesh?: boolean; name?: string }
      if (!mesh.isMesh) return
      box.setFromObject(child)
      if (box.isEmpty()) return
      details.push({
        name: child.name || 'Элемент',
        minX: box.min.x,
        minY: box.min.y,
        minZ: box.min.z,
        maxX: box.max.x,
        maxY: box.max.y,
        maxZ: box.max.z,
      })
    })
  }
  return details
}

/** Предпросмотр умного выделения — что захватится при закреплении. */
const smartPreview = computed(() => {
  if (!store.smartMode || store.draftPoints.length < 3) return null
  return buildSmartSector(store.draftPoints, collectDetails())
})

function toggleSmartSelection(): void {
  if (store.smartMode) store.stopSmartSelection()
  else {
    store.startSmartSelection()
    notify('Обведите область — детали, задетые контуром, войдут в зону целиком')
  }
}

function openSmartPrompt(): void {
  const preview = smartPreview.value
  if (!preview) {
    notify('Контур пока не задел ни одной детали модели')
    return
  }
  newSectorName.value = `Зона ${store.sectors.length + 1}`
  smartPromptOpen.value = true
}

async function commitSmartSector(): Promise<void> {
  const preview = smartPreview.value
  const name = newSectorName.value.trim()
  if (!preview || !name) return
  try {
    const created = await store.commitSmartSector(name, preview.coordinates, preview.height)
    smartPromptOpen.value = false
    if (created) {
      const count = preview.details.length
      notify(`Зона собрана из ${count} ${plural(count, 'детали', 'деталей', 'деталей')}`)
    }
  } catch (e) {
    notify(e instanceof Error ? e.message : 'Не удалось создать зону')
  }
}

// -------------------------------------------------------- этажи (п. 3.1)
async function pinLevel(payload: { name: string; elevation: number }): Promise<void> {
  const level = await store.addLevel(payload.name, payload.elevation)
  if (level) notify(`Уровень «${level.name}» закреплён на отметке ${level.elevation.toFixed(2)} м`)
}

function askDeleteLevel(level: Level): void {
  pending.value = { kind: 'delete-level', level }
}

function openNamePrompt(): void {
  if (!store.canCommit) {
    notify('Нужно поставить минимум 3 опорные точки')
    return
  }
  newSectorName.value = `Зона ${store.sectors.length + 1}`
  namePromptOpen.value = true
}

async function commitSector(): Promise<void> {
  const name = newSectorName.value.trim()
  if (!name) return
  try {
    const created = await store.commitSector(name)
    if (!created) {
      notify('Нужно поставить минимум 3 опорные точки')
      return
    }
    namePromptOpen.value = false
    notify(
      created.height > 0
        ? `Зона создана с объёмом ${created.height.toFixed(1)} м. «Шаг назад» отменит её целиком.`
        : 'Зона создана плоской. «Шаг назад» отменит её целиком.',
    )
  } catch (e) {
    notify(e instanceof Error ? e.message : 'Не удалось создать зону')
  }
}

// -------------------------------------------------------- правка геометрии
/**
 * Снимок координат до первого сдвига вершины.
 *
 * Нужен для «Шага назад»: за время перетаскивания координаты меняются
 * каждый кадр, и к моменту отпускания мыши исходное состояние уже потеряно.
 */
let geometryBefore: {
  sectorId: number
  coordinates: number[][]
  top: number[][] | null
} | null = null

function onVertexMove(payload: {
  sectorId: number
  index: number
  ring: VertexRing
  point: [number, number, number]
}): void {
  const sector = store.sectors.find((s) => s.id === payload.sectorId)
  if (!sector) return
  if (!geometryBefore || geometryBefore.sectorId !== payload.sectorId) {
    geometryBefore = {
      sectorId: payload.sectorId,
      coordinates: sector.coordinates.map((p) => [...p]),
      top: sector.top_coordinates ? sector.top_coordinates.map((p) => [...p]) : null,
    }
  }

  if (payload.ring === 'top') {
    // Первое движение верхней вершины материализует грань: до него верх
    // хранится как «основание + высота», и двигать в нём нечего.
    const current =
      sector.top_coordinates && sector.top_coordinates.length === sector.coordinates.length
        ? sector.top_coordinates
        : defaultTopPoints(sector.coordinates, sector.height)
    const top = current.map((p, i) => (i === payload.index ? [...payload.point] : p))
    store.upsertSector({ ...sector, top_coordinates: top })
    return
  }

  const coordinates = sector.coordinates.map((p, i) =>
    i === payload.index ? [...payload.point] : p,
  )
  // Обновляем локально: сеть на каждый кадр перетаскивания не выдержит,
  // на сервер уходит только результат.
  store.upsertSector({ ...sector, coordinates })
}

async function onVertexCommit(payload: {
  sectorId: number
  ring: VertexRing
}): Promise<void> {
  const sector = store.sectors.find((s) => s.id === payload.sectorId)
  const before = geometryBefore
  geometryBefore = null
  if (!sector || !before || before.sectorId !== payload.sectorId) return

  if (payload.ring === 'top') {
    await store.saveTopGeometry(
      payload.sectorId,
      sector.top_coordinates ?? defaultTopPoints(sector.coordinates, sector.height),
      before.top,
    )
    if (!store.error) notify('Верхняя грань зоны сохранена')
    return
  }

  await store.saveGeometry(payload.sectorId, sector.coordinates, before.coordinates)
  if (!store.error) notify('Границы зоны сохранены')
}

// ---------------------------------------------------------------- сектор API
async function withActiveSector<T>(action: (sectorId: number) => Promise<T>): Promise<void> {
  const sectorId = store.activeSectorId
  if (sectorId === null) return
  try {
    const summary = await action(sectorId)
    store.upsertSector(summary as never)
  } catch (e) {
    notify(e instanceof Error ? e.message : 'Операция не выполнена')
  }
}

type CardFormPayload = {
  name: string
  definition: string
  sectorIds: number[]
  files: File[]
  recipientIds: number[]
}

/**
 * Довесок к созданной карточке: файлы и письма.
 *
 * Выполняется ПОСЛЕ создания: пока карточки нет, привязать к ней файл не к
 * чему, а «ничьи» загрузки пришлось бы потом убирать сборщиком мусора.
 * Ошибка здесь не отменяет саму карточку — она уже создана и полезна.
 */
async function finishCard(
  kind: 'task' | 'problem',
  cards: Array<{ sectorId: number; cardId: number }>,
  payload: CardFormPayload,
): Promise<void> {
  if (payload.files.length > 0) {
    uploadingFiles.value = true
    try {
      for (const card of cards) {
        await api.uploadAttachments(projectId.value, kind, card.cardId, payload.files)
      }
      await store.refreshAll()
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Файлы не загрузились')
    } finally {
      uploadingFiles.value = false
    }
  }

  if (payload.recipientIds.length > 0) {
    try {
      // Письмо шлём по первой карточке: при массовом создании остальные —
      // её копии в других зонах, и дублировать рассылку незачем.
      const report = await api.notifyAboutCard(
        projectId.value,
        kind,
        cards[0].cardId,
        payload.recipientIds,
      )
      if (report.skipped) notify('Карточка создана. Отправка почты не настроена.')
      else if (report.error) notify(`Карточка создана, но письмо не ушло: ${report.error}`)
      else notify(`Письмо отправлено: ${report.sent.length} адр.`)
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Уведомление не отправлено')
    }
  }
}

/** Найти id только что созданных карточек в обновлённых сводках зон. */
function newCardIds(
  kind: 'task' | 'problem',
  sectorIds: number[],
  name: string,
): Array<{ sectorId: number; cardId: number }> {
  const found: Array<{ sectorId: number; cardId: number }> = []
  for (const sectorId of sectorIds) {
    const sector = store.sectors.find((s) => s.id === sectorId)
    if (!sector) continue
    const list = kind === 'task' ? sector.tasks : sector.problems
    // Берём последнюю одноимённую: карточки с одним названием допустимы,
    // а только что созданная всегда в конце списка.
    const match = [...list].reverse().find((c) => c.name === name)
    if (match) found.push({ sectorId, cardId: match.id })
  }
  return found
}

async function addTask(payload: CardFormPayload): Promise<void> {
  const count = await store.addTaskToSectors(payload.sectorIds, {
    name: payload.name,
    definition: payload.definition,
  })
  if (count === 0) return
  if (count > 1) notify(`Задача добавлена в ${count} ${plural(count, 'зону', 'зоны', 'зон')}`)

  const cards = newCardIds('task', payload.sectorIds, payload.name)
  if (cards.length > 0) await finishCard('task', cards, payload)
}

async function addProblem(payload: CardFormPayload): Promise<void> {
  const count = await store.addProblemToSectors(payload.sectorIds, {
    name: payload.name,
    definition: payload.definition,
  })
  if (count === 0) return
  if (count > 1) notify(`Проблема добавлена в ${count} ${plural(count, 'зону', 'зоны', 'зон')}`)

  const cards = newCardIds('problem', payload.sectorIds, payload.name)
  if (cards.length > 0) await finishCard('problem', cards, payload)
}

/** Приложить файлы к уже существующей карточке. */
async function uploadCardFiles(payload: {
  kind: 'task' | 'problem'
  cardId: number
  files: File[]
}): Promise<void> {
  uploadingFiles.value = true
  try {
    await api.uploadAttachments(projectId.value, payload.kind, payload.cardId, payload.files)
    await store.refreshAll()
    notify(`Файлов приложено: ${payload.files.length}`)
  } catch (e) {
    notify(e instanceof Error ? e.message : 'Файлы не загрузились')
  } finally {
    uploadingFiles.value = false
  }
}

async function deleteCardFile(attachment: Attachment): Promise<void> {
  try {
    await api.deleteAttachment(projectId.value, attachment.id)
    await store.refreshAll()
    notify(`Файл «${attachment.filename}» удалён`)
  } catch (e) {
    notify(e instanceof Error ? e.message : 'Не удалось удалить файл')
  }
}

const updateTask = (payload: { taskId: number; status?: TaskStatus; progress?: number }) =>
  withActiveSector((sectorId) => {
    const { taskId, ...rest } = payload
    return api.updateTask(projectId.value, sectorId, taskId, rest)
  })

const deleteTask = (taskId: number) =>
  withActiveSector((sectorId) => api.deleteTask(projectId.value, sectorId, taskId))

const toggleProblem = (payload: { problemId: number; isResolved: boolean }) =>
  withActiveSector((sectorId) =>
    api.updateProblem(projectId.value, sectorId, payload.problemId, {
      is_resolved: payload.isResolved,
    }),
  )

const deleteProblem = (problemId: number) =>
  withActiveSector((sectorId) => api.deleteProblem(projectId.value, sectorId, problemId))

function renameSector(name: string): void {
  if (store.activeSectorId === null) return
  void store.renameSector(store.activeSectorId, name)
}

function setSectorHeight(height: number): void {
  if (store.activeSectorId === null) return
  void store.setSectorHeight(store.activeSectorId, height)
}

async function assignBrigadesToSelection(brigadeIds: number[]): Promise<void> {
  const count = await store.assignBrigadesToSelection(brigadeIds)
  if (count > 0) {
    notify(
      brigadeIds.length
        ? `Бригады назначены в ${count} ${plural(count, 'зону', 'зоны', 'зон')}`
        : `Бригады сняты с ${count} ${plural(count, 'зоны', 'зон', 'зон')}`,
    )
  }
}

// ------------------------------------------------------------------ бригады
async function createBrigade(payload: {
  name: string
  brigadir: string
  cnt_people: number
}): Promise<void> {
  try {
    await api.createBrigade(projectId.value, payload)
    await store.refreshBrigades()
  } catch (e) {
    notify(e instanceof Error ? e.message : 'Не удалось создать бригаду')
  }
}

// -------------------------------------------------------------------- слои
async function uploadModels(files: FileList): Promise<void> {
  uploadingModel.value = true
  let added = 0
  try {
    // Последовательно, а не Promise.all: файлы из Revit весят десятки
    // мегабайт, и параллельная отправка нескольких упирается в канал,
    // а прогресс по ним всё равно не показать.
    for (const file of Array.from(files)) {
      try {
        await api.uploadModel(projectId.value, file)
        added += 1
      } catch (e) {
        notify(`${file.name}: ${e instanceof Error ? e.message : 'не удалось загрузить'}`)
      }
    }
  } finally {
    uploadingModel.value = false
    await store.refreshModels()
    await store.refreshAll()
  }
  if (added > 0) {
    notify(`Добавлено ${added} ${plural(added, 'слой', 'слоя', 'слоёв')}`)
  }
}

function renameModel(payload: { id: number; name: string }): void {
  void (async () => {
    try {
      await api.renameModel(projectId.value, payload.id, payload.name)
      await store.refreshModels()
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Не удалось переименовать слой')
    }
  })()
}

function showAllLayers(): void {
  for (const model of store.models) store.setLayerVisibility(model.id, 'normal')
}

const OPACITY_SCOPE_LABEL: Record<string, string> = {
  layers: 'выбранным слоям',
  sectors: 'выбранным зонам',
  'all-layers': 'всем слоям модели',
}

function cycleOpacity(): void {
  const scope = store.cycleOpacity()
  if (scope === null) {
    notify('Нечего делать прозрачным: в проекте нет ни слоёв, ни выбранных зон')
    return
  }
  notify(`Прозрачность применена к ${OPACITY_SCOPE_LABEL[scope] ?? 'выбранному'}`)
}

// -------------------------------------------------- подтверждение удаления
function askDeleteSector(): void {
  const sector = store.activeSector
  if (sector) pending.value = { kind: 'delete-sector', sector }
}

function askDeleteSelectedSectors(): void {
  const sectors = store.selectedSectors
  if (sectors.length === 1) pending.value = { kind: 'delete-sector', sector: sectors[0] }
  else if (sectors.length > 1) pending.value = { kind: 'delete-sectors', sectors }
}

function askDeleteBrigade(brigade: BrigadeWithAssignment): void {
  pending.value = { kind: 'delete-brigade', brigade }
}

function askDeleteSelectedBrigades(): void {
  const chosen = store.brigades.filter((b) => store.selectedBrigadeIds.includes(b.id))
  if (chosen.length === 1) pending.value = { kind: 'delete-brigade', brigade: chosen[0] }
  else if (chosen.length > 1) pending.value = { kind: 'delete-brigades', brigades: chosen }
}

function askDeleteModel(model: ProjectModel): void {
  pending.value = { kind: 'delete-model', model }
}

function askDeleteSelectedModels(): void {
  const chosen = store.models.filter((m) => store.selectedLayerIds.includes(m.id))
  if (chosen.length === 1) pending.value = { kind: 'delete-model', model: chosen[0] }
  else if (chosen.length > 1) pending.value = { kind: 'delete-models', models: chosen }
}

const confirmTitle = computed(() => {
  switch (pending.value?.kind) {
    case 'delete-sector':
    case 'delete-sectors':
      return 'Удаление зоны'
    case 'delete-brigade':
    case 'delete-brigades':
      return 'Удаление бригады'
    case 'delete-model':
    case 'delete-models':
      return 'Удаление слоя модели'
    case 'delete-level':
      return 'Удаление уровня'
    default:
      return ''
  }
})

const confirmMessage = computed(() => {
  const action = pending.value
  if (!action) return ''
  switch (action.kind) {
    case 'delete-sector':
      return `Вы действительно хотите удалить «${action.sector.name}»? Задачи и проблемы этой зоны будут удалены вместе с ней.`
    case 'delete-sectors':
      return `Вы действительно хотите удалить ${action.sectors.length} ${plural(action.sectors.length, 'зону', 'зоны', 'зон')}? Их задачи и проблемы будут удалены вместе с ними.`
    case 'delete-brigade':
      return `Вы действительно хотите удалить «${action.brigade.name}»? Бригада будет снята со всех зон.`
    case 'delete-brigades':
      return `Вы действительно хотите удалить ${action.brigades.length} ${plural(action.brigades.length, 'бригаду', 'бригады', 'бригад')}? Они будут сняты со всех зон.`
    case 'delete-model':
      return `Вы действительно хотите удалить слой «${action.model.name}»? Файл модели будет удалён с сервера.`
    case 'delete-models':
      return `Вы действительно хотите удалить ${action.models.length} ${plural(action.models.length, 'слой', 'слоя', 'слоёв')}? Файлы моделей будут удалены с сервера.`
    case 'delete-level':
      return `Вы действительно хотите удалить уровень «${action.level.name}» на отметке ${action.level.elevation.toFixed(2)} м?`
    default:
      return ''
  }
})

const confirmItems = computed(() => {
  const action = pending.value
  if (!action) return []
  switch (action.kind) {
    case 'delete-sectors':
      return action.sectors.map((s) => s.name)
    case 'delete-brigades':
      return action.brigades.map((b) => b.name)
    case 'delete-models':
      return action.models.map((m) => m.name)
    default:
      return []
  }
})

async function runPending(): Promise<void> {
  const action = pending.value
  pending.value = null
  if (!action) return

  try {
    switch (action.kind) {
      case 'delete-sector':
        await store.removeSector(action.sector.id)
        notify(`Зона «${action.sector.name}» удалена`)
        break
      case 'delete-sectors': {
        const count = await store.removeSectors(action.sectors.map((s) => s.id))
        notify(`Удалено ${count} ${plural(count, 'зона', 'зоны', 'зон')}`)
        break
      }
      case 'delete-brigade':
        await api.deleteBrigade(projectId.value, action.brigade.id)
        await store.refreshAll()
        notify(`Бригада «${action.brigade.name}» удалена`)
        break
      case 'delete-brigades': {
        const count = await store.removeBrigades(action.brigades.map((b) => b.id))
        notify(`Удалено ${count} ${plural(count, 'бригада', 'бригады', 'бригад')}`)
        break
      }
      case 'delete-model':
        await api.deleteModel(projectId.value, action.model.id)
        await store.refreshModels()
        await store.refreshAll()
        notify(`Слой «${action.model.name}» удалён`)
        break
      case 'delete-level':
        await store.removeLevel(action.level.id)
        notify(`Уровень «${action.level.name}» удалён`)
        break
      case 'delete-models': {
        for (const model of action.models) {
          await api.deleteModel(projectId.value, model.id)
        }
        await store.refreshModels()
        await store.refreshAll()
        notify(`Удалено ${action.models.length} ${plural(action.models.length, 'слой', 'слоя', 'слоёв')}`)
        break
      }
    }
  } catch (e) {
    notify(e instanceof Error ? e.message : 'Не удалось выполнить удаление')
  }
}

// ------------------------------------------------------------------- прочее
function onSelectSector(payload: { sectorId: number; mode: SelectMode }): void {
  store.selectSector(payload.sectorId, payload.mode)
}

function onSetSectorVisibility(payload: { id: number; value: Visibility }): void {
  store.setSectorVisibility(payload.id, payload.value)
}

function logout(): void {
  auth.logout()
  void router.push({ name: 'login' })
}

/** Выгрузка задач и проблем проекта в книгу Excel. */
async function exportToExcel(): Promise<void> {
  try {
    const { blob, filename } = await api.downloadExport(projectId.value)
    // Скачивание через временную ссылку на blob: так имя файла приходит с
    // сервера, а токен не уходит в адресную строку.
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    notify(`Файл «${filename}» выгружен`)
  } catch (e) {
    notify(e instanceof Error ? e.message : 'Не удалось выгрузить файл')
  }
}

// ------------------------------------------------------ связки для панелей
/**
 * Пропсы и обработчики панелей вынесены в объекты.
 *
 * Панели используются дважды — колонками на десктопе и шторками на телефоне.
 * Если расписывать привязки в обеих ветках шаблона, они неминуемо разъедутся:
 * добавили обработчик в одну — забыли в другой. Через `v-bind`/`v-on`
 * привязка остаётся ровно одна.
 */
const layersPanelProps = computed(() => ({
  models: store.models,
  selectedIds: store.selectedLayerIds,
  visibility: store.layerVisibility,
  canManage: auth.isAdmin,
  uploading: uploadingModel.value,
}))

const layersPanelHandlers = {
  select: (payload: { id: number; mode: SelectMode }) =>
    store.selectLayer(payload.id, payload.mode),
  'set-visibility': (payload: { id: number; value: Visibility }) =>
    store.setLayerVisibility(payload.id, payload.value),
  'cycle-selected': cycleOpacity,
  'show-all': showAllLayers,
  upload: uploadModels,
  rename: renameModel,
  delete: askDeleteModel,
  'delete-selected': askDeleteSelectedModels,
  close: () => {
    layersOpen.value = false
    activeSheet.value = null
  },
}

const brigadePanelProps = computed(() => ({
  brigades: store.brigades,
  sectors: store.sectors,
  selectedIds: store.selectedBrigadeIds,
  canEdit: auth.canEdit,
}))

const brigadePanelHandlers = {
  create: createBrigade,
  select: (payload: { id: number; mode: SelectMode }) =>
    store.selectBrigade(payload.id, payload.mode),
  delete: askDeleteBrigade,
  'delete-selected': askDeleteSelectedBrigades,
  unassign: (payload: { sectorId: number; brigadeId: number }) =>
    store.removeBrigade(payload.sectorId, payload.brigadeId),
}

const sectorListProps = computed(() => ({
  sectors: store.sectors,
  selectedIds: store.selectedSectorIds,
  visibility: store.sectorVisibility,
  canEdit: auth.canEdit,
}))

const levelsPanelProps = computed(() => ({
  levels: store.levels,
  selectedIds: store.selectedLevelIds,
  draftElevation: store.draftElevation,
  filter: store.levelFilter,
  canEdit: auth.canEdit,
}))

const levelsPanelHandlers = {
  pin: pinLevel,
  toggle: (levelId: number) => store.toggleLevelSelection(levelId),
  rename: (payload: { id: number; name: string }) =>
    store.renameLevel(payload.id, payload.name),
  delete: askDeleteLevel,
  'set-filter': (mode: 'above' | 'below' | 'between' | null) => store.setLevelFilter(mode),
  'clear-filter': () => store.clearLevelFilter(),
}

const sectorListHandlers = {
  select: onSelectSector,
  'open-card': (sectorId: number) => store.openSectorCard(sectorId),
  'set-visibility': onSetSectorVisibility,
  'select-all': () => store.selectAllSectors(),
  clear: () => store.clearSelection(),
  'delete-selected': askDeleteSelectedSectors,
}

const sidebarProps = computed(() => ({
  sector: store.activeSector,
  selected: store.selectedSectors,
  brigades: store.brigades,
  canEdit: auth.canEdit,
  editMode: store.editMode,
  // На телефоне шапку шторки рисует она сама — свой крестик панель прячет.
  embedded: isMobile.value,
  recipients: recipients.value,
  recipientsLoading: recipientsLoading.value,
  uploading: uploadingFiles.value,
}))

const sidebarHandlers = {
  close: () => store.closeSidebar(),
  rename: renameSector,
  delete: askDeleteSector,
  'delete-selected': askDeleteSelectedSectors,
  'set-height': setSectorHeight,
  'add-brigade': (brigadeId: number) => {
    if (store.activeSectorId !== null) void store.addBrigade(store.activeSectorId, brigadeId)
  },
  'remove-brigade': (brigadeId: number) => {
    if (store.activeSectorId !== null) void store.removeBrigade(store.activeSectorId, brigadeId)
  },
  'assign-brigades': assignBrigadesToSelection,
  'open-sector': (sectorId: number) => store.openSectorCard(sectorId),
  'toggle-edit': () => store.toggleEditMode(),
  'add-task': addTask,
  'update-task': updateTask,
  'delete-task': deleteTask,
  'upload-files': uploadCardFiles,
  'delete-file': deleteCardFile,
  'add-problem': addProblem,
  'toggle-problem': toggleProblem,
  'delete-problem': deleteProblem,
}

/** Действия шторки «Ещё» — то, что на десктопе живёт в верхней панели. */
const moreActions = computed(() => {
  const items: Array<{ key: string; label: string; run: () => void; danger?: boolean }> = []
  if (auth.canEdit) {
    items.push({
      key: 'draw',
      label: store.drawing ? 'Выйти из разметки' : 'Разметить зону',
      run: () => {
        toggleDrawing()
        activeSheet.value = null
      },
    })
    items.push({
      key: 'edit',
      label: store.editMode ? '✓ Правка границ' : 'Правка границ',
      run: () => {
        store.toggleEditMode()
        activeSheet.value = null
      },
    })
    items.push({
      key: 'undo',
      label: '↶ Шаг назад',
      run: () => {
        void undo()
      },
    })
  }
  items.push({
    key: 'view',
    label: store.viewMode ? '✓ Режим просмотра' : 'Режим просмотра',
    run: () => store.toggleViewMode(),
  })
  items.push({
    key: 'export',
    label: '⤓ Выгрузить задачи и проблемы в Excel',
    run: () => {
      activeSheet.value = null
      void exportToExcel()
    },
  })
  items.push({
    key: 'account',
    label: 'Личный кабинет',
    run: () => router.push({ name: 'account' }),
  })
  items.push({ key: 'logout', label: 'Выйти из аккаунта', run: logout, danger: true })
  return items
})
</script>

<template>
  <div class="viewer" :class="{ 'viewer--mobile': isMobile }">
    <!-- ------------------------------------------- шапка телефона -->
    <header v-if="isMobile" class="mheader">
      <button
        class="mheader__back"
        type="button"
        title="К списку проектов"
        @click="router.push({ name: 'projects' })"
      >
        ←
      </button>
      <h1 class="mheader__title">{{ store.project?.name ?? 'Загрузка…' }}</h1>
      <span
        class="mheader__dot"
        :class="{ 'is-online': store.connected }"
        :title="store.connected ? 'Обновления в реальном времени' : 'Резервный режим опроса'"
      />
      <span v-if="!auth.canEdit" class="mheader__badge">чтение</span>
    </header>

    <ViewerToolbar
      v-if="!isMobile"
      :project-name="store.project?.name ?? 'Загрузка…'"
      :connected="store.connected"
      :draft-stage="store.draftStage"
      :point-count="store.draftPoints.length"
      :draft-height="store.draftHeight"
      :can-extrude="store.canExtrude"
      :can-commit="store.canCommit"
      :can-undo="store.canUndo"
      :edit-mode="store.editMode"
      :smart-mode="store.smartMode"
      :view-mode="store.viewMode"
      :layers-open="layersOpen"
      :opacity-scope="store.opacityScope"
      :opacity-count="store.opacityTargetCount"
      :is-admin="auth.isAdmin"
      :can-edit="auth.canEdit"
      @toggle-drawing="toggleDrawing"
      @start-extrude="store.startExtrude()"
      @update-height="store.updateDraftHeight($event)"
      @commit="openNamePrompt"
      @undo="undo"
      @toggle-edit="store.toggleEditMode()"
      @toggle-smart="toggleSmartSelection"
      @toggle-view-mode="store.toggleViewMode()"
      @toggle-layers="layersOpen = !layersOpen"
      @cycle-opacity="cycleOpacity"
      @reset-view="scene?.resetView()"
      @export="exportToExcel"
      @back="router.push({ name: 'projects' })"
      @account="router.push({ name: 'account' })"
      @logout="logout"
    />

    <div class="viewer__body">
      <LayersPanel v-if="!isMobile && layersOpen" v-bind="layersPanelProps" v-on="layersPanelHandlers" />

      <div v-if="!isMobile" class="viewer__left">
        <BrigadePanel v-bind="brigadePanelProps" v-on="brigadePanelHandlers" />
        <SectorListPanel v-bind="sectorListProps" v-on="sectorListHandlers" />
        <LevelsPanel v-bind="levelsPanelProps" v-on="levelsPanelHandlers" />
      </div>

      <main
        class="viewer__stage"
        :class="{ 'is-drawing': store.drawing, 'is-editing': store.editMode }"
      >
        <SceneCanvas
          ref="scene"
          :layers="sceneLayers"
          :layer-visibility="store.layerVisibility"
          :sectors="store.sectors"
          :highlighted-sector-ids="store.highlightedSectorIds"
          :sector-visibility="store.sectorVisibility"
          :selected-mesh-name="store.selectedMeshName"
          :ghost-all="store.highlightedSectorIds.length > 0"
          :drawing="store.drawing"
          :draft-points="store.draftPoints"
          :draft-height="store.draftHeight"
          :edit-mode="store.editMode"
          :edit-sector="editSector"
          :levels="store.levels"
          :selected-level-ids="store.selectedLevelIds"
          :draft-elevation="store.draftElevation"
          :clip-min="store.clipRange.min"
          :clip-max="store.clipRange.max"
          @point="store.addPoint($event)"
          @select-sector="onSelectSector"
          @select-mesh="store.selectMesh($event)"
          @pick-elevation="store.setDraftElevation($event)"
          @clear-selection="store.clearSelection()"
          @drop-brigade="store.addBrigade($event.sectorId, $event.brigadeId)"
          @vertex-move="onVertexMove"
          @vertex-commit="onVertexCommit"
          @model-error="modelError = $event"
          @model-loaded="modelError = null"
        />

        <BillboardLayer
          :sectors="store.sectors"
          :selected-ids="store.selectedSectorIds"
          :visibility="store.sectorVisibility"
          :can-edit="auth.canEdit"
          @select="onSelectSector"
          @open-card="store.openSectorCard($event)"
          @drop-brigade="store.addBrigade($event.sectorId, $event.brigadeId)"
        />

        <!--
          Плавающие кнопки телефона: то, что нужно чаще всего именно при
          просмотре модели. Остальное убрано в шторку «Ещё».
        -->
        <div v-if="isMobile" class="fabs">
          <button
            class="fab"
            type="button"
            title="Вписать модель в экран"
            @click="scene?.resetView()"
          >
            ⤢
          </button>
          <button
            class="fab"
            type="button"
            :title="`Прозрачность: ${store.opacityScope === 'sectors' ? 'выбранные зоны' : 'слои'}`"
            @click="cycleOpacity"
          >
            ◐
          </button>
        </div>

        <div v-if="!store.models.length" class="overlay overlay--center">
          <p>3D-модели ещё не загружены.</p>
          <button
            v-if="auth.isAdmin"
            class="btn btn--primary"
            type="button"
            @click="layersOpen = true"
          >
            Открыть панель слоёв
          </button>
        </div>

        <div v-if="modelError" class="overlay overlay--error">
          Не удалось загрузить модель: {{ modelError }}
        </div>

        <div v-if="store.selectedMeshName" class="overlay overlay--chip">
          Выделен элемент: <strong>{{ store.selectedMeshName }}</strong>
          <button class="btn btn--tiny" type="button" @click="store.clearSelection()">
            Сбросить
          </button>
        </div>

        <!-- На телефоне шаги разметки показывает нижняя панель — здесь их
             дублировать не нужно, экран и так узкий. -->
        <div v-if="!isMobile && store.draftStage === 'polygon'" class="overlay overlay--hint">
          <strong>Шаг 1 из 2.</strong> Кликайте по модели, чтобы обвести площадь зоны.
          Ctrl+Z — убрать последнюю точку, Esc — выйти из режима.
        </div>

        <div
          v-else-if="!isMobile && store.draftStage === 'extrude'"
          class="overlay overlay--hint"
        >
          <strong>Шаг 2 из 2.</strong> Задайте высоту зоны в панели сверху.
          Ctrl+Z — вернуться к правке контура.
        </div>

        <div v-if="store.smartMode" class="overlay overlay--hint overlay--smart">
          <strong>Умное выделение.</strong>
          {{
            smartPreview
              ? `Захвачено деталей: ${smartPreview.details.length}. Нажмите «Собрать зону».`
              : 'Обведите область — детали, задетые контуром, войдут в зону целиком.'
          }}
          <button
            class="btn btn--tiny btn--primary"
            type="button"
            :disabled="!smartPreview"
            @click="openSmartPrompt"
          >
            Собрать зону
          </button>
          <button class="btn btn--tiny" type="button" @click="store.stopSmartSelection()">
            Отмена
          </button>
        </div>

        <div v-else-if="store.editMode" class="overlay overlay--hint">
          <strong>Правка границ.</strong>
          {{
            editSector
              ? isMobile
                ? 'Тяните жёлтые маркеры на углах зоны.'
                : 'Тяните жёлтые маркеры на углах зоны. Ctrl+Z — отменить перемещение.'
              : 'Выберите одну зону, чтобы у неё появились маркеры вершин.'
          }}
        </div>

        <div v-if="store.multiSelection" class="overlay overlay--count">
          Выбрано зон: <strong>{{ store.selectedSectorIds.length }}</strong>
          <button class="btn btn--tiny" type="button" @click="store.clearSelection()">
            Снять выбор
          </button>
        </div>

        <transition name="fade">
          <div v-if="toast" class="overlay overlay--toast">{{ toast }}</div>
        </transition>
      </main>

      <SectorSidebar
        v-if="!isMobile && (store.sidebarOpen || store.multiSelection)"
        v-bind="sidebarProps"
        v-on="sidebarHandlers"
      />
    </div>

    <!-- ============================================ мобильный интерфейс -->
    <template v-if="isMobile">
      <MobileBar
        :draft-stage="store.draftStage"
        :point-count="store.draftPoints.length"
        :draft-height="store.draftHeight"
        :can-extrude="store.canExtrude"
        :can-commit="store.canCommit"
        :can-undo="store.canUndo"
        :sector-count="store.sectors.length"
        :brigade-count="store.brigades.length"
        :layer-count="store.models.length"
        :active-tab="activeSheet"
        @open-tab="openSheet"
        @start-extrude="store.startExtrude()"
        @update-height="store.updateDraftHeight($event)"
        @commit="openNamePrompt"
        @cancel-drawing="store.resetDrawing()"
        @undo="undo"
      />

      <BottomSheet
        :open="activeSheet === 'sectors'"
        title="Зоны"
        @close="activeSheet = null"
      >
        <div class="sheet-panel">
          <SectorListPanel v-bind="sectorListProps" v-on="sectorListHandlers" />
        </div>
      </BottomSheet>

      <BottomSheet
        :open="activeSheet === 'brigades'"
        title="Бригады"
        @close="activeSheet = null"
      >
        <div class="sheet-panel">
          <BrigadePanel v-bind="brigadePanelProps" v-on="brigadePanelHandlers" />
        </div>
      </BottomSheet>

      <BottomSheet :open="activeSheet === 'layers'" title="Слои" @close="activeSheet = null">
        <div class="sheet-panel">
          <LayersPanel v-bind="layersPanelProps" v-on="layersPanelHandlers" />
        </div>
      </BottomSheet>

      <BottomSheet :open="activeSheet === 'more'" title="Ещё" @close="activeSheet = null">
        <div class="more">
          <button
            v-for="action in moreActions"
            :key="action.key"
            class="more__item"
            :class="{ 'more__item--danger': action.danger }"
            type="button"
            @click="action.run()"
          >
            {{ action.label }}
          </button>
        </div>
      </BottomSheet>

      <!-- Карточка зоны: тот же признак открытия, что и у боковой панели -->
      <BottomSheet
        :open="cardSheetOpen"
        :title="cardSheetTitle"
        size="tall"
        @close="store.closeSidebar()"
      >
        <div class="sheet-panel">
          <SectorSidebar v-bind="sidebarProps" v-on="sidebarHandlers" />
        </div>
      </BottomSheet>
    </template>

    <!-- Имя новой зоны -->
    <div v-if="namePromptOpen" class="modal" @click.self="namePromptOpen = false">
      <form class="modal__card" @submit.prevent="commitSector">
        <h3>Название зоны</h3>
        <input v-model="newSectorName" autofocus required />
        <p class="modal__note">
          {{
            store.draftHeight > 0
              ? `Объём: высота ${store.draftHeight.toFixed(1)} м`
              : 'Зона будет плоской, без объёма'
          }}
        </p>
        <div class="modal__actions">
          <button class="btn" type="button" @click="namePromptOpen = false">Отмена</button>
          <button class="btn btn--primary" type="submit">Создать</button>
        </div>
      </form>
    </div>

    <!-- Имя зоны, собранной умным выделением -->
    <div v-if="smartPromptOpen" class="modal" @click.self="smartPromptOpen = false">
      <form class="modal__card" @submit.prevent="commitSmartSector">
        <h3>Название зоны</h3>
        <input v-model="newSectorName" autofocus required />
        <p class="modal__note">
          Захвачено деталей: {{ smartPreview?.details.length ?? 0 }}, высота
          {{ (smartPreview?.height ?? 0).toFixed(2) }} м
        </p>
        <div class="modal__actions">
          <button class="btn" type="button" @click="smartPromptOpen = false">Отмена</button>
          <button class="btn btn--primary" type="submit">Создать</button>
        </div>
      </form>
    </div>

    <ConfirmDialog
      :open="pending !== null"
      :title="confirmTitle"
      :message="confirmMessage"
      :items="confirmItems"
      @confirm="runPending"
      @cancel="pending = null"
    />
  </div>
</template>

<style scoped>
.viewer {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.viewer__body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.viewer__left {
  display: flex;
  flex-direction: column;
  width: 260px;
  overflow-y: auto;
  background: #0f141b;
  border-right: 1px solid #21262d;
}

/* Панель бригад внутри левой колонки больше не рисует свою рамку и скролл. */
.viewer__left :deep(.panel) {
  width: auto;
  overflow: visible;
  border-right: none;
}

.viewer__left :deep(.sectors) {
  padding: 12px 14px 16px;
}

.viewer__stage {
  position: relative;
  flex: 1;
  min-width: 0;
  background: #0d1117;
}

.viewer__stage.is-drawing {
  cursor: crosshair;
}

.viewer__stage.is-editing {
  cursor: default;
}

.overlay {
  position: absolute;
  padding: 10px 14px;
  border-radius: 8px;
  background: rgba(17, 22, 30, 0.92);
  border: 1px solid #21262d;
  font-size: 13px;
  color: #e6edf3;
}

.overlay--center {
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
}

.overlay--error {
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  border-color: rgba(229, 83, 75, 0.6);
  color: #ff9f9a;
}

.overlay--chip {
  bottom: 14px;
  left: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.overlay--hint {
  top: 14px;
  left: 14px;
  max-width: 340px;
  border-color: rgba(255, 200, 87, 0.5);
  color: #ffd88a;
  line-height: 1.45;
}

.overlay--count {
  top: 14px;
  right: 14px;
  display: flex;
  align-items: center;
  gap: 10px;
  border-color: rgba(47, 129, 247, 0.5);
}

.overlay--toast {
  bottom: 14px;
  left: 50%;
  transform: translateX(-50%);
  max-width: 70%;
}

.modal {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.55);
  z-index: 50;
}

.modal__card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 320px;
  padding: 18px;
  border-radius: 10px;
  background: #0f141b;
  border: 1px solid #21262d;
}

.modal__card h3 {
  margin: 0;
  font-size: 15px;
}

.modal__note {
  margin: 0;
  font-size: 12px;
  color: #8b949e;
}

.modal__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* ============================================== мобильная раскладка ===== */
/*
 * Телефон: сцена занимает весь экран, панели уходят в нижние шторки.
 * Десктопная ветка разметки при этом не рендерится вовсе (v-if по isMobile),
 * поэтому её стили здесь не переопределяются и остаются нетронутыми.
 */
.viewer--mobile {
  /* 100dvh учитывает исчезающую адресную строку в мобильных браузерах;
     100vh там даёт полосу под нижней панелью. */
  height: 100dvh;
}

.mheader {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: calc(6px + env(safe-area-inset-top, 0)) 10px 6px;
  background: #0f141b;
  border-bottom: 1px solid #21262d;
}

.mheader__back {
  flex: none;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #c9d1d9;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}

.mheader__title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mheader__dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #7d8590;
}

.mheader__dot.is-online {
  background: #3fb950;
}

.mheader__badge {
  flex: none;
  padding: 2px 7px;
  border-radius: 10px;
  background: rgba(255, 200, 87, 0.16);
  border: 1px solid rgba(255, 200, 87, 0.45);
  color: #ffd88a;
  font-size: 11px;
}

/* Плавающие кнопки поверх сцены */
.fabs {
  position: absolute;
  right: 10px;
  bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 15;
}

.fab {
  width: 44px;
  height: 44px;
  border-radius: 22px;
  border: 1px solid #30363d;
  background: rgba(17, 22, 30, 0.9);
  color: #e6edf3;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  backdrop-filter: blur(6px);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
}

.fab:active {
  background: rgba(47, 129, 247, 0.3);
}

/* Панели внутри шторок: убираем колоночные размеры и свои шапки */
.sheet-panel {
  padding: 0 0 12px;
}

.sheet-panel :deep(.panel),
.sheet-panel :deep(.sidebar),
.sheet-panel :deep(.layers) {
  width: auto;
  overflow: visible;
  border: none;
  padding: 12px 14px;
}

.sheet-panel :deep(.sectors) {
  padding: 12px 14px 0;
  border-top: none;
}

/* Заголовки панелей дублировали бы заголовок шторки. Счётчики тоже убираем:
   то же число уже стоит бейджем на вкладке внизу. */
.sheet-panel :deep(.panel__header h2),
.sheet-panel :deep(.layers__header),
.sheet-panel :deep(.sectors__header),
.sheet-panel :deep(.sidebar__title h2) {
  display: none;
}

/* Списки внутри шторки прокручиваются вместе с ней, а не сами по себе. */
.sheet-panel :deep(.sectors__list),
.sheet-panel :deep(.targets) {
  max-height: none;
  overflow: visible;
}

/* Меню «Ещё» */
.more {
  display: flex;
  flex-direction: column;
  padding: 6px 12px 12px;
}

.more__item {
  padding: 14px 12px;
  border: none;
  border-bottom: 1px solid #21262d;
  background: transparent;
  color: #e6edf3;
  font: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
}

.more__item:active {
  background: rgba(47, 129, 247, 0.16);
}

.more__item--danger {
  color: #ff9f9a;
}

/* Подсказки и плашки на узком экране */
@media (max-width: 900px) {
  .overlay--hint {
    top: 10px;
    left: 10px;
    right: 10px;
    max-width: none;
    font-size: 12px;
  }

  .overlay--count {
    top: 10px;
    right: 10px;
    left: 10px;
    justify-content: space-between;
    font-size: 12px;
  }

  .overlay--chip {
    bottom: 10px;
    left: 10px;
    right: 66px;
    font-size: 12px;
  }

  .overlay--toast {
    left: 10px;
    right: 10px;
    bottom: 10px;
    max-width: none;
    transform: none;
    text-align: center;
  }

  .modal__card {
    min-width: 0;
    width: min(92vw, 340px);
  }
}
</style>
