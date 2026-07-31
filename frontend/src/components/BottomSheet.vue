<script setup lang="ts">
/**
 * Нижняя шторка для мобильного вида.
 *
 * На телефоне боковым панелям места нет, а прятать их в полноэкранные окна
 * плохо: пользователь теряет из виду 3D-сцену, ради которой всё и открыл.
 * Шторка занимает нижнюю часть экрана, сцена остаётся видимой сверху.
 *
 * Закрыть можно тремя способами — крестиком, тапом по фону и свайпом вниз за
 * «ручку». Свайп реализован только на шапке: если ловить его по всей площади,
 * он будет конфликтовать с прокруткой содержимого.
 */
import { computed, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    /** Доля высоты экрана: обычная шторка или почти во весь экран. */
    size?: 'half' | 'tall'
  }>(),
  { size: 'half' },
)

const emit = defineEmits<{ (e: 'close'): void }>()

/** Сдвиг вниз во время свайпа, px. */
const dragOffset = ref(0)
/** Насколько нужно утянуть шторку вниз, чтобы она закрылась. */
const CLOSE_THRESHOLD = 90

let pointerId: number | null = null
let startY = 0

const sheetStyle = computed(() => ({
  transform: dragOffset.value > 0 ? `translateY(${dragOffset.value}px)` : '',
  // Во время перетаскивания анимация мешает — она догоняла бы палец.
  transition: pointerId === null ? '' : 'none',
}))

watch(
  () => props.open,
  (open) => {
    if (!open) reset()
  },
)

function reset(): void {
  dragOffset.value = 0
  pointerId = null
}

function onGrabStart(event: PointerEvent): void {
  if (pointerId !== null) return
  pointerId = event.pointerId
  startY = event.clientY
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function onGrabMove(event: PointerEvent): void {
  if (pointerId !== event.pointerId) return
  // Вверх шторка не тянется: выше её собственной высоты идти некуда.
  dragOffset.value = Math.max(0, event.clientY - startY)
}

function onGrabEnd(event: PointerEvent): void {
  if (pointerId !== event.pointerId) return
  const shouldClose = dragOffset.value > CLOSE_THRESHOLD
  reset()
  if (shouldClose) emit('close')
}
</script>

<template>
  <transition name="sheet">
    <div v-if="open" class="sheet" @click.self="emit('close')">
      <section
        class="sheet__panel"
        :class="`sheet__panel--${size}`"
        :style="sheetStyle"
        role="dialog"
        aria-modal="true"
      >
        <header
          class="sheet__head"
          @pointerdown="onGrabStart"
          @pointermove="onGrabMove"
          @pointerup="onGrabEnd"
          @pointercancel="onGrabEnd"
        >
          <span class="sheet__grabber" />
          <h2 class="sheet__title">{{ title }}</h2>
          <button class="sheet__close" type="button" title="Закрыть" @click="emit('close')">
            ×
          </button>
        </header>

        <div class="sheet__body">
          <slot />
        </div>
      </section>
    </div>
  </transition>
</template>

<style scoped>
.sheet {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  /* Фон затемняем слабо: под шторкой остаётся сцена, и её должно быть видно. */
  background: rgba(0, 0, 0, 0.35);
}

.sheet__panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: #0f141b;
  border-top: 1px solid #30363d;
  border-radius: 14px 14px 0 0;
  box-shadow: 0 -12px 32px rgba(0, 0, 0, 0.45);
  transition: transform 0.18s ease;
}

.sheet__panel--half {
  height: 58vh;
}

.sheet__panel--tall {
  height: 86vh;
}

.sheet__head {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 12px 8px;
  border-bottom: 1px solid #21262d;
  /* Шапка — зона свайпа, прокрутку под пальцем здесь глушим. */
  touch-action: none;
  cursor: grab;
}

.sheet__grabber {
  position: absolute;
  top: 6px;
  left: 50%;
  width: 36px;
  height: 4px;
  border-radius: 2px;
  background: #30363d;
  transform: translateX(-50%);
}

.sheet__title {
  flex: 1;
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.sheet__close {
  flex: none;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #8b949e;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
}

.sheet__close:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #e6edf3;
}

.sheet__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  /* Отступ под домашнюю полосу iPhone. */
  padding-bottom: env(safe-area-inset-bottom, 0);
}

.sheet-enter-active,
.sheet-leave-active {
  transition: opacity 0.18s ease;
}

.sheet-enter-active .sheet__panel,
.sheet-leave-active .sheet__panel {
  transition: transform 0.18s ease;
}

.sheet-enter-from,
.sheet-leave-to {
  opacity: 0;
}

.sheet-enter-from .sheet__panel,
.sheet-leave-to .sheet__panel {
  transform: translateY(100%);
}
</style>
