<script setup lang="ts">
/**
 * Выбор адресатов письма о задаче или проблеме.
 *
 * В списке только пользователи с ПОДТВЕРЖДЁННОЙ почтой — отправлять на
 * непроверенный адрес нельзя, а показывать заведомо недоступных людей значит
 * обещать уведомление, которого не будет.
 *
 * Поиск по логину включается сам: на объекте бывает несколько десятков
 * подрядчиков, и прокручивать их список ради одного человека неудобно.
 */
import { computed, ref } from 'vue'

import type { NotifyRecipient } from '@/api/types'

const props = defineProps<{
  recipients: NotifyRecipient[]
  modelValue: number[]
  loading?: boolean
}>()

const emit = defineEmits<{ (e: 'update:modelValue', ids: number[]): void }>()

const open = ref(false)
const query = ref('')

const selected = computed(() => new Set(props.modelValue))

const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return props.recipients
  return props.recipients.filter(
    (r) =>
      r.username.toLowerCase().includes(needle) || r.email.toLowerCase().includes(needle),
  )
})

const summary = computed(() => {
  if (props.modelValue.length === 0) return 'Никого не уведомлять'
  const names = props.recipients
    .filter((r) => selected.value.has(r.id))
    .map((r) => r.username)
  if (names.length <= 2) return names.join(', ')
  return `${names.slice(0, 2).join(', ')} и ещё ${names.length - 2}`
})

function toggle(id: number): void {
  const next = selected.value.has(id)
    ? props.modelValue.filter((x) => x !== id)
    : [...props.modelValue, id]
  emit('update:modelValue', next)
}

function clear(): void {
  emit('update:modelValue', [])
}
</script>

<template>
  <div class="picker">
    <button
      class="picker__toggle"
      type="button"
      :class="{ 'is-open': open }"
      @click="open = !open"
    >
      <span class="picker__label">Уведомить по почте</span>
      <span class="picker__summary" :class="{ 'is-empty': !modelValue.length }">
        {{ summary }}
      </span>
      <span class="picker__chevron">{{ open ? '▴' : '▾' }}</span>
    </button>

    <div v-if="open" class="picker__body">
      <input
        v-model="query"
        class="picker__search"
        type="search"
        placeholder="Поиск по логину"
      />

      <p v-if="loading" class="picker__empty">Загрузка списка…</p>
      <p v-else-if="!recipients.length" class="picker__empty">
        Некому отправлять: ни у кого не подтверждена почта. Адрес подтверждается
        в личном кабинете.
      </p>
      <p v-else-if="!filtered.length" class="picker__empty">Никого не найдено.</p>

      <ul v-else class="picker__list">
        <li v-for="person in filtered" :key="person.id">
          <label class="person">
            <input
              type="checkbox"
              :checked="selected.has(person.id)"
              @change="toggle(person.id)"
            />
            <span class="person__name">{{ person.username }}</span>
            <span class="person__email">{{ person.email }}</span>
          </label>
        </li>
      </ul>

      <button
        v-if="modelValue.length"
        class="btn btn--tiny picker__clear"
        type="button"
        @click="clear"
      >
        Снять всех ({{ modelValue.length }})
      </button>
    </div>
  </div>
</template>

<style scoped>
.picker {
  border: 1px solid #21262d;
  border-radius: 8px;
  background: #10151c;
}

.picker__toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #e6edf3;
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.picker__label {
  flex: none;
  color: #8b949e;
}

.picker__summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker__summary.is-empty {
  color: #7d8590;
}

.picker__chevron {
  flex: none;
  color: #7d8590;
}

.picker__body {
  padding: 0 10px 10px;
  border-top: 1px solid #21262d;
}

.picker__search {
  width: 100%;
  margin: 8px 0;
}

.picker__empty {
  margin: 6px 0;
  font-size: 12px;
  color: #7d8590;
  line-height: 1.45;
}

.picker__list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 168px;
  overflow-y: auto;
}

.person {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 2px;
  font-size: 12px;
  cursor: pointer;
}

.person__name {
  font-weight: 600;
}

.person__email {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #7d8590;
}

.picker__clear {
  margin-top: 6px;
}
</style>
