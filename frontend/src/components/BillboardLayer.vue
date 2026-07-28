<script setup lang="ts">
/**
 * 3D-виджеты над зонами (п. 5.2 ТЗ): процент выполнения и название бригады.
 *
 * Это HTML-слой поверх канваса: точки привязки проецируются камерой в экранные
 * координаты каждый второй кадр. Так виджеты остаются обычным DOM — их можно
 * стилизовать, кликать и использовать как цель для drag-and-drop.
 */
import { computed, ref, watch } from 'vue'
import * as THREE from 'three'

import type { SectorSummary } from '@/api/types'
import { billboardAnchor } from '@/three/geometry'
import {
  draggingBrigadeId,
  dragHoverSectorId,
  frameTick,
  sceneCamera,
  sceneRenderer,
} from '@/three/sceneBus'

const props = defineProps<{
  sectors: SectorSummary[]
  selectedId: number | null
}>()

const emit = defineEmits<{
  (e: 'select', sectorId: number): void
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

  placed.value = props.sectors.map((sector) => {
    const anchor = billboardAnchor(sector.coordinates, 2.2)
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
watch(() => props.sectors, project, { deep: true, immediate: true })

const ordered = computed(() => [...placed.value].sort((a, b) => b.depth - a.depth))

function progressColor(sector: SectorSummary): string {
  if (sector.open_problems > 0) return '#e5534b'
  if (sector.progress_percent >= 100) return '#3fb950'
  if (sector.progress_percent > 0) return '#2f81f7'
  return '#8b9bb4'
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

/** Перетаскивание бригады из одного сектора в другой прямо с виджета. */
function onBrigadeDragStart(event: DragEvent, sector: SectorSummary): void {
  const brigadeId = sector.brigade?.id
  if (brigadeId === undefined) return
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
</script>

<template>
  <div class="billboards">
    <div
      v-for="item in ordered"
      v-show="item.visible"
      :key="item.sector.id"
      class="billboard"
      :class="{
        'is-selected': item.sector.id === selectedId,
        'is-drop-target': item.sector.id === dragHoverSectorId,
      }"
      :style="{ transform: `translate(-50%, -100%) translate(${item.x}px, ${item.y}px)` }"
      @click.stop="emit('select', item.sector.id)"
      @dragover="onDragOver($event, item.sector.id)"
      @drop="onDrop($event, item.sector.id)"
    >
      <div class="billboard__title">{{ item.sector.name }}</div>

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
        <span
          v-if="item.sector.brigade"
          class="billboard__brigade"
          draggable="true"
          :title="`Перетащите, чтобы переназначить: ${item.sector.brigade.name}`"
          @dragstart="onBrigadeDragStart($event, item.sector)"
          @dragend="onBrigadeDragEnd"
          @click.stop
        >
          {{ item.sector.brigade.name }}
        </span>
        <span v-else class="billboard__brigade billboard__brigade--empty">бригада не назначена</span>
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
  min-width: 168px;
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
  transition: border-color 0.15s ease, transform 0.05s linear;
}

.billboard.is-selected {
  border-color: #2f81f7;
  box-shadow: 0 0 0 1px #2f81f7, 0 8px 22px rgba(0, 0, 0, 0.45);
}

.billboard.is-drop-target {
  border-color: #ffc857;
  box-shadow: 0 0 0 2px rgba(255, 200, 87, 0.6);
}

.billboard__title {
  font-weight: 600;
  margin-bottom: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 220px;
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
