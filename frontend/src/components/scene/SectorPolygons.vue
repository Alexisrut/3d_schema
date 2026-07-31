<script setup lang="ts">
/**
 * Зоны поверх .glb-модели (п. 5.2 ТЗ).
 *
 * Зона с height > 0 рисуется объёмом (призмой), с height = 0 — плоским
 * полигоном. Цвет отражает состояние: выбрана / есть открытые проблемы /
 * прогресс. Прозрачность зоны переключает пользователь (режим ghost/скрыто).
 */
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import * as THREE from 'three'

import type { SectorSummary } from '@/api/types'
import { buildPrismGeometry } from '@/three/geometry'
import type { Visibility } from '@/lib/selection'
import { dragHoverSectorId, registerSectorMesh } from '@/three/sceneBus'

const props = defineProps<{
  sectors: SectorSummary[]
  /** Выделенные зоны: явные + зоны выбранных бригад. */
  highlightedIds: number[]
  /** Прозрачность по зонам: normal / ghost / hidden. */
  visibility: Record<number, Visibility>
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

/** Непрозрачность заливки: выбранная зона, обычная и приглушённая. */
const OPACITY_SELECTED = 0.55
const OPACITY_NORMAL = 0.34
const OPACITY_DIMMED = 0.12
const OPACITY_GHOST = 0.07

const highlighted = computed(() => new Set(props.highlightedIds))
/** Зоны прячем целиком, но меш оставляем в сцене невидимым: пересобирать
 *  геометрию на каждое нажатие кнопки прозрачности незачем. */
const hiddenSet = computed(
  () => new Set(props.sectors.filter((s) => props.visibility[s.id] === 'hidden').map((s) => s.id)),
)

function colorFor(sector: SectorSummary): number {
  if (highlighted.value.has(sector.id)) return COLOR_SELECTED
  if (sector.id === dragHoverSectorId.value) return COLOR_DROP
  if (sector.open_problems > 0) return COLOR_PROBLEM
  if (sector.progress_percent >= 100) return COLOR_DONE
  return COLOR_DEFAULT
}

function opacityFor(sector: SectorSummary): number {
  if (props.visibility[sector.id] === 'ghost') return OPACITY_GHOST
  if (highlighted.value.has(sector.id)) return OPACITY_SELECTED
  // Когда что-то выделено, остальные зоны приглушаются: внимание на выборе.
  if (highlighted.value.size > 0) return OPACITY_DIMMED
  return OPACITY_NORMAL
}

function buildMesh(sector: SectorSummary): THREE.Mesh | null {
  if (!sector.coordinates || sector.coordinates.length < 3) return null

  const { positions, indices, normal } = buildPrismGeometry(
    sector.coordinates,
    sector.height,
    0.06,
    sector.top_coordinates,
  )
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  geometry.computeBoundingSphere()

  const material = new THREE.MeshStandardMaterial({
    color: colorFor(sector),
    transparent: true,
    opacity: opacityFor(sector),
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
  // Нормаль плоскости зоны нужна SceneBridge: вершину при перетаскивании
  // держим именно в этой плоскости, иначе полигон перестанет быть плоским.
  mesh.userData.planeNormal = normal
  mesh.renderOrder = 2
  mesh.visible = !hiddenSet.value.has(sector.id)

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
    addOutline(mesh, outlinePoints, sector, `sector-outline-${sector.id}`)
    // У объёмной зоны обводим и верхнюю грань: без неё призма читается как
    // плоское пятно с размытыми боками.
    if (sector.height > 0 || sector.top_coordinates) {
      // Верхний контур идёт по правленой грани, если она задана: иначе
      // обводка висела бы на исходной высоте, отдельно от самой зоны.
      const top =
        sector.top_coordinates && sector.top_coordinates.length === sector.coordinates.length
          ? sector.top_coordinates.map((p) => new THREE.Vector3(p[0], p[1], p[2]))
          : outlinePoints.map((p) => new THREE.Vector3(p.x, p.y + sector.height, p.z))
      if (top.length > 0) top.push(top[0].clone())
      addOutline(mesh, top, sector, `sector-outline-top-${sector.id}`)
    }
  }

  return mesh
}

function addOutline(
  mesh: THREE.Mesh,
  points: THREE.Vector3[],
  sector: SectorSummary,
  name: string,
): void {
  const geometry = new THREE.BufferGeometry().setFromPoints(points)
  const outline = new THREE.Line(
    geometry,
    new THREE.LineBasicMaterial({
      color: colorFor(sector),
      transparent: true,
      opacity: outlineOpacityFor(sector),
    }),
  )
  outline.name = name
  outline.userData.sectorId = sector.id
  outline.renderOrder = 3
  mesh.add(outline)
}

function outlineOpacityFor(sector: SectorSummary): number {
  if (props.visibility[sector.id] === 'ghost') return 0.25
  if (highlighted.value.size > 0 && !highlighted.value.has(sector.id)) return 0.35
  return 0.95
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

/** Перекраска без пересборки геометрии — выделение, подсветка, прозрачность. */
function repaint(): void {
  for (const mesh of meshes.value) {
    const sector = props.sectors.find((s) => s.id === mesh.userData.sectorId)
    if (!sector) continue
    const color = colorFor(sector)
    const material = mesh.material as THREE.MeshStandardMaterial
    material.color.setHex(color)
    material.opacity = opacityFor(sector)
    mesh.visible = !hiddenSet.value.has(sector.id)
    // needsUpdate здесь не нужен: цвет и прозрачность — это uniform'ы,
    // а флаг заставил бы пересобирать шейдеры на каждое движение мыши
    // при перетаскивании бригады.
    for (const child of mesh.children) {
      const line = child as THREE.Line
      const lineMaterial = line.material as THREE.LineBasicMaterial | undefined
      lineMaterial?.color?.setHex(color)
      if (lineMaterial) lineMaterial.opacity = outlineOpacityFor(sector)
    }
  }
}

/** Геометрию пересобираем только когда изменились форма или высота зон. */
const geometrySignature = () =>
  props.sectors
    .map(
      (s) =>
        `${s.id}:${s.height}:${s.coordinates.flat().join(',')}:${(s.top_coordinates ?? []).flat().join(',')}`,
    )
    .join('|')

watch(geometrySignature, rebuild, { immediate: true })

watch(
  () => [
    props.highlightedIds.join(','),
    dragHoverSectorId.value,
    props.sectors.map((s) => `${s.progress_percent}:${s.open_problems}`).join('|'),
    props.sectors.map((s) => props.visibility[s.id] ?? 'normal').join('|'),
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
