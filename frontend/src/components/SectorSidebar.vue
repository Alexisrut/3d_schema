<script setup lang="ts">
/**
 * Контекстная панель сектора (п. 3.4 ТЗ): название, бригада, % выполнения,
 * кнопки «Добавить задачу» и «Добавить проблему», списки задач и проблем.
 */
import { ref, watch } from 'vue'

import type { SectorSummary, TaskStatus } from '@/api/types'
import { polygonArea3D } from '@/three/geometry'

const props = defineProps<{
  sector: SectorSummary | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'rename', name: string): void
  (e: 'delete'): void
  (e: 'unassign'): void
  (e: 'add-task', payload: { name: string; definition: string }): void
  (e: 'update-task', payload: { taskId: number; status?: TaskStatus; progress?: number }): void
  (e: 'delete-task', taskId: number): void
  (e: 'add-problem', payload: { name: string; definition: string }): void
  (e: 'toggle-problem', payload: { problemId: number; isResolved: boolean }): void
  (e: 'delete-problem', problemId: number): void
}>()

const taskFormOpen = ref(false)
const problemFormOpen = ref(false)
const taskName = ref('')
const taskDefinition = ref('')
const problemName = ref('')
const problemDefinition = ref('')
const renaming = ref(false)
const draftName = ref('')

watch(
  () => props.sector?.id,
  () => {
    taskFormOpen.value = false
    problemFormOpen.value = false
    renaming.value = false
    taskName.value = ''
    taskDefinition.value = ''
    problemName.value = ''
    problemDefinition.value = ''
  },
)

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'В плане',
  in_progress: 'В работе',
  done: 'Готово',
}

function submitTask(): void {
  const name = taskName.value.trim()
  if (!name) return
  emit('add-task', { name, definition: taskDefinition.value.trim() })
  taskName.value = ''
  taskDefinition.value = ''
  taskFormOpen.value = false
}

function submitProblem(): void {
  const name = problemName.value.trim()
  if (!name) return
  emit('add-problem', { name, definition: problemDefinition.value.trim() })
  problemName.value = ''
  problemDefinition.value = ''
  problemFormOpen.value = false
}

function startRename(): void {
  draftName.value = props.sector?.name ?? ''
  renaming.value = true
}

function submitRename(): void {
  const name = draftName.value.trim()
  if (name) emit('rename', name)
  renaming.value = false
}

function area(): string {
  if (!props.sector) return '—'
  return `${polygonArea3D(props.sector.coordinates).toFixed(1)} м²`
}

// Обработчики держим в скрипте, а не в шаблоне: так в разметке нет
// TypeScript-приведений типов и она остаётся обычными JS-выражениями.
function onStatusChange(event: Event, taskId: number): void {
  const value = (event.target as HTMLSelectElement).value as TaskStatus
  emit('update-task', { taskId, status: value })
}

function onProgressChange(event: Event, taskId: number): void {
  const value = Number((event.target as HTMLInputElement).value)
  emit('update-task', { taskId, progress: value })
}

function onProblemToggle(event: Event, problemId: number): void {
  const checked = (event.target as HTMLInputElement).checked
  emit('toggle-problem', { problemId, isResolved: checked })
}
</script>

<template>
  <aside v-if="sector" class="sidebar">
    <header class="sidebar__header">
      <div v-if="!renaming" class="sidebar__title">
        <h2>{{ sector.name }}</h2>
        <button class="btn btn--tiny" type="button" @click="startRename">Переименовать</button>
      </div>
      <form v-else class="sidebar__rename" @submit.prevent="submitRename">
        <input v-model="draftName" autofocus />
        <button class="btn btn--tiny btn--primary" type="submit">ОК</button>
      </form>
      <button class="sidebar__close" type="button" title="Закрыть" @click="emit('close')">×</button>
    </header>

    <section class="summary">
      <div class="summary__row">
        <span>Бригада</span>
        <strong v-if="sector.brigade">
          {{ sector.brigade.name }}
          <em v-if="sector.brigade.brigadir">— {{ sector.brigade.brigadir }}</em>
          <span class="summary__people">({{ sector.brigade.cnt_people }} чел.)</span>
        </strong>
        <strong v-else class="summary__muted">не назначена</strong>
      </div>

      <div class="summary__row">
        <span>Выполнение</span>
        <strong>{{ sector.progress_percent.toFixed(1) }} %</strong>
      </div>

      <div class="progress">
        <div class="progress__fill" :style="{ width: `${Math.min(100, sector.progress_percent)}%` }" />
      </div>

      <div class="summary__row summary__row--small">
        <span>Задач: {{ sector.tasks_done }} / {{ sector.tasks_total }}</span>
        <span>Площадь: {{ area() }}</span>
      </div>

      <div class="summary__actions">
        <button
          v-if="sector.brigade"
          class="btn btn--tiny"
          type="button"
          @click="emit('unassign')"
        >
          Снять бригаду
        </button>
        <button class="btn btn--tiny btn--danger" type="button" @click="emit('delete')">
          Удалить зону
        </button>
      </div>
    </section>

    <!-- ------------------------------------------------------------ задачи -->
    <section class="block">
      <header class="block__header">
        <h3>Задачи</h3>
        <button class="btn btn--primary btn--tiny" type="button" @click="taskFormOpen = !taskFormOpen">
          {{ taskFormOpen ? 'Отмена' : '+ Добавить задачу' }}
        </button>
      </header>

      <form v-if="taskFormOpen" class="block__form" @submit.prevent="submitTask">
        <input v-model="taskName" placeholder="Краткое название" required />
        <textarea v-model="taskDefinition" rows="2" placeholder="Подробное описание" />
        <button class="btn btn--primary" type="submit">Сохранить</button>
      </form>

      <p v-if="!sector.tasks.length" class="block__empty">Задач ещё нет.</p>

      <article v-for="task in sector.tasks" :key="task.id" class="task">
        <div class="task__head">
          <span class="task__name">{{ task.name }}</span>
          <button class="task__remove" type="button" @click="emit('delete-task', task.id)">×</button>
        </div>
        <p v-if="task.definition" class="task__definition">{{ task.definition }}</p>

        <div class="task__controls">
          <select :value="task.status" @change="onStatusChange($event, task.id)">
            <option v-for="(label, value) in STATUS_LABEL" :key="value" :value="value">
              {{ label }}
            </option>
          </select>

          <input
            class="task__range"
            type="range"
            min="0"
            max="100"
            step="5"
            :value="task.progress"
            :disabled="task.status === 'todo'"
            @change="onProgressChange($event, task.id)"
          />
          <span class="task__percent">{{ task.progress }} %</span>
        </div>
      </article>
    </section>

    <!-- ---------------------------------------------------------- проблемы -->
    <section class="block">
      <header class="block__header">
        <h3>Проблемы</h3>
        <button
          class="btn btn--danger btn--tiny"
          type="button"
          @click="problemFormOpen = !problemFormOpen"
        >
          {{ problemFormOpen ? 'Отмена' : '+ Добавить проблему' }}
        </button>
      </header>

      <form v-if="problemFormOpen" class="block__form" @submit.prevent="submitProblem">
        <input v-model="problemName" placeholder="Что случилось" required />
        <textarea v-model="problemDefinition" rows="2" placeholder="Подробности" />
        <button class="btn btn--danger" type="submit">Сохранить</button>
      </form>

      <p v-if="!sector.problems.length" class="block__empty">Проблем не зафиксировано.</p>

      <article
        v-for="problem in sector.problems"
        :key="problem.id"
        class="problem"
        :class="{ 'problem--resolved': problem.is_resolved }"
      >
        <label class="problem__head">
          <input
            type="checkbox"
            :checked="problem.is_resolved"
            @change="onProblemToggle($event, problem.id)"
          />
          <span>{{ problem.name }}</span>
        </label>
        <p v-if="problem.definition" class="problem__definition">{{ problem.definition }}</p>
        <button class="problem__remove" type="button" @click="emit('delete-problem', problem.id)">
          ×
        </button>
      </article>
    </section>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 340px;
  padding: 14px;
  overflow-y: auto;
  background: #0f141b;
  border-left: 1px solid #21262d;
}

.sidebar__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.sidebar__title {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sidebar__title h2 {
  margin: 0;
  font-size: 16px;
}

.sidebar__rename {
  display: flex;
  gap: 6px;
  flex: 1;
}

.sidebar__close {
  border: none;
  background: transparent;
  color: #7d8590;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
}

.summary {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: 8px;
  background: #161b22;
  border: 1px solid #21262d;
}

.summary__row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
}

.summary__row span {
  color: #8b949e;
}

.summary__row--small {
  font-size: 11px;
}

.summary__row--small span {
  color: #7d8590;
}

.summary__muted {
  color: #7d8590;
  font-weight: 400;
}

.summary__people {
  color: #7d8590;
  font-weight: 400;
}

.summary__actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.progress {
  height: 8px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.1);
  overflow: hidden;
}

.progress__fill {
  height: 100%;
  background: linear-gradient(90deg, #2f81f7, #3fb950);
  transition: width 0.25s ease;
}

.block__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.block__header h3 {
  margin: 0;
  font-size: 13px;
}

.block__form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}

.block__empty {
  margin: 0 0 8px;
  font-size: 12px;
  color: #7d8590;
}

.task,
.problem {
  position: relative;
  padding: 10px;
  margin-bottom: 8px;
  border-radius: 8px;
  background: #161b22;
  border: 1px solid #21262d;
}

.task__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.task__name {
  font-weight: 600;
  font-size: 13px;
}

.task__definition,
.problem__definition {
  margin: 6px 0 0;
  font-size: 12px;
  color: #8b949e;
  line-height: 1.4;
}

.task__controls {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.task__range {
  flex: 1;
}

.task__percent {
  font-size: 11px;
  color: #8b949e;
  min-width: 38px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.task__remove,
.problem__remove {
  border: none;
  background: transparent;
  color: #7d8590;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
}

.problem {
  border-color: rgba(229, 83, 75, 0.4);
}

.problem--resolved {
  border-color: #21262d;
  opacity: 0.65;
}

.problem__head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.problem__remove {
  position: absolute;
  top: 8px;
  right: 8px;
}
</style>
