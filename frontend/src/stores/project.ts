/**
 * Состояние открытого проекта: сцена, слои, зоны, бригады, разметка и Undo.
 *
 * Правила выделения и разметки вынесены в чистые модули `@/lib/selection`
 * и `@/lib/drafting` — там они покрыты тестами. Здесь остаётся связывание
 * их с сетью и сценой.
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { api } from '@/api/client'
import type {
  BrigadeWithAssignment,
  Level,
  Project,
  ProjectModel,
  SectorSummary,
} from '@/api/types'
import { openProjectSocket } from '@/api/realtime'
import {
  DEFAULT_EXTRUDE_HEIGHT,
  EMPTY_DRAFT,
  addDraftPoint,
  beginExtrude,
  canBeginExtrude,
  canCommitDraft,
  cancelDraft,
  draftHasUndo,
  isDrafting,
  setDraftHeight,
  startDraft,
  undoDraft,
  type DraftState,
} from '@/lib/drafting'
import {
  EMPTY_SELECTION,
  applySelection,
  nextVisibilityForGroup,
  pruneSelection,
  type SelectMode,
  type SelectionState,
  type Visibility,
} from '@/lib/selection'

/**
 * Одно атомарное действие, которое отменяет кнопка «Шаг назад».
 *
 * В стек попадают только обратимые изменения сцены. Удаление зоны сюда
 * НЕ попадает сознательно: восстановить её вместе с задачами, проблемами и
 * их историей уже нельзя, поэтому удаление защищено окном подтверждения,
 * а не отменой.
 */
export type UndoEntry =
  | { kind: 'sector-created'; sectorId: number }
  | { kind: 'brigades-changed'; sectorId: number; previous: number[] }
  | {
      kind: 'geometry-changed'
      sectorId: number
      previousCoordinates: number[][]
      previousHeight: number
      /** Правленая верхняя грань до изменения; null — верх был ровным. */
      previousTop?: number[][] | null
    }
  | { kind: 'renamed'; sectorId: number; previousName: string }
  /**
   * Массовое назначение бригад — ОДНА запись, а не по одной на зону:
   * для пользователя это одно действие, и «Шаг назад» обязан вернуть все
   * зоны сразу, а не заставлять нажимать кнопку столько раз, сколько
   * зон он выделил.
   */
  | { kind: 'brigades-bulk'; entries: Array<{ sectorId: number; previous: number[] }> }

/** Понятная подпись действия — для подсказки после отмены. */
const UNDO_LABEL: Record<UndoEntry['kind'], string> = {
  'sector-created': 'создание зоны',
  'brigades-changed': 'назначение бригад',
  'geometry-changed': 'перемещение границ зоны',
  renamed: 'переименование зоны',
  'brigades-bulk': 'массовое назначение бригад',
}

/**
 * Убрать из стека отмены всё, что относится к удалённой зоне.
 *
 * Отменить действие над несуществующей зоной невозможно, а оставленная
 * запись превращала бы «Шаг назад» в кнопку, которая иногда молча ничего
 * не делает. Из массовой записи выбрасывается только исчезнувшая зона —
 * сама запись живёт, пока в ней есть хоть одна существующая.
 */
export function dropSectorFromStack(stack: UndoEntry[], sectorId: number): UndoEntry[] {
  const result: UndoEntry[] = []
  for (const entry of stack) {
    if (entry.kind === 'brigades-bulk') {
      const entries = entry.entries.filter((item) => item.sectorId !== sectorId)
      if (entries.length > 0) result.push({ ...entry, entries })
      continue
    }
    if (entry.sectorId !== sectorId) result.push(entry)
  }
  return result
}

export const useProjectStore = defineStore('project', () => {
  const project = ref<Project | null>(null)
  /** Слои .glb — панель «Слои». */
  const models = ref<ProjectModel[]>([])
  const sectors = ref<SectorSummary[]>([])
  const brigades = ref<BrigadeWithAssignment[]>([])
  /** Закреплённые этажи (уровни) — панель «Этажи». */
  const levels = ref<Level[]>([])

  const loading = ref(false)
  const error = ref<string | null>(null)
  const connected = ref(false)

  // -------------------------------------------------------------- выделение
  /** Зоны, выбранные ЯВНО: клик по сцене или строка в списке. */
  const sectorSelection = ref<SelectionState>({ ...EMPTY_SELECTION })
  /** Выбранные бригады: их зоны подсвечиваются, но поп-апов не открывают. */
  const brigadeSelection = ref<SelectionState>({ ...EMPTY_SELECTION })
  /** Выбранные слои: на них действует кнопка прозрачности. */
  const layerSelection = ref<SelectionState>({ ...EMPTY_SELECTION })

  /** Зона, открытая в правой карточке. Инвариант: входит в выделение. */
  const activeSectorId = ref<number | null>(null)
  /**
   * Открыта ли карточка. Живёт в сторе, а не во вью: выбрать зону можно
   * четырьмя путями (сцена, поп-ап, список, кнопка «Карточка»), и карточка
   * должна открываться на каждом — включая повторный выбор той же зоны
   * после закрытия крестиком.
   */
  const sidebarOpen = ref(false)
  /** Имя выделенного меша исходной .glb-модели (выбор этажа/элемента). */
  const selectedMeshName = ref<string | null>(null)

  // ------------------------------------------------------------ прозрачность
  const layerVisibility = ref<Record<number, Visibility>>({})
  const sectorVisibility = ref<Record<number, Visibility>>({})

  // ----------------------------------------------------------------- режимы
  /** Режим просмотра: выключает разметку и выбор мешей модели. */
  const viewMode = ref(false)
  /** Режим редактирования границ: у выбранной зоны появляются маркеры вершин. */
  const editMode = ref(false)
  /**
   * Умное выделение: контур не становится зоной сам, а указывает, какие
   * детали модели захватить целиком (п. 3.2 доработок).
   */
  const smartMode = ref(false)

  // ------------------------------------------------------------------ этажи
  /**
   * Отметка, снятая с выбранной детали модели, — ещё не закреплённый этаж.
   * По ней рисуется плоскость и предлагается имя в панели «Этажи».
   */
  const draftElevation = ref<number | null>(null)
  /**
   * Выбранные уровни для фильтрации видимости.
   * Один — «выше/ниже», два — «между ними».
   */
  const selectedLevelIds = ref<number[]>([])
  /** Режим отсечения: null — показываем всё. */
  const levelFilter = ref<'above' | 'below' | 'between' | null>(null)

  // --------------------------------------------------------------- разметка
  const draft = ref<DraftState>({ ...EMPTY_DRAFT })
  const undoStack = ref<UndoEntry[]>([])

  // ------------------------------------------------------------- производные
  const selectedSectorIds = computed(() => sectorSelection.value.ids)
  const selectedBrigadeIds = computed(() => brigadeSelection.value.ids)
  const selectedLayerIds = computed(() => layerSelection.value.ids)

  const sectorOrder = computed(() => sectors.value.map((s) => s.id))
  const brigadeOrder = computed(() => brigades.value.map((b) => b.id))
  const layerOrder = computed(() => models.value.map((m) => m.id))

  const activeSector = computed(
    () => sectors.value.find((s) => s.id === activeSectorId.value) ?? null,
  )
  const selectedSectors = computed(() =>
    // Порядок — как в списке зон, а не как в порядке кликов: массовые
    // операции показывают зоны в том же порядке, что и левая панель.
    sectors.value.filter((s) => selectedSectorIds.value.includes(s.id)),
  )
  const multiSelection = computed(() => selectedSectorIds.value.length > 1)

  /** Зоны выбранных бригад — подсвечиваются, но карточку не открывают. */
  const brigadeSectorIds = computed(() => {
    const ids = new Set<number>()
    for (const brigade of brigades.value) {
      if (!selectedBrigadeIds.value.includes(brigade.id)) continue
      for (const sectorId of brigade.assigned_sector_ids) ids.add(sectorId)
    }
    return [...ids]
  })

  /** Чем красить полигоны: явное выделение ∪ зоны выбранных бригад. */
  const highlightedSectorIds = computed(() => [
    ...new Set([...selectedSectorIds.value, ...brigadeSectorIds.value]),
  ])

  const drawing = computed(() => isDrafting(draft.value))
  const draftPoints = computed(() => draft.value.points)
  const draftHeight = computed(() => draft.value.height)
  const draftStage = computed(() => draft.value.stage)
  const canExtrude = computed(() => canBeginExtrude(draft.value))
  const canCommit = computed(() => canCommitDraft(draft.value))

  /** Модель уходит в «рентген», когда внимание отдано зонам. */
  const xrayActive = computed(
    () => highlightedSectorIds.value.length > 0 || selectedMeshName.value !== null,
  )

  const canUndo = computed(() => draftHasUndo(draft.value) || undoStack.value.length > 0)

  /** Уровни, выбранные для фильтрации, по возрастанию отметки. */
  const selectedLevels = computed(() =>
    levels.value
      .filter((level) => selectedLevelIds.value.includes(level.id))
      .sort((a, b) => a.elevation - b.elevation),
  )

  /**
   * Границы отсечения по вертикали: [низ, верх]; null — без ограничения.
   *
   * «Между» требует двух уровней; при одном режим сам вырождается в
   * «выше»/«ниже», чтобы кнопка не молчала.
   */
  const clipRange = computed<{ min: number | null; max: number | null }>(() => {
    const chosen = selectedLevels.value
    if (levelFilter.value === null || chosen.length === 0) return { min: null, max: null }
    if (levelFilter.value === 'between' && chosen.length >= 2) {
      return { min: chosen[0].elevation, max: chosen[chosen.length - 1].elevation }
    }
    if (levelFilter.value === 'above') return { min: chosen[0].elevation, max: null }
    if (levelFilter.value === 'below') return { min: null, max: chosen[0].elevation }
    return { min: null, max: null }
  })

  const clippingActive = computed(
    () => clipRange.value.min !== null || clipRange.value.max !== null,
  )

  /** Слои, которые сцена должна рисовать (скрытые исключены). */
  const visibleModels = computed(() =>
    models.value.filter((m) => (layerVisibility.value[m.id] ?? 'normal') !== 'hidden'),
  )

  let closeSocket: (() => void) | null = null

  // --------------------------------------------------------------- загрузка
  async function open(projectId: number): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const snapshot = await api.snapshot(projectId)
      project.value = snapshot.project
      models.value = snapshot.models
      sectors.value = snapshot.sectors
      brigades.value = snapshot.brigades
      levels.value = snapshot.levels ?? []
      resetInteraction()
      subscribe(projectId)
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Не удалось загрузить проект'
    } finally {
      loading.value = false
    }
  }

  /** Сбросить всё, что относится к текущему сеансу работы со сценой. */
  function resetInteraction(): void {
    draft.value = cancelDraft()
    undoStack.value = []
    sectorSelection.value = { ...EMPTY_SELECTION }
    brigadeSelection.value = { ...EMPTY_SELECTION }
    layerSelection.value = { ...EMPTY_SELECTION }
    activeSectorId.value = null
    sidebarOpen.value = false
    selectedMeshName.value = null
    layerVisibility.value = {}
    sectorVisibility.value = {}
    editMode.value = false
    smartMode.value = false
    draftElevation.value = null
    selectedLevelIds.value = []
    levelFilter.value = null
  }

  function close(): void {
    closeSocket?.()
    closeSocket = null
    connected.value = false
    project.value = null
    models.value = []
    sectors.value = []
    brigades.value = []
    levels.value = []
    resetInteraction()
  }

  /** Обновления по WebSocket: цифры на модели меняются без перезагрузки (п. 5.2 ТЗ). */
  function subscribe(projectId: number): void {
    closeSocket?.()
    closeSocket = openProjectSocket(projectId, {
      onStatus: (value) => {
        connected.value = value
      },
      onMessage: (message) => {
        if (message.project_id !== projectId) return
        switch (message.event) {
          case 'sector.created':
          case 'sector.updated':
          case 'sector.brigade_changed':
            if (message.payload === null) {
              // Резервный polling: точечных данных нет — перечитываем слепок.
              void refreshAll()
            } else {
              upsertSector(message.payload as SectorSummary)
              void refreshBrigades()
            }
            break
          case 'sector.deleted': {
            const id = (message.payload as { sector_id: number })?.sector_id
            forgetSector(id)
            void refreshBrigades()
            break
          }
          case 'brigade.created':
          case 'brigade.updated':
          case 'brigade.deleted':
            void refreshBrigades()
            break
          case 'project.model_updated':
          case 'project.models_changed':
            void refreshModels()
            break
          case 'levels.changed':
            void refreshLevels()
            break
          default:
            break
        }
      },
    })
  }

  function upsertSector(summary: SectorSummary | null): void {
    if (!summary || typeof summary.id !== 'number') return
    const index = sectors.value.findIndex((s) => s.id === summary.id)
    if (index === -1) sectors.value = [...sectors.value, summary]
    else sectors.value = sectors.value.map((s, i) => (i === index ? summary : s))
  }

  function upsertSectors(updated: SectorSummary[]): void {
    for (const summary of updated) upsertSector(summary)
  }

  /** Убрать удалённую зону из списка, выделения, стека отмены и карточки. */
  function forgetSector(sectorId: number): void {
    sectors.value = sectors.value.filter((s) => s.id !== sectorId)
    undoStack.value = dropSectorFromStack(undoStack.value, sectorId)
    const { [sectorId]: _dropped, ...rest } = sectorVisibility.value
    sectorVisibility.value = rest
    syncSelection()
  }

  /** Привести выделение и карточку в соответствие с фактическими данными. */
  function syncSelection(): void {
    sectorSelection.value = pruneSelection(sectorSelection.value, sectorOrder.value)
    brigadeSelection.value = pruneSelection(brigadeSelection.value, brigadeOrder.value)
    layerSelection.value = pruneSelection(layerSelection.value, layerOrder.value)

    if (activeSectorId.value !== null && !selectedSectorIds.value.includes(activeSectorId.value)) {
      // Инвариант: открытая карточка всегда принадлежит выделенной зоне.
      activeSectorId.value = selectedSectorIds.value[0] ?? null
    }
    if (activeSectorId.value === null) sidebarOpen.value = false
  }

  async function refreshBrigades(): Promise<void> {
    if (!project.value) return
    try {
      brigades.value = await api.listBrigades(project.value.id)
      syncSelection()
    } catch {
      /* не критично: список обновится при следующем действии */
    }
  }

  async function refreshModels(): Promise<void> {
    if (!project.value) return
    try {
      models.value = await api.listModels(project.value.id)
      syncSelection()
    } catch {
      /* не критично */
    }
  }

  /** Полное перечитывание сцены — используется резервным polling'ом. */
  async function refreshAll(): Promise<void> {
    if (!project.value) return
    try {
      const snapshot = await api.snapshot(project.value.id)
      project.value = snapshot.project
      models.value = snapshot.models
      sectors.value = snapshot.sectors
      brigades.value = snapshot.brigades
      levels.value = snapshot.levels ?? []
      syncSelection()
    } catch {
      /* тихо: следующая попытка через интервал polling'а */
    }
  }

  // -------------------------------------------------------------- выделение
  /**
   * Выбрать зону. `mode` приходит из модификаторов клавиатуры:
   * обычный клик заменяет выделение, Ctrl/Cmd — добавляет, Shift — диапазон.
   */
  function selectSector(id: number, mode: SelectMode = 'replace'): void {
    sectorSelection.value = applySelection(sectorSelection.value, id, mode, sectorOrder.value)
    selectedMeshName.value = null

    if (!selectedSectorIds.value.includes(id)) {
      // Ctrl-кликом зону сняли: карточку переносим на любую из оставшихся.
      activeSectorId.value = selectedSectorIds.value[0] ?? null
      if (activeSectorId.value === null) sidebarOpen.value = false
      return
    }

    activeSectorId.value = id
    sidebarOpen.value = true
  }

  /** Открыть карточку зоны — кнопка «Карточка» на поп-апе и в списке. */
  function openSectorCard(id: number): void {
    if (!sectors.value.some((s) => s.id === id)) return
    if (!selectedSectorIds.value.includes(id)) {
      sectorSelection.value = applySelection(
        sectorSelection.value,
        id,
        'toggle',
        sectorOrder.value,
      )
    }
    activeSectorId.value = id
    // Присваиваем безусловно: карточку могли закрыть крестиком, не сняв
    // выделения, и повторное нажатие обязано открыть её снова.
    sidebarOpen.value = true
  }

  function closeSidebar(): void {
    sidebarOpen.value = false
  }

  function selectBrigade(id: number, mode: SelectMode = 'replace'): void {
    brigadeSelection.value = applySelection(brigadeSelection.value, id, mode, brigadeOrder.value)
  }

  function selectLayer(id: number, mode: SelectMode = 'replace'): void {
    layerSelection.value = applySelection(layerSelection.value, id, mode, layerOrder.value)
  }

  function selectAllSectors(): void {
    sectorSelection.value = {
      ids: [...sectorOrder.value],
      anchor: sectorOrder.value[0] ?? null,
    }
    if (activeSectorId.value === null) activeSectorId.value = sectorOrder.value[0] ?? null
  }

  function selectMesh(name: string | null): void {
    if (viewMode.value) return
    selectedMeshName.value = name
    if (name !== null) {
      sectorSelection.value = { ...EMPTY_SELECTION }
      activeSectorId.value = null
      sidebarOpen.value = false
    }
  }

  function clearSelection(): void {
    sectorSelection.value = { ...EMPTY_SELECTION }
    brigadeSelection.value = { ...EMPTY_SELECTION }
    layerSelection.value = { ...EMPTY_SELECTION }
    activeSectorId.value = null
    sidebarOpen.value = false
    selectedMeshName.value = null
  }

  // ------------------------------------------------------------ прозрачность
  /**
   * На что подействует кнопка «Прозрачность» прямо сейчас.
   *
   * Приоритет: выбранные слои → выбранные зоны → все слои сцены. Последний
   * случай важен: кнопка не должна быть «мёртвой», когда ничего не выделено,
   * — иначе непонятно, при каких условиях она вообще работает.
   */
  const opacityScope = computed<'layers' | 'sectors' | 'all-layers'>(() => {
    if (selectedLayerIds.value.length > 0) return 'layers'
    if (selectedSectorIds.value.length > 0) return 'sectors'
    return 'all-layers'
  })

  /** Сколько объектов затронет кнопка — показывается на самой кнопке. */
  const opacityTargetCount = computed(() => {
    if (opacityScope.value === 'layers') return selectedLayerIds.value.length
    if (opacityScope.value === 'sectors') return selectedSectorIds.value.length
    return models.value.length
  })

  /** Кнопка «Прозрачность»: обычный вид → полупрозрачный → скрытый. */
  function cycleOpacity(): 'layers' | 'sectors' | 'all-layers' | null {
    const scope = opacityScope.value

    if (scope === 'sectors') {
      const next = nextVisibilityForGroup(selectedSectorIds.value, sectorVisibility.value)
      const map = { ...sectorVisibility.value }
      for (const id of selectedSectorIds.value) map[id] = next
      sectorVisibility.value = map
      return 'sectors'
    }

    const targets =
      scope === 'layers' ? selectedLayerIds.value : models.value.map((m) => m.id)
    if (targets.length === 0) return null
    const next = nextVisibilityForGroup(targets, layerVisibility.value)
    const map = { ...layerVisibility.value }
    for (const id of targets) map[id] = next
    layerVisibility.value = map
    return scope
  }

  function setLayerVisibility(id: number, value: Visibility): void {
    layerVisibility.value = { ...layerVisibility.value, [id]: value }
  }

  function setSectorVisibility(id: number, value: Visibility): void {
    sectorVisibility.value = { ...sectorVisibility.value, [id]: value }
  }

  function resetVisibility(): void {
    layerVisibility.value = {}
    sectorVisibility.value = {}
  }

  // --------------------------------------------------------------- разметка
  function startDrawing(): void {
    if (viewMode.value) return
    draft.value = startDraft()
    editMode.value = false
    clearSelection()
  }

  function resetDrawing(): void {
    draft.value = cancelDraft()
  }

  function addPoint(point: number[]): void {
    draft.value = addDraftPoint(draft.value, point)
  }

  /** Шаг 2: перейти от площади к объёму. */
  function startExtrude(height = DEFAULT_EXTRUDE_HEIGHT): void {
    draft.value = beginExtrude(draft.value, height)
  }

  function updateDraftHeight(height: number): void {
    draft.value = setDraftHeight(draft.value, height)
  }

  async function commitSector(name: string): Promise<SectorSummary | null> {
    if (!project.value || !canCommitDraft(draft.value)) return null
    const created = await api.createSector(project.value.id, {
      name,
      coordinates: draft.value.points,
      height: draft.value.height,
    })
    upsertSector(created)
    // Черновик израсходован: его собственная отмена больше не нужна,
    // созданную зону отменяет одна запись в стеке.
    draft.value = cancelDraft()
    undoStack.value = [...undoStack.value, { kind: 'sector-created', sectorId: created.id }]
    selectSector(created.id)
    return created
  }

  function toggleEditMode(): void {
    if (viewMode.value) return
    editMode.value = !editMode.value
    if (editMode.value) draft.value = cancelDraft()
  }

  /** Начать умное выделение: тот же обвод контура, другой смысл. */
  function startSmartSelection(): void {
    if (viewMode.value) return
    smartMode.value = true
    editMode.value = false
    draft.value = startDraft()
    clearSelection()
  }

  function stopSmartSelection(): void {
    smartMode.value = false
    draft.value = cancelDraft()
  }

  /**
   * Закрепить зону, собранную умным выделением.
   *
   * Контур и высота приходят уже посчитанными — стор их не пересчитывает:
   * геометрия деталей живёт в сцене, и тянуть three.js в хранилище незачем.
   */
  async function commitSmartSector(
    name: string,
    coordinates: number[][],
    height: number,
  ): Promise<SectorSummary | null> {
    if (!project.value || coordinates.length < 3) return null
    const created = await api.createSector(project.value.id, { name, coordinates, height })
    upsertSector(created)
    smartMode.value = false
    draft.value = cancelDraft()
    undoStack.value = [...undoStack.value, { kind: 'sector-created', sectorId: created.id }]
    selectSector(created.id)
    return created
  }

  // ------------------------------------------------------------------ этажи
  /** Снять отметку с выбранной детали модели — предложение для нового этажа. */
  function setDraftElevation(value: number | null): void {
    draftElevation.value = value
  }

  async function refreshLevels(): Promise<void> {
    if (!project.value) return
    try {
      levels.value = await api.listLevels(project.value.id)
    } catch {
      /* не критично: список обновится при следующем действии */
    }
  }

  /** Закрепить уровень под своим названием. */
  async function addLevel(name: string, elevation: number): Promise<Level | null> {
    if (!project.value) return null
    try {
      const level = await api.createLevel(project.value.id, { name, elevation })
      levels.value = [...levels.value, level].sort((a, b) => a.elevation - b.elevation)
      draftElevation.value = null
      return level
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Не удалось закрепить уровень'
      return null
    }
  }

  async function renameLevel(levelId: number, name: string): Promise<void> {
    if (!project.value) return
    try {
      const updated = await api.updateLevel(project.value.id, levelId, { name })
      levels.value = levels.value.map((l) => (l.id === updated.id ? updated : l))
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Не удалось переименовать уровень'
    }
  }

  async function removeLevel(levelId: number): Promise<void> {
    if (!project.value) return
    try {
      await api.deleteLevel(project.value.id, levelId)
      levels.value = levels.value.filter((l) => l.id !== levelId)
      selectedLevelIds.value = selectedLevelIds.value.filter((id) => id !== levelId)
      if (selectedLevelIds.value.length === 0) levelFilter.value = null
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Не удалось удалить уровень'
    }
  }

  /**
   * Выбрать уровень для фильтрации.
   *
   * Держим не больше двух: «между» осмысленно ровно для пары, а третий
   * выбор молча вытесняет самый старый — так не нужно сначала снимать.
   */
  function toggleLevelSelection(levelId: number): void {
    if (selectedLevelIds.value.includes(levelId)) {
      selectedLevelIds.value = selectedLevelIds.value.filter((id) => id !== levelId)
      if (selectedLevelIds.value.length === 0) levelFilter.value = null
      else if (levelFilter.value === 'between') levelFilter.value = 'above'
      return
    }
    const next = [...selectedLevelIds.value, levelId]
    selectedLevelIds.value = next.length > 2 ? next.slice(next.length - 2) : next
    // Режим отсечения выбор уровня НЕ включает: иначе первое нажатие на
    // «Выше» выключало бы уже проставленный режим и кнопка казалась бы
    // сломанной. Режим задают только сами кнопки.
  }

  /** Кнопки «выше» / «ниже» / «между»; повторное нажатие снимает фильтр. */
  function setLevelFilter(mode: 'above' | 'below' | 'between' | null): void {
    if (mode !== null && selectedLevelIds.value.length === 0) return
    levelFilter.value = levelFilter.value === mode ? null : mode
  }

  function clearLevelFilter(): void {
    levelFilter.value = null
    selectedLevelIds.value = []
  }

  function toggleViewMode(): void {
    viewMode.value = !viewMode.value
    if (viewMode.value) {
      draft.value = cancelDraft()
      editMode.value = false
      selectedMeshName.value = null
    }
  }

  // ----------------------------------------------------- геометрия и правка
  /**
   * Сохранить перетащенные вершины зоны.
   *
   * `previousCoordinates` приходит извне: перетаскивание меняет геометрию
   * в сцене покадрово, и снимок «до» надо взять до первого сдвига, а не в
   * момент отпускания мыши.
   */
  async function saveGeometry(
    sectorId: number,
    coordinates: number[][],
    previousCoordinates: number[][],
  ): Promise<void> {
    if (!project.value) return
    const sector = sectors.value.find((s) => s.id === sectorId)
    const previousHeight = sector?.height ?? 0
    try {
      upsertSector(await api.updateSector(project.value.id, sectorId, { coordinates }))
      undoStack.value = [
        ...undoStack.value,
        { kind: 'geometry-changed', sectorId, previousCoordinates, previousHeight },
      ]
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Не удалось сохранить границы зоны'
      // Возвращаем прежнюю геометрию: иначе в сцене осталась бы правка,
      // которой нет на сервере.
      upsertSector({ ...(sector as SectorSummary), coordinates: previousCoordinates })
    }
  }

  /**
   * Сохранить правленую верхнюю грань зоны (п. 3.3 доработок).
   *
   * Снимок «до» приходит извне по той же причине, что и у основания:
   * во время перетаскивания геометрия меняется покадрово.
   */
  async function saveTopGeometry(
    sectorId: number,
    topCoordinates: number[][],
    previousTop: number[][] | null,
  ): Promise<void> {
    if (!project.value) return
    const sector = sectors.value.find((s) => s.id === sectorId)
    if (!sector) return
    try {
      upsertSector(
        await api.updateSector(project.value.id, sectorId, {
          top_coordinates: topCoordinates,
        }),
      )
      undoStack.value = [
        ...undoStack.value,
        {
          kind: 'geometry-changed',
          sectorId,
          previousCoordinates: sector.coordinates,
          previousHeight: sector.height,
          previousTop,
        },
      ]
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Не удалось сохранить верхнюю грань'
      upsertSector({ ...sector, top_coordinates: previousTop })
    }
  }

  async function setSectorHeight(sectorId: number, height: number): Promise<void> {
    if (!project.value) return
    const sector = sectors.value.find((s) => s.id === sectorId)
    if (!sector || sector.height === height) return
    try {
      upsertSector(await api.updateSector(project.value.id, sectorId, { height }))
      undoStack.value = [
        ...undoStack.value,
        {
          kind: 'geometry-changed',
          sectorId,
          previousCoordinates: sector.coordinates,
          previousHeight: sector.height,
        },
      ]
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Не удалось изменить высоту зоны'
    }
  }

  async function renameSector(sectorId: number, name: string): Promise<void> {
    if (!project.value) return
    const previousName = sectors.value.find((s) => s.id === sectorId)?.name
    if (previousName === undefined || previousName === name) return
    try {
      upsertSector(await api.updateSector(project.value.id, sectorId, { name }))
      undoStack.value = [...undoStack.value, { kind: 'renamed', sectorId, previousName }]
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Не удалось переименовать зону'
    }
  }

  // ---------------------------------------------------------------- бригады
  function currentBrigadeIds(sectorId: number): number[] {
    return (sectors.value.find((s) => s.id === sectorId)?.brigades ?? []).map((b) => b.id)
  }

  /** Добавить бригаду к зоне (drag-and-drop). */
  async function addBrigade(sectorId: number, brigadeId: number): Promise<void> {
    if (!project.value) return
    const previous = currentBrigadeIds(sectorId)
    if (previous.includes(brigadeId)) return
    try {
      upsertSector(await api.addBrigade(project.value.id, sectorId, brigadeId))
      undoStack.value = [...undoStack.value, { kind: 'brigades-changed', sectorId, previous }]
      await refreshBrigades()
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Не удалось назначить бригаду'
    }
  }

  async function removeBrigade(sectorId: number, brigadeId: number): Promise<void> {
    if (!project.value) return
    const previous = currentBrigadeIds(sectorId)
    if (!previous.includes(brigadeId)) return
    try {
      upsertSector(await api.removeBrigade(project.value.id, sectorId, brigadeId))
      undoStack.value = [...undoStack.value, { kind: 'brigades-changed', sectorId, previous }]
      await refreshBrigades()
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Не удалось снять бригаду'
    }
  }

  async function setBrigades(sectorId: number, brigadeIds: number[]): Promise<void> {
    if (!project.value) return
    const previous = currentBrigadeIds(sectorId)
    try {
      upsertSector(await api.setBrigades(project.value.id, sectorId, brigadeIds))
      undoStack.value = [...undoStack.value, { kind: 'brigades-changed', sectorId, previous }]
      await refreshBrigades()
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Не удалось изменить состав бригад'
    }
  }

  /** Массовое назначение: один состав бригад на все выбранные зоны. */
  async function assignBrigadesToSelection(brigadeIds: number[]): Promise<number> {
    if (!project.value || selectedSectorIds.value.length === 0) return 0
    const targets = [...selectedSectorIds.value]
    const entries = targets.map((sectorId) => ({
      sectorId,
      previous: currentBrigadeIds(sectorId),
    }))
    try {
      const result = await api.assignBrigadesBulk(project.value.id, targets, brigadeIds)
      upsertSectors(result.sectors)
      undoStack.value = [...undoStack.value, { kind: 'brigades-bulk', entries }]
      await refreshBrigades()
      return result.sectors.length
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Не удалось назначить бригады'
      return 0
    }
  }

  // -------------------------------------------------------- задачи/проблемы
  /** Завести задачу сразу в нескольких зонах. */
  async function addTaskToSectors(
    sectorIds: number[],
    payload: { name: string; definition: string },
  ): Promise<number> {
    if (!project.value || sectorIds.length === 0) return 0
    try {
      const result = await api.addTaskBulk(project.value.id, sectorIds, {
        ...payload,
        status: 'todo',
        progress: 0,
      })
      upsertSectors(result.sectors)
      return result.sectors.length
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Не удалось создать задачу'
      return 0
    }
  }

  async function addProblemToSectors(
    sectorIds: number[],
    payload: { name: string; definition: string },
  ): Promise<number> {
    if (!project.value || sectorIds.length === 0) return 0
    try {
      const result = await api.addProblemBulk(project.value.id, sectorIds, {
        ...payload,
        is_resolved: false,
      })
      upsertSectors(result.sectors)
      return result.sectors.length
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Не удалось создать проблему'
      return 0
    }
  }

  // --------------------------------------------------------------- удаление
  async function removeSector(sectorId: number): Promise<void> {
    if (!project.value) return
    await api.deleteSector(project.value.id, sectorId)
    forgetSector(sectorId)
    await refreshBrigades()
  }

  /** Массовое удаление зон — одним запросом и одним подтверждением. */
  async function removeSectors(sectorIds: number[]): Promise<number> {
    if (!project.value || sectorIds.length === 0) return 0
    const result = await api.deleteSectors(project.value.id, sectorIds)
    for (const id of result.deleted_ids) forgetSector(id)
    await refreshBrigades()
    return result.deleted_ids.length
  }

  async function removeBrigades(brigadeIds: number[]): Promise<number> {
    if (!project.value || brigadeIds.length === 0) return 0
    const result = await api.deleteBrigades(project.value.id, brigadeIds)
    brigadeSelection.value = pruneSelection(
      brigadeSelection.value,
      brigadeOrder.value.filter((id) => !result.deleted_ids.includes(id)),
    )
    // Снятые бригады могли висеть на зонах — перечитываем сцену целиком.
    await refreshAll()
    return result.deleted_ids.length
  }

  // ------------------------------------------------------------------- undo
  /**
   * Кнопка «Шаг назад» / Ctrl+Z: отменяет РОВНО одно последнее действие.
   *
   * Сначала разбирается черновик разметки (последняя точка либо шаг
   * выдавливания) — пока он открыт, ничего другого пользователь изменить
   * не мог. Затем снимается одна запись со стека.
   */
  async function undo(): Promise<string | null> {
    const draftResult = undoDraft(draft.value)
    if (draftResult.undone !== null) {
      draft.value = draftResult.draft
      return draftResult.undone === 'extrude' ? 'выдавливание объёма' : 'последнюю точку'
    }

    const entry = undoStack.value[undoStack.value.length - 1]
    if (!entry) return null
    undoStack.value = undoStack.value.slice(0, -1)
    if (!project.value) return null

    const label = UNDO_LABEL[entry.kind]
    try {
      switch (entry.kind) {
        case 'sector-created':
          await api.deleteSector(project.value.id, entry.sectorId)
          forgetSector(entry.sectorId)
          await refreshBrigades()
          break
        case 'brigades-changed':
          upsertSector(
            await api.setBrigades(project.value.id, entry.sectorId, entry.previous),
          )
          await refreshBrigades()
          break
        case 'brigades-bulk': {
          // Составы у зон были разные, поэтому массовым запросом их не
          // вернуть — восстанавливаем каждую по её собственному снимку.
          for (const item of entry.entries) {
            upsertSector(
              await api.setBrigades(project.value.id, item.sectorId, item.previous),
            )
          }
          await refreshBrigades()
          break
        }
        case 'geometry-changed':
          upsertSector(
            await api.updateSector(project.value.id, entry.sectorId, {
              coordinates: entry.previousCoordinates,
              height: entry.previousHeight,
              // Пустой список — осознанный сброс правки верха; undefined
              // оставил бы текущую грань нетронутой.
              top_coordinates: entry.previousTop ?? [],
            }),
          )
          break
        case 'renamed':
          upsertSector(
            await api.updateSector(project.value.id, entry.sectorId, {
              name: entry.previousName,
            }),
          )
          break
      }
      return label
    } catch (e) {
      error.value = e instanceof Error ? e.message : `Не удалось отменить: ${label}`
      return null
    }
  }

  return {
    project,
    models,
    sectors,
    brigades,
    loading,
    error,
    connected,

    sectorSelection,
    brigadeSelection,
    layerSelection,
    selectedSectorIds,
    selectedBrigadeIds,
    selectedLayerIds,
    highlightedSectorIds,
    brigadeSectorIds,
    selectedSectors,
    multiSelection,
    activeSectorId,
    activeSector,
    sidebarOpen,
    selectedMeshName,
    xrayActive,

    layerVisibility,
    sectorVisibility,
    visibleModels,
    opacityScope,
    opacityTargetCount,

    viewMode,
    editMode,
    smartMode,

    levels,
    draftElevation,
    selectedLevelIds,
    selectedLevels,
    levelFilter,
    clipRange,
    clippingActive,
    setDraftElevation,
    refreshLevels,
    addLevel,
    renameLevel,
    removeLevel,
    toggleLevelSelection,
    setLevelFilter,
    clearLevelFilter,
    startSmartSelection,
    stopSmartSelection,
    commitSmartSector,
    saveTopGeometry,

    draft,
    drawing,
    draftPoints,
    draftHeight,
    draftStage,
    canExtrude,
    canCommit,
    undoStack,
    canUndo,

    open,
    close,
    upsertSector,
    upsertSectors,
    refreshBrigades,
    refreshModels,
    refreshAll,

    selectSector,
    openSectorCard,
    closeSidebar,
    selectBrigade,
    selectLayer,
    selectAllSectors,
    selectMesh,
    clearSelection,

    cycleOpacity,
    setLayerVisibility,
    setSectorVisibility,
    resetVisibility,

    startDrawing,
    resetDrawing,
    addPoint,
    startExtrude,
    updateDraftHeight,
    commitSector,
    toggleEditMode,
    toggleViewMode,

    saveGeometry,
    setSectorHeight,
    renameSector,

    addBrigade,
    removeBrigade,
    setBrigades,
    assignBrigadesToSelection,

    addTaskToSectors,
    addProblemToSectors,

    removeSector,
    removeSectors,
    removeBrigades,
    undo,
  }
})
