<script setup lang="ts">
/**
 * Правая панель зоны (п. 3.4 ТЗ) и её массовый режим (п. 2.2 доработок).
 *
 * Одна выбранная зона — обычная карточка: название, бригады, % выполнения,
 * объём, задачи и проблемы, явная кнопка удаления.
 * Несколько выбранных зон — панель массовых действий: задача или проблема
 * заводится сразу в нескольких зонах, причём галочками отмечается, в каких
 * именно из выделенных.
 */
import { computed, ref, watch } from 'vue'

import CardAttachments from '@/components/CardAttachments.vue'
import RecipientPicker from '@/components/RecipientPicker.vue'
import type {
  Attachment,
  BrigadeWithAssignment,
  NotifyRecipient,
  SectorSummary,
  TaskStatus,
} from '@/api/types'
import { MAX_EXTRUDE_HEIGHT } from '@/lib/drafting'
import { formatCreatedAt, formatElapsed, useNow } from '@/lib/elapsed'
import { polygonArea3D, prismVolume } from '@/three/geometry'

const props = defineProps<{
  /** Зона, открытая в карточке (одиночный режим). */
  sector: SectorSummary | null
  /** Все выделенные зоны: больше одной — включается массовый режим. */
  selected: SectorSummary[]
  brigades: BrigadeWithAssignment[]
  canEdit: boolean
  editMode: boolean
  /**
   * Панель вставлена в чужую рамку (нижняя шторка на телефоне).
   *
   * Тогда закрытие рисует эта рамка, и собственный крестик панели был бы
   * вторым подряд.
   */
  embedded?: boolean
  /** Пользователи с подтверждённой почтой — кандидаты в адресаты. */
  recipients?: NotifyRecipient[]
  recipientsLoading?: boolean
  /** Идёт загрузка файлов — блокирует повторный выбор. */
  uploading?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'rename', name: string): void
  (e: 'delete'): void
  (e: 'delete-selected'): void
  (e: 'set-height', height: number): void
  (e: 'add-brigade', brigadeId: number): void
  (e: 'remove-brigade', brigadeId: number): void
  (e: 'assign-brigades', brigadeIds: number[]): void
  (e: 'open-sector', sectorId: number): void
  (e: 'toggle-edit'): void
  (
    e: 'add-task',
    payload: {
      name: string
      definition: string
      sectorIds: number[]
      files: File[]
      recipientIds: number[]
    },
  ): void
  (e: 'upload-files', payload: { kind: 'task' | 'problem'; cardId: number; files: File[] }): void
  (e: 'delete-file', attachment: Attachment): void
  (e: 'update-task', payload: { taskId: number; status?: TaskStatus; progress?: number }): void
  (e: 'delete-task', taskId: number): void
  (
    e: 'add-problem',
    payload: {
      name: string
      definition: string
      sectorIds: number[]
      files: File[]
      recipientIds: number[]
    },
  ): void
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
const brigadePickerOpen = ref(false)

/** Файлы и адресаты, выбранные в формах создания. */
const taskFiles = ref<File[]>([])
const problemFiles = ref<File[]>([])
const taskRecipients = ref<number[]>([])
const problemRecipients = ref<number[]>([])

/** Общее «сейчас» для таймеров активности всех карточек. */
const now = useNow()
/** Зоны, отмеченные галочками в массовом режиме. */
const targetIds = ref<number[]>([])
/** Бригады, отмеченные для массового назначения. */
const bulkBrigadeIds = ref<number[]>([])

const multi = computed(() => props.selected.length > 1)
const selectedIds = computed(() => props.selected.map((s) => s.id))

/**
 * По умолчанию действие идёт во все выделенные зоны.
 *
 * Пересчитываем при изменении состава выделения: иначе после снятия зоны с
 * выделения она осталась бы отмеченной и получила бы задачу.
 */
watch(
  selectedIds,
  (ids) => {
    targetIds.value = targetIds.value.filter((id) => ids.includes(id))
    const known = new Set(targetIds.value)
    for (const id of ids) if (!known.has(id)) targetIds.value.push(id)
  },
  { immediate: true, deep: true },
)

watch(
  () => props.sector?.id,
  () => {
    taskFormOpen.value = false
    problemFormOpen.value = false
    renaming.value = false
    brigadePickerOpen.value = false
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

/** Бригады, которых на зоне ещё нет — их можно добавить. */
const availableBrigades = computed(() => {
  const assigned = new Set((props.sector?.brigades ?? []).map((b) => b.id))
  return props.brigades.filter((b) => !assigned.has(b.id))
})

const targetsLabel = computed(() =>
  targetIds.value.length === selectedIds.value.length
    ? `во все зоны (${targetIds.value.length})`
    : `в ${targetIds.value.length} из ${selectedIds.value.length}`,
)

function isTarget(id: number): boolean {
  return targetIds.value.includes(id)
}

function toggleTarget(id: number): void {
  targetIds.value = isTarget(id)
    ? targetIds.value.filter((x) => x !== id)
    : [...targetIds.value, id]
}

function toggleAllTargets(): void {
  targetIds.value =
    targetIds.value.length === selectedIds.value.length ? [] : [...selectedIds.value]
}

function toggleBulkBrigade(id: number): void {
  bulkBrigadeIds.value = bulkBrigadeIds.value.includes(id)
    ? bulkBrigadeIds.value.filter((x) => x !== id)
    : [...bulkBrigadeIds.value, id]
}

function submitTask(): void {
  const name = taskName.value.trim()
  if (!name) return
  // В одиночном режиме цель — открытая зона, в массовом — отмеченные галочками.
  const sectorIds = multi.value
    ? [...targetIds.value]
    : props.sector
      ? [props.sector.id]
      : []
  if (sectorIds.length === 0) return
  emit('add-task', {
    name,
    definition: taskDefinition.value.trim(),
    sectorIds,
    files: [...taskFiles.value],
    recipientIds: [...taskRecipients.value],
  })
  taskName.value = ''
  taskDefinition.value = ''
  taskFiles.value = []
  taskRecipients.value = []
  taskFormOpen.value = false
}

function submitProblem(): void {
  const name = problemName.value.trim()
  if (!name) return
  const sectorIds = multi.value
    ? [...targetIds.value]
    : props.sector
      ? [props.sector.id]
      : []
  if (sectorIds.length === 0) return
  emit('add-problem', {
    name,
    definition: problemDefinition.value.trim(),
    sectorIds,
    files: [...problemFiles.value],
    recipientIds: [...problemRecipients.value],
  })
  problemName.value = ''
  problemDefinition.value = ''
  problemFiles.value = []
  problemRecipients.value = []
  problemFormOpen.value = false
}

/** Таймер активности карточки — «сколько времени прошло с создания». */
function elapsed(createdAt: string): string {
  return formatElapsed(createdAt, now.value)
}

function createdTitle(createdAt: string): string {
  return `Создано: ${formatCreatedAt(createdAt)}`
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

function area(sector: SectorSummary): string {
  return `${polygonArea3D(sector.coordinates).toFixed(1)} м²`
}

function volume(sector: SectorSummary): string {
  return `${prismVolume(sector.coordinates, sector.height).toFixed(1)} м³`
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

function onHeightChange(event: Event): void {
  emit('set-height', Number((event.target as HTMLInputElement).value))
}
</script>

<template>
  <aside v-if="sector || multi" class="sidebar">
    <!-- ============================================== массовый режим -->
    <template v-if="multi">
      <header class="sidebar__header">
        <div class="sidebar__title">
          <h2>Выбрано зон: {{ selected.length }}</h2>
          <span class="sidebar__subtitle">Массовые действия</span>
        </div>
        <button
          v-if="!embedded"
          class="sidebar__close"
          type="button"
          title="Закрыть"
          @click="emit('close')"
        >
          ×
        </button>
      </header>

      <section class="summary">
        <div class="summary__row summary__row--small">
          <span>Отметьте зоны, к которым применить действие</span>
          <button class="btn btn--tiny" type="button" @click="toggleAllTargets">
            {{ targetIds.length === selected.length ? 'Снять все' : 'Отметить все' }}
          </button>
        </div>

        <ul class="targets">
          <li v-for="item in selected" :key="item.id" class="target">
            <label class="target__label">
              <input type="checkbox" :checked="isTarget(item.id)" @change="toggleTarget(item.id)" />
              <span class="target__name">{{ item.name }}</span>
            </label>
            <span class="target__meta">{{ item.progress_percent.toFixed(0) }} %</span>
            <button
              class="btn btn--tiny"
              type="button"
              title="Открыть карточку этой зоны"
              @click="emit('open-sector', item.id)"
            >
              Карточка
            </button>
          </li>
        </ul>
      </section>

      <template v-if="canEdit">
        <!-- ------------------------------------- массовые задачи -->
        <section class="block">
          <header class="block__header">
            <h3>Задача {{ targetsLabel }}</h3>
            <button
              class="btn btn--primary btn--tiny"
              type="button"
              :disabled="!targetIds.length"
              @click="taskFormOpen = !taskFormOpen"
            >
              {{ taskFormOpen ? 'Отмена' : '+ Добавить задачу' }}
            </button>
          </header>
          <form v-if="taskFormOpen" class="block__form" @submit.prevent="submitTask">
            <input v-model="taskName" placeholder="Краткое название" required />
            <textarea v-model="taskDefinition" rows="2" placeholder="Подробное описание" />
            <button class="btn btn--primary" type="submit" :disabled="!targetIds.length">
              Создать в {{ targetIds.length }} зон.
            </button>
          </form>
        </section>

        <!-- ----------------------------------- массовые проблемы -->
        <section class="block">
          <header class="block__header">
            <h3>Проблема {{ targetsLabel }}</h3>
            <button
              class="btn btn--danger btn--tiny"
              type="button"
              :disabled="!targetIds.length"
              @click="problemFormOpen = !problemFormOpen"
            >
              {{ problemFormOpen ? 'Отмена' : '+ Добавить проблему' }}
            </button>
          </header>
          <form v-if="problemFormOpen" class="block__form" @submit.prevent="submitProblem">
            <input v-model="problemName" placeholder="Что случилось" required />
            <textarea v-model="problemDefinition" rows="2" placeholder="Подробности" />
            <button class="btn btn--danger" type="submit" :disabled="!targetIds.length">
              Создать в {{ targetIds.length }} зон.
            </button>
          </form>
        </section>

        <!-- ------------------------------------ массовые бригады -->
        <section class="block">
          <header class="block__header">
            <h3>Бригады на все выбранные</h3>
          </header>
          <p class="block__empty">
            Состав заменит бригады во всех {{ selected.length }} выделенных зонах.
          </p>
          <div class="picker">
            <label v-for="brigade in brigades" :key="brigade.id" class="picker__item">
              <input
                type="checkbox"
                :checked="bulkBrigadeIds.includes(brigade.id)"
                @change="toggleBulkBrigade(brigade.id)"
              />
              {{ brigade.name }}
            </label>
          </div>
          <button
            class="btn btn--tiny btn--primary"
            type="button"
            @click="emit('assign-brigades', bulkBrigadeIds)"
          >
            {{ bulkBrigadeIds.length ? 'Назначить выбранные' : 'Снять все бригады' }}
          </button>
        </section>

        <section class="block">
          <button class="btn btn--danger" type="button" @click="emit('delete-selected')">
            Удалить выбранные зоны ({{ selected.length }})
          </button>
        </section>
      </template>
    </template>

    <!-- ============================================ одиночный режим -->
    <template v-else-if="sector">
      <header class="sidebar__header">
        <div v-if="!renaming" class="sidebar__title">
          <h2>{{ sector.name }}</h2>
          <button
            v-if="canEdit"
            class="btn btn--tiny"
            type="button"
            @click="startRename"
          >
            Переименовать
          </button>
        </div>
        <form v-else class="sidebar__rename" @submit.prevent="submitRename">
          <input v-model="draftName" autofocus />
          <button class="btn btn--tiny btn--primary" type="submit">ОК</button>
        </form>
        <button
          v-if="!embedded"
          class="sidebar__close"
          type="button"
          title="Закрыть"
          @click="emit('close')"
        >
          ×
        </button>
      </header>

      <section class="summary">
        <div class="summary__row">
          <span>Бригады</span>
          <strong v-if="!sector.brigades.length" class="summary__muted">не назначены</strong>
        </div>

        <div v-if="sector.brigades.length" class="chips">
          <span v-for="brigade in sector.brigades" :key="brigade.id" class="chip">
            <span class="chip__name">
              {{ brigade.name }}
              <em v-if="brigade.brigadir">— {{ brigade.brigadir }}</em>
              <span class="chip__people">({{ brigade.cnt_people }} чел.)</span>
            </span>
            <button
              v-if="canEdit"
              class="chip__remove"
              type="button"
              title="Снять бригаду с зоны"
              @click="emit('remove-brigade', brigade.id)"
            >
              ×
            </button>
          </span>
        </div>

        <div v-if="canEdit" class="summary__actions">
          <button
            class="btn btn--tiny"
            type="button"
            :disabled="!availableBrigades.length"
            @click="brigadePickerOpen = !brigadePickerOpen"
          >
            {{ brigadePickerOpen ? 'Скрыть список' : '+ Добавить бригаду' }}
          </button>
        </div>

        <div v-if="brigadePickerOpen && canEdit" class="picker">
          <button
            v-for="brigade in availableBrigades"
            :key="brigade.id"
            class="btn btn--tiny"
            type="button"
            @click="emit('add-brigade', brigade.id)"
          >
            {{ brigade.name }}
          </button>
        </div>

        <div class="summary__row">
          <span>Выполнение</span>
          <strong>{{ sector.progress_percent.toFixed(1) }} %</strong>
        </div>

        <div class="progress">
          <div
            class="progress__fill"
            :style="{ width: `${Math.min(100, sector.progress_percent)}%` }"
          />
        </div>

        <div class="summary__row summary__row--small">
          <span>Задач: {{ sector.tasks_done }} / {{ sector.tasks_total }}</span>
          <span>Площадь: {{ area(sector) }}</span>
        </div>

        <div class="summary__row summary__row--small">
          <span>
            {{ sector.height > 0 ? `Объём: ${volume(sector)}` : 'Плоская зона, без объёма' }}
          </span>
          <span v-if="sector.height > 0">Высота: {{ sector.height.toFixed(1) }} м</span>
        </div>

        <!-- Высота уже созданной зоны: тот же объём, что задаётся при разметке -->
        <div v-if="canEdit" class="height">
          <span class="height__label">Высота, м</span>
          <input
            class="height__range"
            type="range"
            min="0"
            max="60"
            step="0.5"
            :value="sector.height"
            @change="onHeightChange"
          />
          <input
            class="height__number"
            type="number"
            min="0"
            :max="MAX_EXTRUDE_HEIGHT"
            step="0.5"
            :value="sector.height"
            @change="onHeightChange"
          />
        </div>

        <div v-if="canEdit" class="summary__actions">
          <button
            class="btn btn--tiny"
            :class="{ 'btn--active': editMode }"
            type="button"
            title="Показать маркеры вершин и перетаскивать границы зоны"
            @click="emit('toggle-edit')"
          >
            {{ editMode ? '✓ Правка границ' : 'Правка границ' }}
          </button>
        </div>

        <!-- Явная кнопка удаления зоны (п. 3.2 доработок) -->
        <button
          v-if="canEdit"
          class="btn btn--danger sidebar__delete"
          type="button"
          @click="emit('delete')"
        >
          🗑 Удалить зону
        </button>
      </section>

      <!-- --------------------------------------------------- задачи -->
      <section class="block">
        <header class="block__header">
          <h3>Задачи</h3>
          <button
            v-if="canEdit"
            class="btn btn--primary btn--tiny"
            type="button"
            @click="taskFormOpen = !taskFormOpen"
          >
            {{ taskFormOpen ? 'Отмена' : '+ Добавить задачу' }}
          </button>
        </header>

        <form v-if="taskFormOpen && canEdit" class="block__form" @submit.prevent="submitTask">
          <input v-model="taskName" placeholder="Краткое название" required />
          <textarea v-model="taskDefinition" rows="2" placeholder="Подробное описание" />
          <CardAttachments
            :pending="taskFiles"
            :can-edit="true"
            @add="taskFiles = [...taskFiles, ...$event]"
            @remove-pending="taskFiles = taskFiles.filter((_, i) => i !== $event)"
          />
          <RecipientPicker
            v-model="taskRecipients"
            :recipients="recipients ?? []"
            :loading="recipientsLoading"
          />
          <button class="btn btn--primary" type="submit">Сохранить</button>
        </form>

        <p v-if="!sector.tasks.length" class="block__empty">Задач ещё нет.</p>

        <article v-for="task in sector.tasks" :key="task.id" class="task">
          <div class="task__head">
            <span class="task__name">{{ task.name }}</span>
            <!-- Таймер активности: обновляется сам, без перезагрузки -->
            <span class="task__age" :title="createdTitle(task.created_at)">
              ⏱ {{ elapsed(task.created_at) }}
            </span>
            <button
              v-if="canEdit"
              class="task__remove"
              type="button"
              @click="emit('delete-task', task.id)"
            >
              ×
            </button>
          </div>
          <p v-if="task.definition" class="task__definition">{{ task.definition }}</p>

          <CardAttachments
            :attachments="task.attachments"
            :can-edit="canEdit"
            :busy="uploading"
            @add="emit('upload-files', { kind: 'task', cardId: task.id, files: $event })"
            @delete="emit('delete-file', $event)"
          />

          <div class="task__controls">
            <select :value="task.status" :disabled="!canEdit" @change="onStatusChange($event, task.id)">
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
              :disabled="!canEdit || task.status === 'todo'"
              @change="onProgressChange($event, task.id)"
            />
            <span class="task__percent">{{ task.progress }} %</span>
          </div>
        </article>
      </section>

      <!-- ------------------------------------------------- проблемы -->
      <section class="block">
        <header class="block__header">
          <h3>Проблемы</h3>
          <button
            v-if="canEdit"
            class="btn btn--danger btn--tiny"
            type="button"
            @click="problemFormOpen = !problemFormOpen"
          >
            {{ problemFormOpen ? 'Отмена' : '+ Добавить проблему' }}
          </button>
        </header>

        <form v-if="problemFormOpen && canEdit" class="block__form" @submit.prevent="submitProblem">
          <input v-model="problemName" placeholder="Что случилось" required />
          <textarea v-model="problemDefinition" rows="2" placeholder="Подробности" />
          <CardAttachments
            :pending="problemFiles"
            :can-edit="true"
            @add="problemFiles = [...problemFiles, ...$event]"
            @remove-pending="problemFiles = problemFiles.filter((_, i) => i !== $event)"
          />
          <RecipientPicker
            v-model="problemRecipients"
            :recipients="recipients ?? []"
            :loading="recipientsLoading"
          />
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
              :disabled="!canEdit"
              @change="onProblemToggle($event, problem.id)"
            />
            <span>{{ problem.name }}</span>
          </label>
          <p v-if="problem.definition" class="problem__definition">{{ problem.definition }}</p>

          <p class="problem__age" :title="createdTitle(problem.created_at)">
            ⏱ {{ problem.is_resolved ? 'была открыта' : 'открыта' }}
            {{ elapsed(problem.created_at) }}
          </p>

          <CardAttachments
            :attachments="problem.attachments"
            :can-edit="canEdit"
            :busy="uploading"
            @add="emit('upload-files', { kind: 'problem', cardId: problem.id, files: $event })"
            @delete="emit('delete-file', $event)"
          />
          <button
            v-if="canEdit"
            class="problem__remove"
            type="button"
            @click="emit('delete-problem', problem.id)"
          >
            ×
          </button>
        </article>
      </section>
    </template>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 348px;
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

.sidebar__subtitle {
  font-size: 11px;
  color: #7d8590;
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

.sidebar__delete {
  margin-top: 4px;
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

.summary__actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.chips {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.chip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 5px 7px;
  border-radius: 6px;
  background: rgba(47, 129, 247, 0.16);
  border: 1px solid rgba(47, 129, 247, 0.38);
  font-size: 12px;
}

.chip__name em {
  color: #8b949e;
  font-style: normal;
}

.chip__people {
  color: #7d8590;
}

.chip__remove {
  flex: none;
  border: none;
  background: transparent;
  color: #8b949e;
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
}

.chip__remove:hover {
  color: #ff9f9a;
}

.picker {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.picker__item {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
}

.height {
  display: flex;
  align-items: center;
  gap: 8px;
}

.height__label {
  font-size: 11px;
  color: #7d8590;
  white-space: nowrap;
}

.height__range {
  flex: 1;
  min-width: 0;
}

.height__number {
  width: 68px;
}

.targets {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 220px;
  overflow-y: auto;
}

.target {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.target__label {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  cursor: pointer;
}

.target__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.target__meta {
  color: #7d8590;
  font-variant-numeric: tabular-nums;
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
  gap: 8px;
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
  flex: 1;
  min-width: 0;
  font-weight: 600;
  font-size: 13px;
}

.task__age,
.problem__age {
  flex: none;
  font-size: 11px;
  color: #8b949e;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.problem__age {
  margin: 6px 0 0;
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

.btn--active {
  border-color: var(--accent);
  color: #cfe2ff;
  background: rgba(47, 129, 247, 0.18);
}
</style>
