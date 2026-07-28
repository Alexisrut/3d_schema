<script setup lang="ts">
/**
 * Полигоны секторов поверх .glb-модели (п. 5.2 ТЗ).
 * Цвет зоны отражает состояние: выбрана / есть открытые проблемы / прогресс.
 */
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import * as THREE from 'three'

import type { SectorSummary } from '@/api/types'
import { buildPolygonGeometry } from '@/three/geometry'
import { dragHoverSectorId, registerSectorMesh } from '@/three/sceneBus'

const props = defineProps<{
  sectors: SectorSummary[]
  selectedId: number | null
}>()

const meshes = shallowRef<THREE.Mesh[]>([])
/** Растёт при каждой пересборке: входит в :key, чтобы Vue заменил <primitive>,
 *  а не пытался переиспользовать узел со старым объектом three.js. */
const revision = ref(0)

const COLOR_SELECTED = 0x2f81f7
const COLOR_DROP = 0xffc857
const COLOR_PROBLEM = 0xe5534b
const COLOR_DONE = 0x3fb950
const COLOR_DEFAULT = 0x8b9bb4

function colorFor(sector: SectorSummary): number {
  if (sector.id === props.selectedId) return COLOR_SELECTED
  if (sector.id === dragHoverSectorId.value) return COLOR_DROP
  if (sector.open_problems > 0) return COLOR_PROBLEM
  if (sector.progress_percent >= 100) return COLOR_DONE
  return COLOR_DEFAULT
}

function buildMesh(sector: SectorSummary): THREE.Mesh | null {
  if (!sector.coordinates || sector.coordinates.length < 3) return null

  const { positions, indices, normal } = buildPolygonGeometry(sector.coordinates, 0.06)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()

  const material = new THREE.MeshStandardMaterial({
    color: colorFor(sector),
    transparent: true,
    opacity: sector.id === props.selectedId ? 0.62 : 0.42,
    side: THREE.DoubleSide,
    depthWrite: false,
    // Гарантированно кладём зону поверх плиты, без мерцания.
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    roughness: 0.8,
    metalness: 0,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = `sector-${sector.id}`
  mesh.userData.sectorId = sector.id
  mesh.renderOrder = 2

  // Контур зоны — чтобы границы читались даже при малой непрозрачности.
  // Смещаем его вдоль той же нормали, что и заливку: иначе на вертикальных
  // зонах (стена, фасад) контур утонул бы в геометрии здания.
  const lift = 0.07
  const outlinePoints = sector.coordinates.map(
    (p) =>
      new THREE.Vector3(
        p[0] + normal[0] * lift,
        p[1] + normal[1] * lift,
        p[2] + normal[2] * lift,
      ),
  )
  if (outlinePoints.length > 0) {
    outlinePoints.push(outlinePoints[0].clone())
    const outlineGeometry = new THREE.BufferGeometry().setFromPoints(outlinePoints)
    const outline = new THREE.Line(
      outlineGeometry,
      new THREE.LineBasicMaterial({ color: colorFor(sector), transparent: true, opacity: 0.95 }),
    )
    outline.name = `sector-outline-${sector.id}`
    outline.userData.sectorId = sector.id
    outline.renderOrder = 3
    mesh.add(outline)
  }

  return mesh
}

function disposeMesh(mesh: THREE.Mesh): void {
  registerSectorMesh(mesh.userData.sectorId as number, null)
  mesh.traverse((child) => {
    const asMesh = child as THREE.Mesh
    asMesh.geometry?.dispose?.()
    const material = (child as THREE.Mesh).material
    if (Array.isArray(material)) material.forEach((m) => m.dispose())
    else material?.dispose?.()
  })
}

function rebuild(): void {
  meshes.value.forEach(disposeMesh)
  const next: THREE.Mesh[] = []
  for (const sector of props.sectors) {
    const mesh = buildMesh(sector)
    if (mesh) {
      next.push(mesh)
      registerSectorMesh(sector.id, mesh)
    }
  }
  meshes.value = next
  revision.value += 1
}

/** Перекраска без пересборки геометрии — выделение и подсветка при drag'n'drop. */
function repaint(): void {
  for (const mesh of meshes.value) {
    const sector = props.sectors.find((s) => s.id === mesh.userData.sectorId)
    if (!sector) continue
    const color = colorFor(sector)
    const material = mesh.material as THREE.MeshStandardMaterial
    material.color.setHex(color)
    material.opacity = sector.id === props.selectedId ? 0.62 : 0.42
    // needsUpdate здесь не нужен: цвет и прозрачность — это uniform'ы,
    // а флаг заставил бы пересобирать шейдеры на каждое движение мыши
    // при перетаскивании бригады.
    for (const child of mesh.children) {
      const line = child as THREE.Line
      const lineMaterial = line.material as THREE.LineBasicMaterial | undefined
      lineMaterial?.color?.setHex(color)
    }
  }
}

/** Геометрию пересобираем только когда изменились сами зоны. */
const geometrySignature = () =>
  props.sectors
    .map((s) => `${s.id}:${s.coordinates.length}:${s.coordinates.flat().join(',')}`)
    .join('|')

watch(geometrySignature, rebuild, { immediate: true })

watch(
  () => [
    props.selectedId,
    dragHoverSectorId.value,
    props.sectors.map((s) => `${s.progress_percent}:${s.open_problems}`).join('|'),
  ],
  repaint,
)

onBeforeUnmount(() => {
  meshes.value.forEach(disposeMesh)
  meshes.value = []
})
</script>

<template>
  <primitive v-for="mesh in meshes" :key="`${mesh.name}-${revision}`" :object="mesh" />
</template>
