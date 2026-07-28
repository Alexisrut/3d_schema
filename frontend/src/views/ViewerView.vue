<script setup lang="ts">
/** Основной экран: 3D-модель объекта, зоны, бригады, задачи и проблемы. */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { api, modelUrl } from '@/api/client'
import type { TaskStatus } from '@/api/types'
import BillboardLayer from '@/components/BillboardLayer.vue'
import BrigadePanel from '@/components/BrigadePanel.vue'
import SectorSidebar from '@/components/SectorSidebar.vue'
import ViewerToolbar from '@/components/ViewerToolbar.vue'
import SceneCanvas from '@/components/scene/SceneCanvas.vue'
import { useAuthStore } from '@/stores/auth'
import { useProjectStore } from '@/stores/project'
import { resetSceneBus } from '@/three/sceneBus'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const store = useProjectStore()

const scene = ref<InstanceType<typeof SceneCanvas> | null>(null)
const modelError = ref<string | null>(null)
const namePromptOpen = ref(false)
const newSectorName = ref('')
const toast = ref<string | null>(null)

const projectId = computed(() => Number(route.params.projectId))
const canCommit = computed(() => store.draftPoints.length >= 3)
const sceneModelUrl = computed(() => modelUrl(store.project?.model_url ?? null))

function notify(message: string): void {
  toast.value = message
  window.setTimeout(() => {
    if (toast.value === message) toast.value = null
  }, 3500)
}

// ------------------------------------------------------------------ загрузка
onMounted(async () => {
  // Слушатель вешаем до await: иначе при быстром уходе со страницы
  // onBeforeUnmount снял бы ещё не добавленный обработчик, и он остался бы
  // висеть глобально.
  window.addEventListener('keydown', onKeydown)
  await store.open(projectId.value)
  if (store.error) notify(store.error)
})

watch(projectId, async (id) => {
  if (Number.isFinite(id)) await store.open(id)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  store.close()
  resetSceneBus()
})

function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    void store.undo()
    return
  }
  if (event.key === 'Escape') {
    if (store.drawing) store.resetDrawing()
    else store.clearSelection()
  }
}

// ------------------------------------------------------------------ разметка
function toggleDrawing(): void {
  if (store.drawing) store.resetDrawing()
  else store.startDrawing()
}

function openNamePrompt(): void {
  if (!canCommit.value) return
  newSectorName.value = `Зона ${store.sectors.length + 1}`
  namePromptOpen.value = true
}

async function commitSector(): Promise<void> {
  const name = newSectorName.value.trim()
  if (!name) return
  try {
    const created = await store.commitSector(name)
    if (!created) {
      notify('Нужно поставить минимум 3 опорные точки')
      return
    }
    namePromptOpen.value = false
    notify('Зона создана. «Шаг назад» отменит её целиком.')
  } catch (e) {
    notify(e instanceof Error ? e.message : 'Не удалось создать зону')
  }
}

// ---------------------------------------------------------------- сектор API
async function withSector<T>(action: (sectorId: number) => Promise<T>): Promise<void> {
  const sectorId = store.selectedSectorId
  if (sectorId === null) return
  try {
    const summary = await action(sectorId)
    store.upsertSector(summary as never)
  } catch (e) {
    notify(e instanceof Error ? e.message : 'Операция не выполнена')
  }
}

const addTask = (payload: { name: string; definition: string }) =>
  withSector((sectorId) =>
    api.addTask(projectId.value, sectorId, { ...payload, status: 'todo', progress: 0 }),
  )

const updateTask = (payload: { taskId: number; status?: TaskStatus; progress?: number }) =>
  withSector((sectorId) => {
    const { taskId, ...rest } = payload
    return api.updateTask(projectId.value, sectorId, taskId, rest)
  })

const deleteTask = (taskId: number) =>
  withSector((sectorId) => api.deleteTask(projectId.value, sectorId, taskId))

const addProblem = (payload: { name: string; definition: string }) =>
  withSector((sectorId) =>
    api.addProblem(projectId.value, sectorId, { ...payload, is_resolved: false }),
  )

const toggleProblem = (payload: { problemId: number; isResolved: boolean }) =>
  withSector((sectorId) =>
    api.updateProblem(projectId.value, sectorId, payload.problemId, {
      is_resolved: payload.isResolved,
    }),
  )

const deleteProblem = (problemId: number) =>
  withSector((sectorId) => api.deleteProblem(projectId.value, sectorId, problemId))

const renameSector = (name: string) =>
  withSector((sectorId) => api.updateSector(projectId.value, sectorId, { name }))

function unassignSelectedBrigade(): void {
  if (store.selectedSectorId === null) return
  void store.assignBrigade(store.selectedSectorId, null)
}

async function deleteSector(): Promise<void> {
  const sectorId = store.selectedSectorId
  if (sectorId === null) return
  if (!window.confirm('Удалить зону вместе с её задачами и проблемами?')) return
  try {
    await store.removeSector(sectorId)
  } catch (e) {
    notify(e instanceof Error ? e.message : 'Не удалось удалить зону')
  }
}

// ------------------------------------------------------------------ бригады
async function onDropBrigade(payload: { sectorId: number; brigadeId: number }): Promise<void> {
  await store.assignBrigade(payload.sectorId, payload.brigadeId)
  if (store.error) notify(store.error)
}

async function createBrigade(payload: {
  name: string
  brigadir: string
  cnt_people: number
}): Promise<void> {
  try {
    await api.createBrigade(projectId.value, payload)
    await store.refreshBrigades()
  } catch (e) {
    notify(e instanceof Error ? e.message : 'Не удалось создать бригаду')
  }
}

async function deleteBrigade(brigadeId: number): Promise<void> {
  try {
    await api.deleteBrigade(projectId.value, brigadeId)
    await store.refreshAll()
  } catch (e) {
    notify(e instanceof Error ? e.message : 'Не удалось удалить бригаду')
  }
}

function logout(): void {
  auth.logout()
  void router.push({ name: 'login' })
}
</script>

<template>
  <div class="viewer">
    <ViewerToolbar
      :project-name="store.project?.name ?? 'Загрузка…'"
      :connected="store.connected"
      :drawing="store.drawing"
      :point-count="store.draftPoints.length"
      :can-undo="store.canUndo"
      :can-commit="canCommit"
      :is-admin="auth.isAdmin"
      @toggle-drawing="toggleDrawing"
      @commit="openNamePrompt"
      @undo="store.undo()"
      @reset-view="scene?.resetView()"
      @back="router.push({ name: 'projects' })"
      @admin="router.push({ name: 'admin' })"
      @logout="logout"
    />

    <div class="viewer__body">
      <BrigadePanel
        :brigades="store.brigades"
        :sectors="store.sectors"
        @create="createBrigade"
        @delete="deleteBrigade"
        @unassign="store.assignBrigade($event, null)"
      />

      <main class="viewer__stage" :class="{ 'is-drawing': store.drawing }">
        <SceneCanvas
          ref="scene"
          :model-url="sceneModelUrl"
          :sectors="store.sectors"
          :selected-sector-id="store.selectedSectorId"
          :selected-mesh-name="store.selectedMeshName"
          :ghost-all="store.selectedSectorId !== null"
          :drawing="store.drawing"
          :draft-points="store.draftPoints"
          @point="store.addPoint($event)"
          @select-sector="store.selectSector($event)"
          @select-mesh="store.selectMesh($event)"
          @clear-selection="store.clearSelection()"
          @drop-brigade="onDropBrigade"
          @model-error="modelError = $event"
          @model-loaded="modelError = null"
        />

        <BillboardLayer
          :sectors="store.sectors"
          :selected-id="store.selectedSectorId"
          @select="store.selectSector($event)"
          @drop-brigade="onDropBrigade"
        />

        <div v-if="!store.project?.model_url" class="overlay overlay--center">
          <p>3D-модель ещё не загружена.</p>
          <button
            v-if="auth.isAdmin"
            class="btn btn--primary"
            type="button"
            @click="router.push({ name: 'admin' })"
          >
            Загрузить .glb
          </button>
        </div>

        <div v-if="modelError" class="overlay overlay--error">
          Не удалось загрузить модель: {{ modelError }}
        </div>

        <div v-if="store.selectedMeshName" class="overlay overlay--chip">
          Выделен элемент: <strong>{{ store.selectedMeshName }}</strong>
          <button class="btn btn--tiny" type="button" @click="store.clearSelection()">Сбросить</button>
        </div>

        <div v-if="store.drawing" class="overlay overlay--hint">
          Кликайте по модели, чтобы поставить опорные точки. Ctrl+Z — убрать последнюю,
          Esc — выйти из режима.
        </div>

        <transition name="fade">
          <div v-if="toast" class="overlay overlay--toast">{{ toast }}</div>
        </transition>
      </main>

      <SectorSidebar
        :sector="store.selectedSector"
        @close="store.clearSelection()"
        @rename="renameSector"
        @delete="deleteSector"
        @unassign="unassignSelectedBrigade"
        @add-task="addTask"
        @update-task="updateTask"
        @delete-task="deleteTask"
        @add-problem="addProblem"
        @toggle-problem="toggleProblem"
        @delete-problem="deleteProblem"
      />
    </div>

    <!-- Имя новой зоны -->
    <div v-if="namePromptOpen" class="modal" @click.self="namePromptOpen = false">
      <form class="modal__card" @submit.prevent="commitSector">
        <h3>Название зоны</h3>
        <input v-model="newSectorName" autofocus required />
        <div class="modal__actions">
          <button class="btn" type="button" @click="namePromptOpen = false">Отмена</button>
          <button class="btn btn--primary" type="submit">Создать</button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.viewer {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.viewer__body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.viewer__stage {
  position: relative;
  flex: 1;
  min-width: 0;
  background: #0d1117;
}

.viewer__stage.is-drawing {
  cursor: crosshair;
}

.overlay {
  position: absolute;
  padding: 10px 14px;
  border-radius: 8px;
  background: rgba(17, 22, 30, 0.92);
  border: 1px solid #21262d;
  font-size: 13px;
  color: #e6edf3;
}

.overlay--center {
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
}

.overlay--error {
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  border-color: rgba(229, 83, 75, 0.6);
  color: #ff9f9a;
}

.overlay--chip {
  bottom: 14px;
  left: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.overlay--hint {
  top: 14px;
  left: 14px;
  max-width: 320px;
  border-color: rgba(255, 200, 87, 0.5);
  color: #ffd88a;
  line-height: 1.45;
}

.overlay--toast {
  bottom: 14px;
  left: 50%;
  transform: translateX(-50%);
}

.modal {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.55);
  z-index: 50;
}

.modal__card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 320px;
  padding: 18px;
  border-radius: 10px;
  background: #0f141b;
  border: 1px solid #21262d;
}

.modal__card h3 {
  margin: 0;
  font-size: 15px;
}

.modal__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
