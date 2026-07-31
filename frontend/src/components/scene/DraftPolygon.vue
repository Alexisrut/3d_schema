<script setup lang="ts">
/**
 * Черновик зоны во время разметки.
 *
 * Шаг 1 («polygon»): маркеры опорных точек и контур между ними; пока точек
 * меньше трёх — только линия, заливка появляется с третьей.
 * Шаг 2 («extrude»): та же площадь, вытянутая вверх на заданную высоту, —
 * пользователь видит будущий объём зоны до её закрепления.
 */
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import * as THREE from 'three'

import { buildPolygonGeometry, buildPrismGeometry } from '@/three/geometry'
import { invalidateScene } from '@/three/sceneBus'

const props = defineProps<{
  points: number[][]
  /** Высота выдавливания; 0 — идёт первый шаг разметки. */
  height: number
}>()

const group = shallowRef<THREE.Group | null>(null)
/** Входит в :key, чтобы Vue заменил <primitive> новым объектом, а не пытался
 *  переиспользовать прежний узел сцены. */
const revision = ref(0)

const markerGeometry = new THREE.SphereGeometry(0.22, 16, 12)
const markerMaterial = new THREE.MeshBasicMaterial({ color: 0xffc857, depthTest: false })
const firstMarkerMaterial = new THREE.MeshBasicMaterial({ color: 0x3fb950, depthTest: false })
const lineMaterial = new THREE.LineBasicMaterial({ color: 0xffc857, depthTest: false })
const fillMaterial = new THREE.MeshBasicMaterial({
  color: 0xffc857,
  transparent: true,
  opacity: 0.25,
  side: THREE.DoubleSide,
  depthWrite: false,
  depthTest: false,
})
/** Объём предпросмотра — заметно прозрачнее заливки, чтобы сквозь него была
 *  видна модель и уже размеченные зоны. */
const volumeMaterial = new THREE.MeshBasicMaterial({
  color: 0xffc857,
  transparent: true,
  opacity: 0.16,
  side: THREE.DoubleSide,
  depthWrite: false,
})

function disposeGroup(): void {
  const current = group.value
  if (!current) return
  current.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (mesh.geometry && mesh.geometry !== markerGeometry) mesh.geometry.dispose()
  })
  current.clear()
  group.value = null
}

function rebuild(): void {
  disposeGroup()
  revision.value += 1
  if (props.points.length === 0) return

  const next = new THREE.Group()
  next.name = 'draft-polygon'
  next.renderOrder = 10

  props.points.forEach((point, index) => {
    const marker = new THREE.Mesh(
      markerGeometry,
      index === 0 ? firstMarkerMaterial : markerMaterial,
    )
    marker.position.set(point[0], point[1], point[2])
    marker.renderOrder = 11
    next.add(marker)
  })

  if (props.points.length >= 2) {
    const vertices = props.points.map((p) => new THREE.Vector3(p[0], p[1], p[2]))
    if (props.points.length >= 3) vertices.push(vertices[0].clone())
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(vertices), lineMaterial)
    line.renderOrder = 11
    next.add(line)
  }

  if (props.points.length >= 3) {
    const { positions, indices } = buildPolygonGeometry(props.points, 0.04)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setIndex(indices)
    geometry.computeVertexNormals()
    const fill = new THREE.Mesh(geometry, fillMaterial)
    fill.renderOrder = 10
    next.add(fill)
  }

  // Предпросмотр объёма: сам корпус и рёбра, чтобы высота читалась.
  if (props.points.length >= 3 && props.height > 0) {
    const prism = buildPrismGeometry(props.points, props.height, 0.04)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(prism.positions, 3))
    geometry.setIndex(prism.indices)
    geometry.computeVertexNormals()
    const volume = new THREE.Mesh(geometry, volumeMaterial)
    volume.renderOrder = 9
    next.add(volume)

    const top = props.points.map(
      (p) => new THREE.Vector3(p[0], p[1] + props.height, p[2]),
    )
    top.push(top[0].clone())
    const topLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(top), lineMaterial)
    topLine.renderOrder = 11
    next.add(topLine)

    // Вертикальные рёбра: без них верхний контур «висит в воздухе».
    for (const point of props.points) {
      const edge = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(point[0], point[1], point[2]),
          new THREE.Vector3(point[0], point[1] + props.height, point[2]),
        ]),
        lineMaterial,
      )
      edge.renderOrder = 11
      next.add(edge)
    }
  }

  group.value = next
  invalidateScene()
}

watch(() => [props.points, props.height], rebuild, { deep: true, immediate: true })

onBeforeUnmount(() => {
  disposeGroup()
  markerGeometry.dispose()
  markerMaterial.dispose()
  firstMarkerMaterial.dispose()
  lineMaterial.dispose()
  fillMaterial.dispose()
  volumeMaterial.dispose()
})
</script>

<template>
  <primitive v-if="group" :key="revision" :object="group" />
</template>
