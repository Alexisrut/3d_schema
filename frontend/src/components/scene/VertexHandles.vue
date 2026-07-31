<script setup lang="ts">
/**
 * Маркеры вершин редактируемой зоны (п. 1.2 доработок).
 *
 * В режиме редактирования на углах активной зоны появляются шарики, за
 * которые границу можно перетащить мышью. Сам захват и перемещение живут в
 * SceneBridge — здесь только геометрия маркеров и их регистрация в шине,
 * чтобы по ним работал raycast.
 *
 * Маркеры намеренно рисуются без depthTest: вершина, оказавшаяся за стеной,
 * должна оставаться видимой и доступной, иначе часть границы зоны нельзя
 * было бы поправить, не облетев здание.
 */
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue'
import * as THREE from 'three'

import type { SectorSummary } from '@/api/types'
import { defaultTopPoints } from '@/three/geometry'
import {
  clearVertexHandles,
  draggingVertex,
  hoveredVertexKey,
  registerVertexHandle,
  vertexKey,
} from '@/three/sceneBus'

const props = defineProps<{
  /** Зона, границы которой правим, либо null. */
  sector: SectorSummary | null
  /** Радиус маркера в метрах — подбирается по размеру зоны. */
  radius: number
}>()

/**
 * Маркеры ставятся на ДВА кольца: основание и верхняя грань объёма.
 *
 * Верхние точки (п. 3.3 доработок) позволяют задать форму верха отдельно от
 * низа — чтобы зона огибала выступы и уступы здания, а не была ровной
 * призмой. У плоской зоны (height = 0) верхнего кольца нет.
 */

const group = shallowRef<THREE.Group | null>(null)

const COLOR_IDLE = 0xffc857
/** Верхнее кольцо — голубое: на виде сверху иначе не отличить от нижнего. */
const COLOR_TOP = 0x58a6ff
const COLOR_HOVER = 0xffffff
const COLOR_ACTIVE = 0x3fb950

/** Одна геометрия на все маркеры: их единицы, но пересоздавать её незачем. */
const sphere = new THREE.SphereGeometry(1, 16, 12)

const points = computed(() => props.sector?.coordinates ?? [])

/**
 * Верхнее кольцо: правленая грань, если она есть, иначе основание,
 * поднятое на высоту. Для плоской зоны кольца нет.
 */
const topPoints = computed<number[][]>(() => {
  const sector = props.sector
  if (!sector || !(sector.height > 0)) return []
  if (sector.top_coordinates && sector.top_coordinates.length === points.value.length) {
    return sector.top_coordinates
  }
  return defaultTopPoints(points.value, sector.height)
})

function disposeGroup(): void {
  const current = group.value
  if (!current) return
  current.traverse((child) => {
    const mesh = child as THREE.Mesh
    // Общая геометрия sphere переиспользуется — её не трогаем.
    if (mesh.material) {
      const material = mesh.material
      if (Array.isArray(material)) material.forEach((m) => m.dispose())
      else material.dispose()
    }
  })
  current.clear()
  group.value = null
  clearVertexHandles()
}

function rebuild(): void {
  disposeGroup()
  const sector = props.sector
  if (!sector || points.value.length === 0) return

  const next = new THREE.Group()
  next.name = 'vertex-handles'
  next.renderOrder = 20

  const addRing = (ring: number[][], ringName: 'base' | 'top', color: number): void => {
    ring.forEach((point, index) => {
      const key = vertexKey(sector.id, index, ringName)
      const material = new THREE.MeshBasicMaterial({
        color,
        depthTest: false,
        transparent: true,
        opacity: 0.95,
      })
      const marker = new THREE.Mesh(sphere, material)
      marker.name = `vertex-${key}`
      marker.scale.setScalar(props.radius)
      marker.position.set(point[0], point[1], point[2])
      marker.renderOrder = 21
      marker.userData.sectorId = sector.id
      marker.userData.vertexIndex = index
      marker.userData.vertexRing = ringName
      marker.userData.vertexKey = key
      next.add(marker)
      registerVertexHandle(key, marker)
    })
  }

  addRing(points.value, 'base', COLOR_IDLE)
  // Верхнее кольцо другого цвета: иначе на виде сверху низ и верх сливаются
  // и непонятно, за какую точку тянешь.
  addRing(topPoints.value, 'top', COLOR_TOP)

  group.value = next
}

/** Перекраска и масштаб без пересборки: наведение и захват меняются часто. */
function repaint(): void {
  const current = group.value
  if (!current) return
  for (const child of current.children) {
    const marker = child as THREE.Mesh
    const key = marker.userData.vertexKey as string
    const ring = marker.userData.vertexRing as 'base' | 'top'
    const active = draggingVertex.value
    const isActive =
      active !== null && vertexKey(active.sectorId, active.index, active.ring) === key
    const isHovered = hoveredVertexKey.value === key
    const base = ring === 'top' ? COLOR_TOP : COLOR_IDLE
    const material = marker.material as THREE.MeshBasicMaterial
    material.color.setHex(isActive ? COLOR_ACTIVE : isHovered ? COLOR_HOVER : base)
    marker.scale.setScalar(props.radius * (isActive || isHovered ? 1.45 : 1))
  }
}

/**
 * Позиции обновляем на месте, без пересборки группы.
 *
 * Во время перетаскивания координаты меняются каждый кадр: пересоздание
 * маркеров означало бы, что тот, за который держится курсор, исчезает из
 * карты raycast'а прямо в процессе движения.
 */
function syncPositions(): void {
  const current = group.value
  if (!current) return
  const rings = { base: points.value, top: topPoints.value }
  for (const child of current.children) {
    const ring = child.userData.vertexRing as 'base' | 'top'
    const index = child.userData.vertexIndex as number
    const point = rings[ring]?.[index]
    if (point) child.position.set(point[0], point[1], point[2])
  }
}

watch(
  // Пересборка нужна, когда меняется НАБОР маркеров: другая зона, другое
  // число вершин или появление/исчезновение верхнего кольца.
  () => [props.sector?.id, points.value.length, topPoints.value.length],
  rebuild,
  { immediate: true },
)

watch(
  () => [
    points.value.map((p) => p.join(',')).join('|'),
    topPoints.value.map((p) => p.join(',')).join('|'),
  ],
  syncPositions,
)
watch([draggingVertex, hoveredVertexKey, () => props.radius], repaint)

onBeforeUnmount(() => {
  disposeGroup()
  sphere.dispose()
})
</script>

<template>
  <primitive v-if="group" :object="group" />
</template>
