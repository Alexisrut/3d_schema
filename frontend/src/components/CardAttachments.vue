<script setup lang="ts">
/**
 * Вложения карточки задачи или проблемы.
 *
 * Компонент работает в двух режимах:
 *  • у существующей карточки — показывает файлы, даёт скачать и удалить,
 *    приложить новые;
 *  • в форме создания (`pending`) — просто копит выбранные файлы, потому что
 *    карточки, к которой их привязать, ещё нет. Загрузка идёт сразу после
 *    создания — так на сервере не остаётся «ничьих» файлов.
 */
import { computed } from 'vue'

import { attachmentUrl } from '@/api/client'
import type { Attachment } from '@/api/types'

const props = withDefaults(
  defineProps<{
    /** Уже загруженные файлы (у существующей карточки). */
    attachments?: Attachment[]
    /** Выбранные, но ещё не отправленные файлы (форма создания). */
    pending?: File[]
    canEdit: boolean
    /** Идёт отправка — блокируем повторный выбор. */
    busy?: boolean
  }>(),
  { attachments: () => [], pending: () => [] },
)

const emit = defineEmits<{
  (e: 'add', files: File[]): void
  (e: 'remove-pending', index: number): void
  (e: 'delete', attachment: Attachment): void
}>()

const hasAny = computed(() => props.attachments.length > 0 || props.pending.length > 0)

function onPick(event: Event): void {
  const input = event.target as HTMLInputElement
  if (input.files && input.files.length > 0) emit('add', Array.from(input.files))
  // Сбрасываем значение: иначе повторный выбор того же файла не даст change.
  input.value = ''
}

/** Человекочитаемый размер: килобайты и мегабайты, без длинных чисел. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
}
</script>

<template>
  <div class="files">
    <div class="files__head">
      <span class="files__title">Файлы</span>
      <label v-if="canEdit" class="files__add" :class="{ 'is-busy': busy }">
        <input type="file" multiple :disabled="busy" @change="onPick" />
        <span>{{ busy ? 'Загрузка…' : '+ Приложить' }}</span>
      </label>
    </div>

    <p v-if="!hasAny" class="files__empty">Файлов нет.</p>

    <ul v-else class="files__list">
      <!-- Загруженные: открываются по ссылке с токеном -->
      <li v-for="file in attachments" :key="`saved-${file.id}`" class="file">
        <a
          class="file__name"
          :href="attachmentUrl(file.url) ?? file.url"
          target="_blank"
          rel="noopener"
          :title="file.filename"
        >
          {{ file.filename }}
        </a>
        <span class="file__size">{{ formatSize(file.size_bytes) }}</span>
        <button
          v-if="canEdit"
          class="file__remove"
          type="button"
          title="Удалить файл"
          @click="emit('delete', file)"
        >
          ×
        </button>
      </li>

      <!-- Выбранные в форме: ещё не на сервере -->
      <li v-for="(file, index) in pending" :key="`new-${index}`" class="file file--pending">
        <span class="file__name" :title="file.name">{{ file.name }}</span>
        <span class="file__size">{{ formatSize(file.size) }}</span>
        <button
          class="file__remove"
          type="button"
          title="Убрать из списка"
          @click="emit('remove-pending', index)"
        >
          ×
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.files {
  margin-top: 8px;
}

.files__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 4px;
}

.files__title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #7d8590;
}

.files__add {
  font-size: 12px;
  color: #58a6ff;
  cursor: pointer;
}

.files__add.is-busy {
  color: #7d8590;
  cursor: default;
}

.files__add input {
  display: none;
}

.files__empty {
  margin: 0;
  font-size: 12px;
  color: #7d8590;
}

.files__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.file {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}

.file--pending .file__name {
  color: #ffd88a;
}

.file__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #58a6ff;
  text-decoration: none;
}

.file__name:hover {
  text-decoration: underline;
}

.file__size {
  flex: none;
  color: #7d8590;
  font-variant-numeric: tabular-nums;
}

.file__remove {
  flex: none;
  border: none;
  background: transparent;
  color: #7d8590;
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
}

.file__remove:hover {
  color: #ff9f9a;
}
</style>
