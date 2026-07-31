<script setup lang="ts">
/**
 * Один .glb-слой сцены и его режим отображения.
 *
 * Слоёв на объекте несколько (архитектура, конструктив, инженерия), поэтому
 * загрузка и освобождение памяти вынесены в компонент на слой: скрытый слой
 * просто не монтируется, и его геометрия уходит из видеопамяти.
 */
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

import { applyXray, clearXray, findMeshByName } from '@/three/ghosting'
import { registerModelRoot, unregisterModelRoot } from '@/three/sceneBus'

const props = defineProps<{
  /** URL слоя с токеном (см. api/client.modelUrl). */
  url: string | null
  /** Человекочитаемое имя слоя — попадает в имена безымянных мешей. */
  label: string
  /** Имя выделенного меша модели (этаж/элемент) либо null. */
  highlightName: string | null
  /** Приглушить весь слой: выбран сектор либо слой помечен полупрозрачным. */
  ghost: boolean
}>()

const emit = defineEmits<{
  (e: 'loaded'): void
  (e: 'error', message: string): void
  (e: 'progress', percent: number): void
}>()

const object = shallowRef<THREE.Object3D | null>(null)
const loading = ref(false)

const loader = new GLTFLoader()

const TEXTURE_SLOTS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'emissiveMap',
  'aoMap',
  'alphaMap',
  'bumpMap',
  'displacementMap',
  'lightMap',
  'specularMap',
  'envMap',
] as const

/** Material.dispose() не освобождает текстуры — у моделей из Revit это
 *  основной объём видеопамяти, поэтому чистим их явно. */
function disposeMaterial(material: THREE.Material): void {
  const record = material as unknown as Record<string, unknown>
  for (const slot of TEXTURE_SLOTS) {
    const texture = record[slot] as THREE.Texture | null | undefined
    texture?.dispose?.()
  }
  material.dispose()
}

function disposeCurrent(): void {
  const current = object.value
  if (!current) return
  clearXray(current)
  unregisterModelRoot(current)
  current.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.geometry?.dispose?.()
    const material = mesh.material
    if (Array.isArray(material)) material.forEach(disposeMaterial)
    else if (material) disposeMaterial(material)
  })
  object.value = null
}

function load(url: string | null): void {
  disposeCurrent()
  if (!url) return

  loading.value = true
  loader.load(
    url,
    (gltf) => {
      const root = gltf.scene ?? gltf.scenes?.[0]
      if (!root) {
        loading.value = false
        emit('error', 'В файле нет сцены')
        return
      }
      // Загрузка асинхронна: пока файл шёл, слой могли скрыть или заменить.
      // Без этой проверки в сцене осел бы объект, которого никто не ждёт.
      if (props.url !== url) {
        root.traverse((child) => {
          const mesh = child as THREE.Mesh
          if (mesh.isMesh) mesh.geometry?.dispose?.()
        })
        loading.value = false
        return
      }
      // Даём безымянным мешам стабильные имена — по ним работает выделение.
      // Имя слоя в префиксе: у двух моделей элементы иначе назывались бы
      // одинаково, и выделение хватало бы чужой.
      let counter = 0
      root.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          counter += 1
          if (!child.name) child.name = `${props.label}: элемент ${counter}`
        }
      })
      root.name = root.name || props.label
      object.value = root
      registerModelRoot(root)
      loading.value = false
      emit('loaded')
      applyAppearance()
    },
    (event) => {
      if (event.lengthComputable && event.total > 0) {
        emit('progress', Math.round((event.loaded / event.total) * 100))
      }
    },
    (error) => {
      loading.value = false
      emit('error', error instanceof Error ? error.message : 'Не удалось загрузить модель')
    },
  )
}

function applyAppearance(): void {
  const root = object.value
  if (!root) return

  if (props.ghost) {
    applyXray(root, null, true)
    return
  }
  if (props.highlightName) {
    const mesh = findMeshByName(root, props.highlightName)
    // Выделенный элемент лежит в другом слое — этот показываем как есть,
    // иначе клик по элементу гасил бы все прочие модели целиком.
    if (mesh) applyXray(root, mesh, false)
    else clearXray(root)
    return
  }
  clearXray(root)
}

watch(() => props.url, load, { immediate: true })
watch(() => [props.highlightName, props.ghost], applyAppearance)

onBeforeUnmount(disposeCurrent)
</script>

<template>
  <primitive v-if="object" :object="object" />
</template>
