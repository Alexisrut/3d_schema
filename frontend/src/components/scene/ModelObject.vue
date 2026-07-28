<script setup lang="ts">
/**
 * Загрузка .glb-модели объекта и режим «рентгена».
 *
 * Модель выгружается из САПР (Revit) и загружается администратором;
 * здесь она только читается по URL, который отдал бэкенд.
 */
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

import { applyXray, clearXray, findMeshByName } from '@/three/ghosting'
import { modelRoot } from '@/three/sceneBus'

const props = defineProps<{
  url: string | null
  /** Имя выделенного меша модели (этаж/элемент) либо null. */
  highlightName: string | null
  /** Приглушить всю модель — когда выбран сектор, а не элемент модели. */
  ghostAll: boolean
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
  current.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.geometry?.dispose?.()
    const material = mesh.material
    if (Array.isArray(material)) material.forEach(disposeMaterial)
    else if (material) disposeMaterial(material)
  })
  object.value = null
  modelRoot.value = null
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
      // Даём безымянным мешам стабильные имена — по ним работает выделение.
      let counter = 0
      root.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          counter += 1
          if (!child.name) child.name = `Элемент ${counter}`
        }
      })
      root.name = root.name || 'Модель'
      object.value = root
      modelRoot.value = root
      loading.value = false
      emit('loaded')
      applySelection()
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

function applySelection(): void {
  const root = object.value
  if (!root) return

  if (props.ghostAll) {
    applyXray(root, null, true)
    return
  }
  if (props.highlightName) {
    applyXray(root, findMeshByName(root, props.highlightName), false)
    return
  }
  clearXray(root)
}

watch(() => props.url, load, { immediate: true })
watch(() => [props.highlightName, props.ghostAll], applySelection)

onBeforeUnmount(disposeCurrent)
</script>

<template>
  <primitive v-if="object" :object="object" />
</template>
