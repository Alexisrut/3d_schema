/** Состояние открытого проекта: сцена, секторы, бригады, разметка и Undo. */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { api } from '@/api/client'
import type { BrigadeWithAssignment, Project, SectorSummary } from '@/api/types'
import { openProjectSocket } from '@/api/realtime'

/** Один шаг, который умеет отменять кнопка «Шаг назад» (п. 3.3 ТЗ). */
export type UndoEntry =
  | { kind: 'point' }
  | { kind: 'sector-created'; sectorId: number }
  | { kind: 'brigade-assign'; sectorId: number; previousBrigadeId: number | null }

export const useProjectStore = defineStore('project', () => {
  const project = ref<Project | null>(null)
  const sectors = ref<SectorSummary[]>([])
  const brigades = ref<BrigadeWithAssignment[]>([])

  const loading = ref(false)
  const error = ref<string | null>(null)
  const connected = ref(false)

  /** id выбранного сектора — для сайдбара и режима рентгена. */
  const selectedSectorId = ref<number | null>(null)
  /** Имя выделенного меша исходной .glb-модели (выбор этажа/элемента). */
  const selectedMeshName = ref<string | null>(null)

  // ------------------------------------------------------------ разметка
  const drawing = ref(false)
  const draftPoints = ref<number[][]>([])
  const undoStack = ref<UndoEntry[]>([])

  const selectedSector = computed(
    () => sectors.value.find((s) => s.id === selectedSectorId.value) ?? null,
  )
  const xrayActive = computed(
    () => selectedSectorId.value !== null || selectedMeshName.value !== null,
  )
  const canUndo = computed(() => undoStack.value.length > 0)

  let closeSocket: (() => void) | null = null

  // --------------------------------------------------------------- load
  async function open(projectId: number): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const snapshot = await api.snapshot(projectId)
      project.value = snapshot.project
      sectors.value = snapshot.sectors
      brigades.value = snapshot.brigades
      resetDrawing()
      undoStack.value = []
      selectedSectorId.value = null
      selectedMeshName.value = null
      subscribe(projectId)
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Не удалось загрузить проект'
    } finally {
      loading.value = false
    }
  }

  function close(): void {
    closeSocket?.()
    closeSocket = null
    connected.value = false
    project.value = null
    sectors.value = []
    brigades.value = []
    resetDrawing()
    undoStack.value = []
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
            sectors.value = sectors.value.filter((s) => s.id !== id)
            if (selectedSectorId.value === id) selectedSectorId.value = null
            void refreshBrigades()
            break
          }
          case 'brigade.created':
          case 'brigade.updated':
          case 'brigade.deleted':
            void refreshBrigades()
            break
          case 'project.model_updated': {
            const url = (message.payload as { model_url: string })?.model_url
            if (project.value && url) project.value = { ...project.value, model_url: url }
            break
          }
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

  async function refreshBrigades(): Promise<void> {
    if (!project.value) return
    try {
      brigades.value = await api.listBrigades(project.value.id)
    } catch {
      /* не критично: список обновится при следующем действии */
    }
  }

  /** Полное перечитывание сцены — используется резервным polling'ом. */
  async function refreshAll(): Promise<void> {
    if (!project.value) return
    try {
      const snapshot = await api.snapshot(project.value.id)
      project.value = snapshot.project
      sectors.value = snapshot.sectors
      brigades.value = snapshot.brigades
    } catch {
      /* тихо: следующая попытка через интервал polling'а */
    }
  }

  // ---------------------------------------------------------- выделение
  function selectSector(id: number | null): void {
    selectedSectorId.value = id
    if (id !== null) selectedMeshName.value = null
  }

  function selectMesh(name: string | null): void {
    selectedMeshName.value = name
    if (name !== null) selectedSectorId.value = null
  }

  function clearSelection(): void {
    selectedSectorId.value = null
    selectedMeshName.value = null
  }

  // ----------------------------------------------------------- разметка
  function startDrawing(): void {
    drawing.value = true
    draftPoints.value = []
    clearSelection()
  }

  function resetDrawing(): void {
    drawing.value = false
    draftPoints.value = []
    // Точки исчезли — их записи в стеке отмены больше ничего не отменяют,
    // иначе «Шаг назад» несколько раз подряд молча ничего не делал бы.
    undoStack.value = undoStack.value.filter((entry) => entry.kind !== 'point')
  }

  function addPoint(point: number[]): void {
    if (!drawing.value) return
    draftPoints.value = [...draftPoints.value, point]
    undoStack.value = [...undoStack.value, { kind: 'point' }]
  }

  async function commitSector(name: string): Promise<SectorSummary | null> {
    if (!project.value || draftPoints.value.length < 3) return null
    const created = await api.createSector(project.value.id, {
      name,
      coordinates: draftPoints.value,
    })
    upsertSector(created)
    // Точки этой зоны уже «израсходованы» — заменяем их одной записью об отмене.
    undoStack.value = [
      ...undoStack.value.filter((e) => e.kind !== 'point'),
      { kind: 'sector-created', sectorId: created.id },
    ]
    resetDrawing()
    selectSector(created.id)
    return created
  }

  /** Кнопка «Шаг назад» / Ctrl+Z. */
  async function undo(): Promise<void> {
    const entry = undoStack.value[undoStack.value.length - 1]
    if (!entry) return
    undoStack.value = undoStack.value.slice(0, -1)

    if (entry.kind === 'point') {
      draftPoints.value = draftPoints.value.slice(0, -1)
      return
    }

    if (!project.value) return

    if (entry.kind === 'sector-created') {
      try {
        await api.deleteSector(project.value.id, entry.sectorId)
        sectors.value = sectors.value.filter((s) => s.id !== entry.sectorId)
        if (selectedSectorId.value === entry.sectorId) selectedSectorId.value = null
      } catch (e) {
        error.value = e instanceof Error ? e.message : 'Не удалось отменить создание зоны'
      }
      return
    }

    if (entry.kind === 'brigade-assign') {
      try {
        upsertSector(
          await api.assignBrigade(project.value.id, entry.sectorId, entry.previousBrigadeId),
        )
        await refreshBrigades()
      } catch (e) {
        error.value = e instanceof Error ? e.message : 'Не удалось отменить назначение бригады'
      }
    }
  }

  // ------------------------------------------------------------ бригады
  async function assignBrigade(sectorId: number, brigadeId: number | null): Promise<void> {
    if (!project.value) return
    const previous = sectors.value.find((s) => s.id === sectorId)?.brigade?.id ?? null
    if (previous === brigadeId) return
    try {
      upsertSector(await api.assignBrigade(project.value.id, sectorId, brigadeId))
      undoStack.value = [
        ...undoStack.value,
        { kind: 'brigade-assign', sectorId, previousBrigadeId: previous },
      ]
      await refreshBrigades()
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Не удалось назначить бригаду'
    }
  }

  async function removeSector(sectorId: number): Promise<void> {
    if (!project.value) return
    await api.deleteSector(project.value.id, sectorId)
    sectors.value = sectors.value.filter((s) => s.id !== sectorId)
    undoStack.value = undoStack.value.filter(
      (e) => !('sectorId' in e) || e.sectorId !== sectorId,
    )
    if (selectedSectorId.value === sectorId) selectedSectorId.value = null
    await refreshBrigades()
  }

  return {
    project,
    sectors,
    brigades,
    loading,
    error,
    connected,
    selectedSectorId,
    selectedMeshName,
    selectedSector,
    xrayActive,
    drawing,
    draftPoints,
    undoStack,
    canUndo,
    open,
    close,
    upsertSector,
    refreshBrigades,
    refreshAll,
    selectSector,
    selectMesh,
    clearSelection,
    startDrawing,
    resetDrawing,
    addPoint,
    commitSector,
    undo,
    assignBrigade,
    removeSector,
  }
})
