<script setup lang="ts">
/**
 * Панель «Этажи» (п. 3.1 доработок).
 *
 * Порядок работы: пользователь кликает по любой детали модели → система
 * снимает её отметку по оси Y → здесь эта отметка предлагается к
 * закреплению под своим названием.
 *
 * Дальше уровни служат сечением: показать только выше отметки, только ниже
 * или объём между двумя выбранными.
 */
import { computed, ref, watch } from 'vue'

import type { Level } from '@/api/types'

const props = defineProps<{
  levels: Level[]
  selectedIds: number[]
  /** Отметка с выбранной детали; null — деталь не выбрана. */
  draftElevation: number | null
  filter: 'above' | 'below' | 'between' | null
  canEdit: boolean
}>()

const emit = defineEmits<{
  (e: 'pin', payload: { name: string; elevation: number }): void
  (e: 'toggle', levelId: number): void
  (e: 'rename', payload: { id: number; name: string }): void
  (e: 'delete', level: Level): void
  (e: 'set-filter', mode: 'above' | 'below' | 'between' | null): void
  (e: 'clear-filter'): void
}>()

const draftName = ref('')
/** Отметку можно поправить руками: клик попадает по детали, а не по нулю плиты. */
const draftValue = ref(0)

const hasDraft = computed(() => props.draftElevation !== null)
const canPinBetween = computed(() => props.selectedIds.length >= 2)

watch(
  () => props.draftElevation,
  (value) => {
    if (value === null) return
    draftValue.value = Math.round(value * 100) / 100
    if (!draftName.value.trim()) draftName.value = suggestName(value)
  },
  { immediate: true },
)

/**
 * Имя по умолчанию — по порядку отметки, а не по её значению: «Этаж 2»
 * понятнее, чем «Уровень 3.80».
 */
function suggestName(elevation: number): string {
  const below = props.levels.filter((l) => l.elevation < elevation - 0.01).length
  return `Этаж ${below + 1}`
}

function pin(): void {
  const name = draftName.value.trim()
  if (!name) return
  emit('pin', { name, elevation: Number(draftValue.value) })
  draftName.value = ''
}

function onRename(level: Level): void {
  const name = window.prompt('Название этажа', level.name)
  if (name === null) return
  const trimmed = name.trim()
  if (trimmed && trimmed !== level.name) emit('rename', { id: level.id, name: trimmed })
}

function format(elevation: number): string {
  const sign = elevation >= 0 ? '+' : '−'
  return `${sign}${Math.abs(elevation).toFixed(2)} м`
}
</script>

<template>
  <section class="levels">
    <header class="levels__header">
      <h2>Этажи</h2>
      <span class="levels__count">{{ levels.length }}</span>
    </header>

    <p class="levels__hint">
      Коснитесь любой детали модели — система снимет её отметку и предложит
      закрепить уровень.
    </p>

    <!-- ------------------------------------------- закрепление отметки -->
    <form v-if="canEdit && hasDraft" class="pin" @submit.prevent="pin">
      <div class="pin__row">
        <input v-model="draftName" class="pin__name" placeholder="Название" required />
        <!--
          step="any" обязателен: отметка снимается с геометрии модели и почти
          никогда не кратна круглому шагу. С step="0.05" браузер считал бы
          «7.03» недопустимым и молча не отправлял форму.
        -->
        <input
          v-model.number="draftValue"
          class="pin__value"
          type="number"
          step="any"
          required
        />
      </div>
      <button class="btn btn--primary btn--tiny" type="submit">Закрепить уровень</button>
    </form>

    <p v-else-if="canEdit" class="levels__idle">Деталь не выбрана.</p>

    <!-- ------------------------------------------------ список уровней -->
    <p v-if="!levels.length" class="levels__empty">Уровней пока нет.</p>

    <ul v-else class="levels__list">
      <li
        v-for="level in levels"
        :key="level.id"
        class="level"
        :class="{ 'is-selected': selectedIds.includes(level.id) }"
        @click="emit('toggle', level.id)"
      >
        <span class="level__name" :title="level.name">{{ level.name }}</span>
        <span class="level__value">{{ format(level.elevation) }}</span>
        <button
          v-if="canEdit"
          class="level__action"
          type="button"
          title="Переименовать"
          @click.stop="onRename(level)"
        >
          ✎
        </button>
        <button
          v-if="canEdit"
          class="level__action level__action--danger"
          type="button"
          title="Удалить уровень"
          @click.stop="emit('delete', level)"
        >
          ×
        </button>
      </li>
    </ul>

    <!-- ------------------------------------------ фильтрация видимости -->
    <div v-if="levels.length" class="filter">
      <p class="filter__hint">
        {{
          selectedIds.length === 0
            ? 'Выберите уровень, чтобы отсечь модель по нему.'
            : selectedIds.length === 1
              ? 'Выбран 1 уровень. Для режима «между» отметьте второй.'
              : 'Выбрано 2 уровня — доступен показ объёма между ними.'
        }}
      </p>
      <div class="filter__buttons">
        <button
          class="btn btn--tiny"
          :class="{ 'btn--active': filter === 'above' }"
          type="button"
          :disabled="!selectedIds.length"
          title="Показать только то, что выше отметки"
          @click="emit('set-filter', 'above')"
        >
          ▲ Выше
        </button>
        <button
          class="btn btn--tiny"
          :class="{ 'btn--active': filter === 'below' }"
          type="button"
          :disabled="!selectedIds.length"
          title="Показать только то, что ниже отметки"
          @click="emit('set-filter', 'below')"
        >
          ▼ Ниже
        </button>
        <button
          class="btn btn--tiny"
          :class="{ 'btn--active': filter === 'between' }"
          type="button"
          :disabled="!canPinBetween"
          title="Показать объём между двумя выбранными уровнями"
          @click="emit('set-filter', 'between')"
        >
          ⇕ Между
        </button>
        <button
          class="btn btn--tiny"
          type="button"
          :disabled="!selectedIds.length && filter === null"
          @click="emit('clear-filter')"
        >
          Сбросить
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.levels {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid #21262d;
}

.levels__header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.levels__header h2 {
  margin: 0;
  font-size: 15px;
}

.levels__count {
  font-size: 11px;
  color: #7d8590;
}

.levels__hint,
.levels__empty,
.levels__idle,
.filter__hint {
  margin: 0;
  font-size: 11px;
  color: #7d8590;
  line-height: 1.4;
}

.pin {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border-radius: 8px;
  background: rgba(255, 200, 87, 0.1);
  border: 1px solid rgba(255, 200, 87, 0.4);
}

.pin__row {
  display: flex;
  gap: 6px;
}

.pin__name {
  flex: 1;
  min-width: 0;
}

.pin__value {
  width: 82px;
}

.levels__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.level {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 6px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: #161b22;
  cursor: pointer;
  font-size: 12px;
}

.level:hover {
  border-color: #30363d;
}

.level.is-selected {
  border-color: #3fb950;
  background: rgba(63, 185, 80, 0.14);
}

.level__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.level__value {
  flex: none;
  color: #8b949e;
  font-variant-numeric: tabular-nums;
}

.level__action {
  flex: none;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #7d8590;
  cursor: pointer;
  font-size: 11px;
  line-height: 1;
}

.level__action:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #e6edf3;
}

.level__action--danger:hover {
  background: rgba(229, 83, 75, 0.2);
  color: #ff9f9a;
}

.filter {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid #21262d;
}

.filter__buttons {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.btn--active {
  border-color: var(--accent);
  color: #cfe2ff;
  background: rgba(47, 129, 247, 0.18);
}
</style>
