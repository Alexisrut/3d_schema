<script setup lang="ts">
/** Сборка 3D-сцены: канвас TresJS, свет, модель, зоны и черновик разметки. */
import { ref } from 'vue'
import { TresCanvas } from '@tresjs/core'

import type { SectorSummary } from '@/api/types'
import DraftPolygon from './DraftPolygon.vue'
import ModelObject from './ModelObject.vue'
import SceneBridge from './SceneBridge.vue'
import SectorPolygons from './SectorPolygons.vue'

defineProps<{
  modelUrl: string | null
  sectors: SectorSummary[]
  selectedSectorId: number | null
  selectedMeshName: string | null
  ghostAll: boolean
  drawing: boolean
  draftPoints: number[][]
}>()

const emit = defineEmits<{
  (e: 'point', point: [number, number, number]): void
  (e: 'select-sector', sectorId: number): void
  (e: 'select-mesh', name: string): void
  (e: 'clear-selection'): void
  (e: 'drop-brigade', payload: { sectorId: number; brigadeId: number }): void
  (e: 'model-loaded'): void
  (e: 'model-error', message: string): void
}>()

const bridge = ref<InstanceType<typeof SceneBridge> | null>(null)

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
      @point="emit('point', $event)"
      @select-sector="emit('select-sector', $event)"
      @select-mesh="emit('select-mesh', $event)"
      @clear-selection="emit('clear-selection')"
      @drop-brigade="emit('drop-brigade', $event)"
    />

    <ModelObject
      :url="modelUrl"
      :highlight-name="selectedMeshName"
      :ghost-all="ghostAll"
      @loaded="emit('model-loaded')"
      @error="emit('model-error', $event)"
    />

    <SectorPolygons :sectors="sectors" :selected-id="selectedSectorId" />

    <DraftPolygon :points="draftPoints" />
  </TresCanvas>
</template>
