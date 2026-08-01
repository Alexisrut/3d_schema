<script setup lang="ts">
/**
 * Нижняя панель мобильного вида.
 *
 * В обычном состоянии — четыре вкладки, открывающие шторки. Во время разметки
 * панель целиком отдаётся её шагам: на телефоне это самая «многорукая»
 * операция, и переключаться между вкладками и разметкой посреди обвода зоны
 * было бы неудобно.
 *
 * Кнопок ровно столько, сколько нужно на текущем шаге, — остальное живёт в
 * шторке «Ещё». Держать десять кнопок верхней панели на экране 375 px нельзя.
 */
import { MAX_EXTRUDE_HEIGHT, type DraftStage } from '@/lib/drafting'

export type MobileTab = 'sectors' | 'brigades' | 'layers' | 'levels' | 'more'

defineProps<{
  draftStage: DraftStage
  pointCount: number
  draftHeight: number
  canExtrude: boolean
  canCommit: boolean
  canUndo: boolean
  /** Шаг режима «Выделение по деталям» и его состояние. */
  detailStage: 'idle' | 'pick' | 'extrude'
  detailCount: number
  detailHeight: number
  sectorCount: number
  brigadeCount: number
  layerCount: number
  /** Открытая шторка — её вкладка подсвечивается. */
  activeTab: MobileTab | null
}>()

const emit = defineEmits<{
  (e: 'open-tab', tab: MobileTab): void
  (e: 'start-extrude'): void
  (e: 'update-height', height: number): void
  (e: 'commit'): void
  (e: 'cancel-drawing'): void
  (e: 'detail-extrude'): void
  (e: 'detail-height', height: number): void
  (e: 'detail-commit'): void
  (e: 'cancel-details'): void
  (e: 'undo'): void
}>()

function onHeightInput(event: Event): void {
  emit('update-height', Number((event.target as HTMLInputElement).value))
}

function onDetailHeightInput(event: Event): void {
  emit('detail-height', Number((event.target as HTMLInputElement).value))
}
</script>

<template>
  <nav class="bar" :class="{ 'bar--drafting': draftStage !== 'idle' }">
    <!-- ------------------------------------------------ режим разметки -->
    <template v-if="draftStage === 'polygon'">
      <p class="bar__hint">
        <strong>Шаг 1 из 2.</strong> Касайтесь модели, чтобы обвести площадь.
        Точек: {{ pointCount }} из 3 минимум.
      </p>
      <div class="bar__row">
        <button class="btn bar__btn" type="button" @click="emit('cancel-drawing')">
          Отмена
        </button>
        <button
          class="btn bar__btn"
          type="button"
          :disabled="!canUndo"
          title="Убрать последнюю точку"
          @click="emit('undo')"
        >
          ↶
        </button>
        <button
          class="btn bar__btn"
          type="button"
          :disabled="!canCommit"
          @click="emit('commit')"
        >
          Плоской
        </button>
        <button
          class="btn btn--primary bar__btn bar__btn--wide"
          type="button"
          :disabled="!canExtrude"
          @click="emit('start-extrude')"
        >
          Объём →
        </button>
      </div>
    </template>

    <template v-else-if="draftStage === 'extrude'">
      <div class="bar__height">
        <span class="bar__hint bar__hint--inline"><strong>Шаг 2.</strong> Высота</span>
        <input
          class="bar__range"
          type="range"
          min="0"
          :max="Math.min(60, MAX_EXTRUDE_HEIGHT)"
          step="0.5"
          :value="draftHeight"
          @input="onHeightInput"
        />
        <span class="bar__value">{{ draftHeight.toFixed(1) }} м</span>
      </div>
      <div class="bar__row">
        <button class="btn bar__btn" type="button" @click="emit('cancel-drawing')">
          Отмена
        </button>
        <button
          class="btn bar__btn"
          type="button"
          :disabled="!canUndo"
          title="Вернуться к правке контура"
          @click="emit('undo')"
        >
          ↶
        </button>
        <button
          class="btn btn--primary bar__btn bar__btn--wide"
          type="button"
          :disabled="!canCommit"
          @click="emit('commit')"
        >
          Закрепить зону
        </button>
      </div>
    </template>

    <!--
      Выделение по деталям: те же два шага, что и у разметки. Ветки идут
      ПОСЛЕ обеих веток разметки — на телефоне режимы взаимоисключающие,
      и порядок здесь фиксирует, кто главнее, если состояние разъедется.
    -->
    <template v-else-if="detailStage === 'pick'">
      <p class="bar__hint">
        <strong>Шаг 1 из 2.</strong> Касайтесь деталей модели. Повторное
        касание снимает деталь. Выбрано: {{ detailCount }}.
      </p>
      <div class="bar__row">
        <button class="btn bar__btn" type="button" @click="emit('cancel-details')">
          Отмена
        </button>
        <button
          class="btn bar__btn"
          type="button"
          :disabled="!canUndo"
          title="Убрать последнюю деталь"
          @click="emit('undo')"
        >
          ↶
        </button>
        <button
          class="btn btn--primary bar__btn bar__btn--wide"
          type="button"
          :disabled="detailCount === 0"
          @click="emit('detail-extrude')"
        >
          Объём →
        </button>
      </div>
    </template>

    <template v-else-if="detailStage === 'extrude'">
      <div class="bar__height">
        <span class="bar__hint bar__hint--inline"><strong>Шаг 2.</strong> Высота</span>
        <input
          class="bar__range"
          type="range"
          min="0"
          :max="Math.min(60, MAX_EXTRUDE_HEIGHT)"
          step="0.5"
          :value="detailHeight"
          @input="onDetailHeightInput"
        />
        <span class="bar__value">{{ detailHeight.toFixed(1) }} м</span>
      </div>
      <div class="bar__row">
        <button class="btn bar__btn" type="button" @click="emit('cancel-details')">
          Отмена
        </button>
        <button
          class="btn bar__btn"
          type="button"
          :disabled="!canUndo"
          title="Вернуться к выбору деталей"
          @click="emit('undo')"
        >
          ↶
        </button>
        <button
          class="btn btn--primary bar__btn bar__btn--wide"
          type="button"
          @click="emit('detail-commit')"
        >
          Закрепить зону
        </button>
      </div>
    </template>

    <!-- ------------------------------------------------------- вкладки -->
    <template v-else>
      <button
        class="tab"
        :class="{ 'is-active': activeTab === 'sectors' }"
        type="button"
        @click="emit('open-tab', 'sectors')"
      >
        <span class="tab__icon">▦</span>
        <span class="tab__label">Зоны</span>
        <span v-if="sectorCount" class="tab__count">{{ sectorCount }}</span>
      </button>

      <button
        class="tab"
        :class="{ 'is-active': activeTab === 'brigades' }"
        type="button"
        @click="emit('open-tab', 'brigades')"
      >
        <span class="tab__icon">👷</span>
        <span class="tab__label">Бригады</span>
        <span v-if="brigadeCount" class="tab__count">{{ brigadeCount }}</span>
      </button>

      <button
        class="tab"
        :class="{ 'is-active': activeTab === 'layers' }"
        type="button"
        @click="emit('open-tab', 'layers')"
      >
        <span class="tab__icon">◳</span>
        <span class="tab__label">Слои</span>
        <span v-if="layerCount" class="tab__count">{{ layerCount }}</span>
      </button>

      <button
        class="tab"
        :class="{ 'is-active': activeTab === 'more' }"
        type="button"
        @click="emit('open-tab', 'more')"
      >
        <span class="tab__icon">⋯</span>
        <span class="tab__label">Ещё</span>
      </button>
    </template>
  </nav>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: stretch;
  gap: 2px;
  padding: 4px 6px calc(4px + env(safe-area-inset-bottom, 0));
  background: #0f141b;
  border-top: 1px solid #21262d;
  /* Панель поверх сцены, но под шторками и окнами подтверждения. */
  z-index: 20;
}

.bar--drafting {
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px calc(8px + env(safe-area-inset-bottom, 0));
  border-top-color: rgba(255, 200, 87, 0.5);
}

.bar__hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.35;
  color: #ffd88a;
}

.bar__hint--inline {
  flex: none;
  white-space: nowrap;
}

.bar__row {
  display: flex;
  gap: 6px;
}

.bar__btn {
  flex: 1;
  /* 44 px — минимальная площадь касания, ниже палец промахивается. */
  min-height: 44px;
  padding: 8px 6px;
  font-size: 13px;
}

.bar__btn--wide {
  flex: 1.6;
}

.bar__height {
  display: flex;
  align-items: center;
  gap: 8px;
}

.bar__range {
  flex: 1;
  min-width: 0;
  height: 32px;
}

.bar__value {
  flex: none;
  min-width: 56px;
  text-align: right;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.tab {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-height: 52px;
  padding: 6px 2px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #8b949e;
  font: inherit;
  cursor: pointer;
}

.tab.is-active {
  background: rgba(47, 129, 247, 0.16);
  color: #cfe2ff;
}

.tab__icon {
  font-size: 16px;
  line-height: 1;
}

.tab__label {
  font-size: 11px;
}

.tab__count {
  position: absolute;
  top: 4px;
  right: 50%;
  transform: translateX(22px);
  min-width: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background: #21262d;
  color: #c9d1d9;
  font-size: 10px;
  line-height: 16px;
  text-align: center;
}
</style>
