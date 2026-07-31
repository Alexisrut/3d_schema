<script setup lang="ts">
/**
 * Верхняя панель 3D-вида: двухэтапная разметка, правка границ, прозрачность,
 * «Шаг назад», сброс камеры.
 *
 * Роли «Читатель» кнопки изменения не показываются вовсе (`canEdit`) —
 * остаются только вид, слои и прозрачность.
 */
import { computed } from 'vue'

import { MAX_EXTRUDE_HEIGHT, type DraftStage } from '@/lib/drafting'

const props = defineProps<{
  projectName: string
  connected: boolean
  /** Текущий шаг разметки: idle → polygon → extrude. */
  draftStage: DraftStage
  pointCount: number
  draftHeight: number
  canExtrude: boolean
  canCommit: boolean
  canUndo: boolean
  editMode: boolean
  /** Активен режим «магического выделения» (п. 3.2 доработок). */
  smartMode: boolean
  viewMode: boolean
  layersOpen: boolean
  /** На что подействует кнопка прозрачности прямо сейчас. */
  opacityScope: 'layers' | 'sectors' | 'all-layers'
  /** Сколько объектов она затронет. */
  opacityCount: number
  isAdmin: boolean
  canEdit: boolean
}>()

/** Подпись на кнопке прозрачности: пользователь видит, что именно изменится. */
const opacityScopeLabel = computed(() => {
  if (props.opacityScope === 'layers') return `слои (${props.opacityCount})`
  if (props.opacityScope === 'sectors') return `зоны (${props.opacityCount})`
  return `всю модель (${props.opacityCount})`
})

const emit = defineEmits<{
  (e: 'toggle-drawing'): void
  (e: 'start-extrude'): void
  (e: 'update-height', height: number): void
  (e: 'commit'): void
  (e: 'undo'): void
  (e: 'toggle-edit'): void
  (e: 'toggle-smart'): void
  (e: 'toggle-view-mode'): void
  (e: 'toggle-layers'): void
  (e: 'cycle-opacity'): void
  (e: 'reset-view'): void
  (e: 'export'): void
  (e: 'back'): void
  (e: 'account'): void
  (e: 'logout'): void
}>()

function onHeightInput(event: Event): void {
  emit('update-height', Number((event.target as HTMLInputElement).value))
}
</script>

<template>
  <header class="toolbar">
    <button class="btn btn--ghost" type="button" @click="emit('back')">← Проекты</button>

    <h1 class="toolbar__title">{{ projectName }}</h1>

    <span class="toolbar__status" :class="{ 'is-online': connected }">
      {{ connected ? 'обновления в реальном времени' : 'резервный режим опроса' }}
    </span>

    <span v-if="!canEdit" class="toolbar__badge" title="Роль «Читатель»: изменение данных недоступно">
      только чтение
    </span>

    <div class="toolbar__spacer" />

    <!-- ------------------------------------------------- шаг 1: контур -->
    <template v-if="draftStage === 'polygon'">
      <span class="toolbar__hint">
        Шаг 1 из 2: обведите площадь — точек {{ pointCount }} (минимум 3)
      </span>
      <button
        class="btn btn--primary"
        type="button"
        :disabled="!canExtrude"
        title="Перейти к заданию высоты зоны"
        @click="emit('start-extrude')"
      >
        Задать объём →
      </button>
      <button
        class="btn"
        type="button"
        :disabled="!canCommit"
        title="Оставить зону плоской, без объёма"
        @click="emit('commit')"
      >
        Закрепить плоской
      </button>
    </template>

    <!-- ------------------------------------------------- шаг 2: объём -->
    <template v-if="draftStage === 'extrude'">
      <span class="toolbar__hint">Шаг 2 из 2: высота зоны</span>
      <input
        class="toolbar__range"
        type="range"
        min="0"
        :max="Math.min(60, MAX_EXTRUDE_HEIGHT)"
        step="0.5"
        :value="draftHeight"
        @input="onHeightInput"
      />
      <input
        class="toolbar__number"
        type="number"
        min="0"
        :max="MAX_EXTRUDE_HEIGHT"
        step="0.5"
        :value="draftHeight"
        @input="onHeightInput"
      />
      <span class="toolbar__unit">м</span>
      <button class="btn btn--primary" type="button" :disabled="!canCommit" @click="emit('commit')">
        Закрепить зону
      </button>
    </template>

    <button
      v-if="canEdit"
      class="btn"
      :class="draftStage !== 'idle' ? 'btn--danger' : 'btn--primary'"
      type="button"
      :disabled="viewMode"
      @click="emit('toggle-drawing')"
    >
      {{ draftStage !== 'idle' ? 'Выйти из разметки' : 'Разметить зону' }}
    </button>

    <button
      v-if="canEdit"
      class="btn"
      :class="{ 'btn--active': smartMode }"
      type="button"
      :disabled="viewMode"
      title="Умное выделение: обведите область — детали, задетые контуром, войдут в зону целиком"
      @click="emit('toggle-smart')"
    >
      {{ smartMode ? '✓ Умное выделение' : '✨ Умное выделение' }}
    </button>

    <button
      v-if="canEdit"
      class="btn"
      :class="{ 'btn--active': editMode }"
      type="button"
      :disabled="viewMode"
      title="Показать маркеры вершин выбранной зоны и перетаскивать границы"
      @click="emit('toggle-edit')"
    >
      {{ editMode ? '✓ Правка границ' : 'Правка границ' }}
    </button>

    <button
      v-if="canEdit"
      class="btn"
      type="button"
      :disabled="!canUndo"
      title="Отменить последнее действие (Ctrl+Z)"
      @click="emit('undo')"
    >
      ↶ Шаг назад
    </button>

    <button
      class="btn"
      :class="{ 'btn--active': layersOpen }"
      type="button"
      title="Панель слоёв: видимость и прозрачность моделей"
      @click="emit('toggle-layers')"
    >
      Слои
    </button>

    <!--
      Кнопка никогда не бывает недоступной: без выделения она действует на все
      слои сцены. Иначе непонятно, при каких условиях она вообще работает.
    -->
    <button
      class="btn"
      type="button"
      :title="`Обычный вид → полупрозрачный → скрытый. Сейчас подействует на: ${opacityScopeLabel}`"
      @click="emit('cycle-opacity')"
    >
      Прозрачность
      <span class="toolbar__scope">{{ opacityScopeLabel }}</span>
    </button>

    <button
      class="btn"
      :class="{ 'btn--active': viewMode }"
      type="button"
      title="Только просмотр: разметка и выбор элементов модели отключены"
      @click="emit('toggle-view-mode')"
    >
      {{ viewMode ? '✓ Просмотр' : 'Просмотр' }}
    </button>

    <button class="btn" type="button" @click="emit('reset-view')">Сбросить вид</button>

    <button
      class="btn"
      type="button"
      title="Выгрузить все задачи и проблемы проекта в книгу Excel"
      @click="emit('export')"
    >
      ⤓ Excel
    </button>

    <!-- Кнопка «Администрирование» убрана: этот раздел теперь внутри ЛК. -->
    <button class="btn btn--ghost" type="button" @click="emit('account')">
      Личный кабинет
    </button>

    <button class="btn btn--ghost" type="button" @click="emit('logout')">Выйти</button>
  </header>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: #0f141b;
  border-bottom: 1px solid #21262d;
  flex-wrap: wrap;
}

.toolbar__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.toolbar__status {
  font-size: 11px;
  color: #7d8590;
  padding: 2px 8px;
  border-radius: 10px;
  border: 1px solid #21262d;
}

.toolbar__status.is-online {
  color: #3fb950;
  border-color: rgba(63, 185, 80, 0.4);
}

.toolbar__badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(255, 200, 87, 0.16);
  border: 1px solid rgba(255, 200, 87, 0.45);
  color: #ffd88a;
}

.toolbar__spacer {
  flex: 1;
}

.toolbar__hint {
  font-size: 12px;
  color: #ffc857;
}

.toolbar__range {
  width: 120px;
  padding: 0;
}

.toolbar__number {
  width: 68px;
}

.toolbar__unit {
  font-size: 12px;
  color: #8b949e;
}

.toolbar__scope {
  margin-left: 4px;
  font-size: 11px;
  color: #8b949e;
}

.btn--active {
  border-color: var(--accent);
  color: #cfe2ff;
  background: rgba(47, 129, 247, 0.18);
}
</style>
