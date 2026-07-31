<script setup lang="ts">
/**
 * 3D-виджеты над зонами (п. 5.2 ТЗ): процент выполнения и бригады.
 *
 * Это HTML-слой поверх канваса: точки привязки проецируются камерой в
 * экранные координаты каждый второй кадр. Так виджеты остаются обычным DOM —
 * их можно стилизовать, кликать и использовать как цель для drag-and-drop.
 */
import { computed, ref, watch } from 'vue'
import * as THREE from 'three'

import type { SectorSummary } from '@/api/types'
import { billboardAnchor, prismVolume } from '@/three/geometry'
import { modeFromEvent, type SelectMode, type Visibility } from '@/lib/selection'
import {
  draggingBrigadeId,
  dragHoverSectorId,
  frameTick,
  sceneCamera,
  sceneRenderer,
} from '@/three/sceneBus'

const props = defineProps<{
  sectors: SectorSummary[]
  /** Явно выбранные зоны — только для них показываем поп-ап. */
  selectedIds: number[]
  visibility: Record<number, Visibility>
  canEdit: boolean
}>()

const emit = defineEmits<{
  (e: 'select', payload: { sectorId: number; mode: SelectMode }): void
  (e: 'open-card', sectorId: number): void
  (e: 'drop-brigade', payload: { sectorId: number; brigadeId: number }): void
  (e: 'drag-brigade', brigadeId: number | null): void
}>()

interface Placed {
  sector: SectorSummary
  x: number
  y: number
  visible: boolean
  depth: number
}

const placed = ref<Placed[]>([])
const scratch = new THREE.Vector3()

/**
 * Поп-ап показывается только у ВЫБРАННОЙ зоны.
 *
 * На объекте с полусотней зон постоянные подписи перекрывают саму модель и
 * друг друга; выбранных же зон единицы, и их карточки не мешают смотреть на
 * здание. Скрытые зоны не показывают поп-ап никогда — их не видно и в сцене.
 */
const shown = computed(() =>
  props.sectors.filter(
    (s) =>
      props.selectedIds.includes(s.id) && (props.visibility[s.id] ?? 'normal') !== 'hidden',
  ),
)

function project(): void {
  const camera = sceneCamera.value
  const renderer = sceneRenderer.value
  if (!camera || !renderer) {
    placed.value = []
    return
  }

  const canvas = renderer.domElement
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  if (width === 0 || height === 0) return

  placed.value = shown.value.map((sector) => {
    // Якорь поднимается над верхней гранью объёма, а не над основанием.
    const anchor = billboardAnchor(sector.coordinates, 2.2, sector.height)
    scratch.set(anchor[0], anchor[1], anchor[2])
    scratch.project(camera)
    return {
      sector,
      x: (scratch.x * 0.5 + 0.5) * width,
      y: (-scratch.y * 0.5 + 0.5) * height,
      // z вне [-1, 1] — точка за камерой или за дальней плоскостью
      visible: scratch.z > -1 && scratch.z < 1,
      depth: scratch.z,
    }
  })
}

watch(frameTick, project)
watch(shown, project, { deep: true, immediate: true })

const ordered = computed(() => [...placed.value].sort((a, b) => b.depth - a.depth))

function progressColor(sector: SectorSummary): string {
  if (sector.open_problems > 0) return '#e5534b'
  if (sector.progress_percent >= 100) return '#3fb950'
  if (sector.progress_percent > 0) return '#2f81f7'
  return '#8b9bb4'
}

function volumeLabel(sector: SectorSummary): string {
  return `${prismVolume(sector.coordinates, sector.height).toFixed(0)} м³`
}

function onDrop(event: DragEvent, sectorId: number): void {
  event.preventDefault()
  const raw = event.dataTransfer?.getData('application/x-brigade-id') ?? ''
  const brigadeId = Number.parseInt(raw, 10)
  dragHoverSectorId.value = null
  draggingBrigadeId.value = null
  if (Number.isFinite(brigadeId)) emit('drop-brigade', { sectorId, brigadeId })
}

function onDragOver(event: DragEvent, sectorId: number): void {
  if (draggingBrigadeId.value === null) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dragHoverSectorId.value = sectorId
}

/** Перетаскивание бригады из одной зоны в другую прямо с виджета. */
function onBrigadeDragStart(event: DragEvent, brigadeId: number): void {
  if (!props.canEdit) {
    event.preventDefault()
    return
  }
  event.dataTransfer?.setData('application/x-brigade-id', String(brigadeId))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  draggingBrigadeId.value = brigadeId
  emit('drag-brigade', brigadeId)
}

function onBrigadeDragEnd(): void {
  draggingBrigadeId.value = null
  dragHoverSectorId.value = null
  emit('drag-brigade', null)
}

function onSelect(event: MouseEvent, sectorId: number): void {
  emit('select', { sectorId, mode: modeFromEvent(event) })
}
</script>

<template>
  <div class="billboards">
    <div
      v-for="item in ordered"
      v-show="item.visible"
      :key="item.sector.id"
      class="billboard"
      :class="{
        'is-selected': selectedIds.includes(item.sector.id),
        'is-drop-target': item.sector.id === dragHoverSectorId,
        'is-ghost': (visibility[item.sector.id] ?? 'normal') === 'ghost',
      }"
      :style="{ transform: `translate(-50%, -100%) translate(${item.x}px, ${item.y}px)` }"
      @click.stop="onSelect($event, item.sector.id)"
      @dragover="onDragOver($event, item.sector.id)"
      @drop="onDrop($event, item.sector.id)"
    >
      <div class="billboard__head">
        <span class="billboard__title">{{ item.sector.name }}</span>
        <!--
          Кнопка «Карточка» открывает боковую панель с деталями зоны.
          Обработчик вызывает store.openSectorCard: тот выставляет
          sidebarOpen безусловно, поэтому карточка открывается и когда зона
          уже выбрана, и когда панель до этого закрыли крестиком.
        -->
        <button
          class="billboard__card-btn"
          type="button"
          title="Открыть карточку зоны"
          @click.stop="emit('open-card', item.sector.id)"
        >
          Карточка
        </button>
      </div>

      <div class="billboard__bar">
        <div
          class="billboard__fill"
          :style="{
            width: `${Math.min(100, item.sector.progress_percent)}%`,
            background: progressColor(item.sector),
          }"
        />
      </div>

      <div class="billboard__meta">
        <span class="billboard__percent">{{ item.sector.progress_percent.toFixed(1) }} %</span>
        <span v-if="item.sector.height > 0" class="billboard__volume">
          {{ volumeLabel(item.sector) }}
        </span>
      </div>

      <div class="billboard__brigades">
        <span
          v-for="brigade in item.sector.brigades"
          :key="brigade.id"
          class="billboard__brigade"
          :draggable="canEdit"
          :title="
            canEdit
              ? `Перетащите, чтобы переназначить: ${brigade.name}`
              : brigade.name
          "
          @dragstart="onBrigadeDragStart($event, brigade.id)"
          @dragend="onBrigadeDragEnd"
          @click.stop
        >
          {{ brigade.name }}
        </span>
        <span
          v-if="!item.sector.brigades.length"
          class="billboard__brigade billboard__brigade--empty"
        >
          бригада не назначена
        </span>
      </div>

      <div v-if="item.sector.open_problems > 0" class="billboard__problems">
        ⚠ проблем: {{ item.sector.open_problems }}
      </div>

      <div class="billboard__pin" />
    </div>
  </div>
</template>

<style scoped>
.billboards {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
}

.billboard {
  position: absolute;
  top: 0;
  left: 0;
  min-width: 186px;
  max-width: 260px;
  padding: 8px 10px 10px;
  border-radius: 10px;
  background: rgba(17, 22, 30, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: #e6edf3;
  font-size: 12px;
  line-height: 1.35;
  pointer-events: auto;
  cursor: pointer;
  backdrop-filter: blur(6px);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
  transition: border-color 0.15s ease, opacity 0.15s ease;
}

.billboard.is-selected {
  border-color: #2f81f7;
  box-shadow: 0 0 0 1px #2f81f7, 0 8px 22px rgba(0, 0, 0, 0.45);
}

.billboard.is-drop-target {
  border-color: #ffc857;
  box-shadow: 0 0 0 2px rgba(255, 200, 87, 0.6);
}

.billboard.is-ghost {
  opacity: 0.45;
}

.billboard__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.billboard__title {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.billboard__card-btn {
  flex: none;
  padding: 2px 7px;
  border-radius: 6px;
  border: 1px solid rgba(47, 129, 247, 0.5);
  background: rgba(47, 129, 247, 0.2);
  color: #cfe2ff;
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}

.billboard__card-btn:hover {
  background: rgba(47, 129, 247, 0.35);
}

.billboard__bar {
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.12);
  overflow: hidden;
}

.billboard__fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.25s ease;
}

.billboard__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
}

.billboard__percent {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.billboard__volume {
  font-size: 11px;
  color: #8b949e;
  font-variant-numeric: tabular-nums;
}

.billboard__brigades {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}

.billboard__brigade {
  padding: 2px 6px;
  border-radius: 6px;
  background: rgba(47, 129, 247, 0.22);
  border: 1px solid rgba(47, 129, 247, 0.4);
  cursor: grab;
  white-space: nowrap;
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 11px;
}

.billboard__brigade--empty {
  background: transparent;
  border-color: rgba(255, 255, 255, 0.16);
  color: #8b949e;
  cursor: default;
}

.billboard__problems {
  margin-top: 6px;
  color: #ff9f9a;
}

.billboard__pin {
  position: absolute;
  bottom: -7px;
  left: 50%;
  width: 12px;
  height: 12px;
  transform: translateX(-50%) rotate(45deg);
  background: rgba(17, 22, 30, 0.9);
  border-right: 1px solid rgba(255, 255, 255, 0.14);
  border-bottom: 1px solid rgba(255, 255, 255, 0.14);
}
</style>
