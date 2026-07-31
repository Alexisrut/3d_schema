<script setup lang="ts">
/** Сборка 3D-сцены: канвас TresJS, свет, слои моделей, зоны и черновик. */
import { computed, ref } from 'vue'
import { TresCanvas } from '@tresjs/core'

import type { Level, ProjectModel, SectorSummary } from '@/api/types'
import type { SelectMode, Visibility } from '@/lib/selection'
import type { VertexRing } from '@/three/sceneBus'
import { polygonArea3D } from '@/three/geometry'
import DraftPolygon from './DraftPolygon.vue'
import ModelLayer from './ModelLayer.vue'
import LevelPlanes from './LevelPlanes.vue'
import SceneBridge from './SceneBridge.vue'
import SectorPolygons from './SectorPolygons.vue'
import VertexHandles from './VertexHandles.vue'

const props = defineProps<{
  /** Слои .glb с уже подставленным токеном. */
  layers: Array<ProjectModel & { url: string }>
  layerVisibility: Record<number, Visibility>
  sectors: SectorSummary[]
  highlightedSectorIds: number[]
  sectorVisibility: Record<number, Visibility>
  selectedMeshName: string | null
  /** Приглушить все слои: внимание отдано зонам. */
  ghostAll: boolean
  drawing: boolean
  draftPoints: number[][]
  draftHeight: number
  editMode: boolean
  /** Зона, вершины которой можно перетаскивать. */
  editSector: SectorSummary | null
  /** Закреплённые этажи и выбранные для фильтрации. */
  levels: Level[]
  selectedLevelIds: number[]
  /** Отметка, снятая с детали, но ещё не закреплённая. */
  draftElevation: number | null
  /** Границы отсечения по вертикали; null — без ограничения. */
  clipMin: number | null
  clipMax: number | null
}>()

const emit = defineEmits<{
  (e: 'point', point: [number, number, number]): void
  (e: 'select-sector', payload: { sectorId: number; mode: SelectMode }): void
  (e: 'select-mesh', name: string): void
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
  (e: 'model-loaded'): void
  (e: 'model-error', message: string): void
}>()

const bridge = ref<InstanceType<typeof SceneBridge> | null>(null)

/**
 * Радиус маркера вершины — от размера самой зоны.
 *
 * Фиксированный радиус на объекте в сотню метров превращается в невидимую
 * точку, а на зоне 2×2 м закрывает её целиком.
 */
const handleRadius = computed(() => {
  const sector = props.editSector
  if (!sector) return 0.3
  const area = polygonArea3D(sector.coordinates)
  const span = Math.sqrt(Math.max(area, 1))
  return Math.min(1.2, Math.max(0.18, span * 0.05))
})

function ghostFor(layerId: number): boolean {
  return props.ghostAll || props.layerVisibility[layerId] === 'ghost'
}

defineExpose({
  resetView: () => bridge.value?.resetView(),
})
</script>

<template>
  <TresCanvas clear-color="#0d1117" :antialias="true" :alpha="false">
    <TresPerspectiveCamera :position="[45, 34, 45]" :fov="50" :near="0.1" :far="5000" />

    <TresAmbientLight :intensity="1.9" />
    <TresDirectionalLight :position="[60, 90, 40]" :intensity="2.4" />
    <TresDirectionalLight :position="[-50, 40, -60]" :intensity="0.9" />
    <TresGridHelper :args="[400, 80, 0x30363d, 0x1c2128]" />

    <SceneBridge
      ref="bridge"
      :drawing="drawing"
      :edit-mode="editMode"
      :clip-min="clipMin"
      :clip-max="clipMax"
      @point="emit('point', $event)"
      @select-sector="emit('select-sector', $event)"
      @select-mesh="emit('select-mesh', $event)"
      @pick-elevation="emit('pick-elevation', $event)"
      @clear-selection="emit('clear-selection')"
      @drop-brigade="emit('drop-brigade', $event)"
      @vertex-move="emit('vertex-move', $event)"
      @vertex-commit="emit('vertex-commit', $event)"
    />

    <!-- Скрытые слои не монтируются: их геометрия уходит из видеопамяти. -->
    <ModelLayer
      v-for="layer in layers"
      :key="layer.id"
      :url="layer.url"
      :label="layer.name"
      :highlight-name="selectedMeshName"
      :ghost="ghostFor(layer.id)"
      @loaded="emit('model-loaded')"
      @error="emit('model-error', $event)"
    />

    <SectorPolygons
      :sectors="sectors"
      :highlighted-ids="highlightedSectorIds"
      :visibility="sectorVisibility"
    />

    <LevelPlanes
      :levels="levels"
      :selected-ids="selectedLevelIds"
      :draft-elevation="draftElevation"
    />

    <VertexHandles :sector="editSector" :radius="handleRadius" />

    <DraftPolygon :points="draftPoints" :height="draftHeight" />
  </TresCanvas>
</template>
