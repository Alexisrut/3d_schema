<script setup lang="ts">
/**
 * Панель «Слои» (п. 1.3 доработок) — как в CAD-программах.
 *
 * Слои можно выбирать по одному, по Ctrl/Cmd и диапазоном по Shift, а затем
 * переключать их видимость: обычный вид → полупрозрачный → скрытый.
 * Видимость — состояние клиента: два прораба смотрят на объект по-разному и
 * не должны переключать слои друг другу.
 */
import { computed } from 'vue'

import type { ProjectModel } from '@/api/types'
import { modeFromEvent, nextVisibility, type SelectMode, type Visibility } from '@/lib/selection'

const props = defineProps<{
  models: ProjectModel[]
  selectedIds: number[]
  visibility: Record<number, Visibility>
  /** Загрузка и удаление слоёв — только администратору. */
  canManage: boolean
  uploading: boolean
}>()

const emit = defineEmits<{
  (e: 'select', payload: { id: number; mode: SelectMode }): void
  (e: 'set-visibility', payload: { id: number; value: Visibility }): void
  (e: 'cycle-selected'): void
  (e: 'show-all'): void
  (e: 'upload', files: FileList): void
  (e: 'rename', payload: { id: number; name: string }): void
  (e: 'delete', model: ProjectModel): void
  (e: 'delete-selected'): void
  (e: 'close'): void
}>()

const VISIBILITY_ICON: Record<Visibility, string> = {
  normal: '👁',
  ghost: '◐',
  hidden: '🚫',
}

const VISIBILITY_TITLE: Record<Visibility, string> = {
  normal: 'Видим полностью — нажмите, чтобы сделать полупрозрачным',
  ghost: 'Полупрозрачный — нажмите, чтобы скрыть',
  hidden: 'Скрыт — нажмите, чтобы показать',
}

const hiddenCount = computed(
  () => props.models.filter((m) => stateOf(m.id) !== 'normal').length,
)

function stateOf(id: number): Visibility {
  return props.visibility[id] ?? 'normal'
}

function onRowClick(event: MouseEvent, model: ProjectModel): void {
  emit('select', { id: model.id, mode: modeFromEvent(event) })
}

function onEyeClick(model: ProjectModel): void {
  emit('set-visibility', { id: model.id, value: nextVisibility(stateOf(model.id)) })
}

function onUpload(event: Event): void {
  const input = event.target as HTMLInputElement
  if (input.files && input.files.length > 0) emit('upload', input.files)
  // Сбрасываем значение: иначе повторный выбор того же файла не вызовет change.
  input.value = ''
}

function onRename(model: ProjectModel): void {
  const name = window.prompt('Название слоя', model.name)
  if (name === null) return
  const trimmed = name.trim()
  if (trimmed && trimmed !== model.name) emit('rename', { id: model.id, name: trimmed })
}
</script>

<template>
  <aside class="layers">
    <header class="layers__header">
      <h2>Слои</h2>
      <button class="btn btn--ghost btn--tiny" type="button" title="Свернуть панель" @click="emit('close')">
        ×
      </button>
    </header>

    <p class="layers__hint">
      Ctrl/Cmd — добавить слой к выбору, Shift — диапазон.
    </p>

    <div class="layers__toolbar">
      <!-- Без выделения действует на все слои — кнопка не бывает «мёртвой». -->
      <button
        class="btn btn--tiny"
        type="button"
        :title="
          selectedIds.length
            ? `Обычный вид → полупрозрачный → скрытый: выбранных слоёв ${selectedIds.length}`
            : 'Обычный вид → полупрозрачный → скрытый: все слои'
        "
        @click="emit('cycle-selected')"
      >
        Прозрачность
      </button>
      <button
        class="btn btn--tiny"
        type="button"
        :disabled="hiddenCount === 0"
        @click="emit('show-all')"
      >
        Показать все
      </button>
    </div>

    <p v-if="!models.length" class="layers__empty">
      Модели ещё не загружены.
    </p>

    <ul class="layers__list">
      <li
        v-for="model in models"
        :key="model.id"
        class="layer"
        :class="{
          'is-selected': selectedIds.includes(model.id),
          'is-ghost': stateOf(model.id) === 'ghost',
          'is-hidden': stateOf(model.id) === 'hidden',
        }"
        @click="onRowClick($event, model)"
      >
        <button
          class="layer__eye"
          type="button"
          :title="VISIBILITY_TITLE[stateOf(model.id)]"
          @click.stop="onEyeClick(model)"
        >
          {{ VISIBILITY_ICON[stateOf(model.id)] }}
        </button>

        <span class="layer__name" :title="model.name">{{ model.name }}</span>

        <span v-if="canManage" class="layer__actions">
          <button
            class="layer__action"
            type="button"
            title="Переименовать слой"
            @click.stop="onRename(model)"
          >
            ✎
          </button>
          <button
            class="layer__action layer__action--danger"
            type="button"
            title="Удалить слой"
            @click.stop="emit('delete', model)"
          >
            ×
          </button>
        </span>
      </li>
    </ul>

    <div v-if="canManage" class="layers__manage">
      <label class="layers__upload">
        <!-- multiple: несколько разделов проекта загружаются одним выбором -->
        <input type="file" accept=".glb,.gltf" multiple @change="onUpload" />
        <span>{{ uploading ? 'Загрузка…' : '+ Добавить .glb' }}</span>
      </label>
      <button
        class="btn btn--tiny btn--danger"
        type="button"
        :disabled="selectedIds.length === 0"
        @click="emit('delete-selected')"
      >
        Удалить выбранные
      </button>
    </div>
  </aside>
</template>

<style scoped>
.layers {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 232px;
  padding: 12px;
  overflow-y: auto;
  background: #0f141b;
  border-right: 1px solid #21262d;
}

.layers__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.layers__header h2 {
  margin: 0;
  font-size: 15px;
}

.layers__hint {
  margin: 0;
  font-size: 11px;
  color: #7d8590;
  line-height: 1.4;
}

.layers__toolbar {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.layers__empty {
  margin: 0;
  font-size: 12px;
  color: #7d8590;
}

.layers__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.layer {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 7px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: #161b22;
  cursor: pointer;
  font-size: 12px;
}

.layer:hover {
  border-color: #30363d;
}

.layer.is-selected {
  border-color: var(--accent);
  background: rgba(47, 129, 247, 0.14);
}

.layer.is-ghost .layer__name {
  color: #8b949e;
}

.layer.is-hidden .layer__name {
  color: #6e7681;
  text-decoration: line-through;
}

.layer__eye {
  flex: none;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #c9d1d9;
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
}

.layer__eye:hover {
  background: rgba(255, 255, 255, 0.08);
}

.layer__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.layer__actions {
  display: flex;
  gap: 2px;
}

.layer__action {
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #7d8590;
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
}

.layer__action:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #e6edf3;
}

.layer__action--danger:hover {
  background: rgba(229, 83, 75, 0.2);
  color: #ff9f9a;
}

.layers__manage {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid #21262d;
}

.layers__upload {
  display: inline-block;
  cursor: pointer;
  font-size: 12px;
  color: #58a6ff;
}

.layers__upload input {
  display: none;
}
</style>
