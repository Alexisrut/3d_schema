<script setup lang="ts">
/**
 * Один .glb-слой сцены и его режим отображения.
 *
 * Слоёв на объекте несколько (архитектура, конструктив, инженерия), поэтому
 * загрузка и освобождение памяти вынесены в компонент на слой: скрытый слой
 * просто не монтируется, и его геометрия уходит из видеопамяти.
 *
 * Рисуется НЕ сам загруженный граф, а его «рендер-прокси» — та же геометрия,
 * слитая в несколько крупных мешей (см. three/batching). Исходные меши
 * остаются в сцене невидимыми: по ним по-прежнему работает луч выбора,
 * снятие отметки этажа и «умное выделение», но они ничего не стоят при
 * отрисовке, потому что невидимая ветка целиком пропускается рендерером.
 */
import { onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

import { buildRenderProxy, type RenderProxy } from '@/three/batching'
import { findMeshByName, forgetMeshes } from '@/three/ghosting'
import { invalidateScene, registerModelRoot, unregisterModelRoot } from '@/three/sceneBus'

const props = defineProps<{
  /** URL слоя с токеном (см. api/client.modelUrl). */
  url: string | null
  /** Человекочитаемое имя слоя — попадает в имена безымянных мешей. */
  label: string
  /** Имя выделенного меша модели (этаж/элемент) либо null. */
  highlightName: string | null
  /** Имена деталей, набранных в режиме «Выделение по деталям». */
  highlightNames?: string[]
  /** Приглушить весь слой: выбран сектор либо слой помечен полупрозрачным. */
  ghost: boolean
}>()

const emit = defineEmits<{
  (e: 'loaded'): void
  (e: 'error', message: string): void
  (e: 'progress', percent: number): void
}>()

/**
 * Контейнер слоя: в нём лежат невидимый корень .glb (цели для луча) и группа
 * слитых мешей, которая и рисуется. Один <primitive> на оба, чтобы TresJS не
 * пересоздавал их по отдельности.
 */
const object = shallowRef<THREE.Object3D | null>(null)
const loading = ref(false)

let proxy: RenderProxy | null = null
/** Корень загруженной модели внутри контейнера — цели луча и габариты. */
let modelRoot: THREE.Object3D | null = null

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
  // Прокси освобождаем первым: он делит материалы и часть геометрии с
  // исходными мешами, а те освобождаются следующим шагом.
  proxy?.dispose()
  proxy = null
  if (modelRoot) {
    forgetMeshes(modelRoot)
    unregisterModelRoot(modelRoot)
  }
  modelRoot = null
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
      freezeStaticTransforms(root)

      // Слитая копия геометрии для отрисовки. Исходный граф остаётся в сцене
      // невидимым: луч выбора работает по нему, рендерер его пропускает.
      const container = new THREE.Group()
      container.name = `${root.name} (слой)`
      proxy = buildRenderProxy(root)
      if (proxy) {
        root.visible = false
        container.add(root, proxy.group)
      } else {
        container.add(root)
      }

      modelRoot = root
      object.value = container
      registerModelRoot(root)
      loading.value = false
      emit('loaded')
      applyAppearance()
      invalidateScene()
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

/**
 * Заморозить матрицы загруженной модели.
 *
 * Модель из САПР неподвижна, но three.js по умолчанию пересчитывает матрицу
 * каждого узла в каждом кадре. На выгрузке в тысячи деталей это заметная доля
 * кадра, потраченная впустую. Считаем матрицы один раз и отключаем
 * автообновление; зоны, маркеры и плоскости этажей это не затрагивает —
 * они живут отдельными объектами и продолжают двигаться.
 */
function freezeStaticTransforms(root: THREE.Object3D): void {
  root.updateMatrixWorld(true)
  root.traverse((child) => {
    child.matrixAutoUpdate = false
    child.updateMatrix()
  })
  root.updateMatrixWorld(true)
}

function applyAppearance(): void {
  const root = modelRoot
  if (!root || !proxy) return

  // Набор деталей важнее одиночного выделения: пока идёт режим «Выделение по
  // деталям», подсвечивать надо именно его, а не деталь, выбранную до входа.
  const picked = (props.highlightNames ?? [])
    .map((name) => findMeshByName(root, name))
    .filter((mesh): mesh is THREE.Mesh => mesh !== null)
  if (picked.length > 0) {
    proxy.setGhost(true)
    proxy.setHighlight(picked)
    return
  }

  if (props.ghost) {
    proxy.setGhost(true)
    proxy.setHighlight(null)
    return
  }
  const mesh = props.highlightName ? findMeshByName(root, props.highlightName) : null
  // Выделенный элемент лежит в другом слое — этот показываем как есть,
  // иначе клик по элементу гасил бы все прочие модели целиком.
  proxy.setGhost(mesh !== null)
  proxy.setHighlight(mesh)
}

watch(() => props.url, load, { immediate: true })
watch(
  // Набор деталей сравниваем по содержимому: массив пересоздаётся на каждом
  // клике, и сравнение по ссылке срабатывало бы даже без изменений.
  () => [props.highlightName, props.ghost, (props.highlightNames ?? []).join('|')],
  () => {
    applyAppearance()
    invalidateScene()
  },
)

onBeforeUnmount(disposeCurrent)
</script>

<template>
  <primitive v-if="object" :object="object" />
</template>
