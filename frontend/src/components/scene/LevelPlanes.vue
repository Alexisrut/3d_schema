<script setup lang="ts">
/**
 * Плоскости этажей в сцене (п. 3.1 доработок).
 *
 * Рисуются две вещи:
 *  • «черновая» отметка — снятая с только что выбранной детали модели; по ней
 *    видно, где ляжет будущий этаж, ещё до его закрепления;
 *  • закреплённые уровни — тонкие плоскости с рамкой; выбранные для фильтра
 *    подсвечиваются.
 *
 * Размер плоскости берётся от габаритов модели: фиксированный размер на
 * объекте в сотню метров выглядел бы ковриком под зданием.
 */
import { onBeforeUnmount, shallowRef, watch } from 'vue'
import * as THREE from 'three'

import type { Level } from '@/api/types'
import { modelRoots } from '@/three/sceneBus'

const props = defineProps<{
  levels: Level[]
  selectedIds: number[]
  /** Отметка, снятая с детали, но ещё не закреплённая. */
  draftElevation: number | null
}>()

const group = shallowRef<THREE.Group | null>(null)

const COLOR_LEVEL = 0x58a6ff
const COLOR_SELECTED = 0x3fb950
const COLOR_DRAFT = 0xffc857

/** Запас вокруг габаритов модели, чтобы плоскость выступала за фасад. */
const MARGIN = 4

function modelExtent(): { size: number; centerX: number; centerZ: number } {
  const box = new THREE.Box3()
  for (const root of modelRoots.value) box.expandByObject(root)
  if (box.isEmpty()) return { size: 60, centerX: 0, centerZ: 0 }
  const size = new THREE.Vector3()
  const center = new THREE.Vector3()
  box.getSize(size)
  box.getCenter(center)
  return {
    size: Math.max(size.x, size.z) + MARGIN * 2,
    centerX: center.x,
    centerZ: center.z,
  }
}

function makePlane(
  elevation: number,
  color: number,
  opacity: number,
  extent: ReturnType<typeof modelExtent>,
): THREE.Object3D {
  const node = new THREE.Group()
  node.position.set(extent.centerX, elevation, extent.centerZ)

  const geometry = new THREE.PlaneGeometry(extent.size, extent.size)
  // PlaneGeometry строится в XY — кладём её горизонтально.
  geometry.rotateX(-Math.PI / 2)
  const fill = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  )
  fill.renderOrder = 1
  node.add(fill)

  // Рамка: по заливке с малой непрозрачностью отметку не поймать глазом.
  const half = extent.size / 2
  const outline = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-half, 0, -half),
      new THREE.Vector3(half, 0, -half),
      new THREE.Vector3(half, 0, half),
      new THREE.Vector3(-half, 0, half),
    ]),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }),
  )
  outline.renderOrder = 2
  node.add(outline)

  return node
}

function dispose(): void {
  const current = group.value
  if (!current) return
  current.traverse((child) => {
    const mesh = child as THREE.Mesh
    mesh.geometry?.dispose?.()
    const material = mesh.material
    if (Array.isArray(material)) material.forEach((m) => m.dispose())
    else material?.dispose?.()
  })
  current.clear()
  group.value = null
}

function rebuild(): void {
  dispose()
  const hasDraft = props.draftElevation !== null
  if (props.levels.length === 0 && !hasDraft) return

  const extent = modelExtent()
  const next = new THREE.Group()
  next.name = 'level-planes'

  for (const level of props.levels) {
    const selected = props.selectedIds.includes(level.id)
    next.add(
      makePlane(
        level.elevation,
        selected ? COLOR_SELECTED : COLOR_LEVEL,
        selected ? 0.14 : 0.05,
        extent,
      ),
    )
  }

  if (hasDraft) {
    next.add(makePlane(props.draftElevation as number, COLOR_DRAFT, 0.16, extent))
  }

  group.value = next
}

watch(
  () => [
    props.levels.map((l) => `${l.id}:${l.elevation}`).join('|'),
    props.selectedIds.join(','),
    props.draftElevation,
    modelRoots.value.length,
  ],
  rebuild,
  { immediate: true },
)

onBeforeUnmount(dispose)
</script>

<template>
  <primitive v-if="group" :object="group" />
</template>
