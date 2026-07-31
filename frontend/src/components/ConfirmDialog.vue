<script setup lang="ts">
/**
 * Модальное подтверждение опасного действия (п. 2.3 доработок).
 *
 * Заменяет window.confirm: тот не позволяет ни перечислить, что именно
 * удаляется, ни оформить кнопку как опасную, ни закрыться по Esc в общем
 * для приложения стиле.
 */
import { nextTick, ref, watch } from 'vue'

const props = defineProps<{
  open: boolean
  title: string
  /** Основной текст: «Вы действительно хотите удалить …?». */
  message: string
  /** Список удаляемых объектов — показывается, когда их несколько. */
  items?: string[]
  confirmLabel?: string
  cancelLabel?: string
  /**
   * Вид кнопки подтверждения; по умолчанию — опасное действие.
   *
   * Строка, а не boolean: необъявленный boolean-проп Vue приводит к false,
   * из-за чего условие «не danger → primary» делало кнопку удаления
   * приветливо-синей везде, где проп не передан явно.
   */
  confirmVariant?: 'danger' | 'primary'
}>()

const emit = defineEmits<{
  (e: 'confirm'): void
  (e: 'cancel'): void
}>()

const confirmButton = ref<HTMLButtonElement | null>(null)
/** Сколько объектов показываем списком, прежде чем свернуть в «и ещё N». */
const VISIBLE_ITEMS = 8

watch(
  () => props.open,
  async (open) => {
    if (!open) return
    // Фокус на кнопке подтверждения: Enter завершает действие, Esc отменяет.
    await nextTick()
    confirmButton.value?.focus()
  },
)

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation()
    emit('cancel')
  }
}
</script>

<template>
  <div v-if="open" class="confirm" @click.self="emit('cancel')" @keydown="onKeydown">
    <div class="confirm__card" role="dialog" aria-modal="true">
      <h3 class="confirm__title">{{ title }}</h3>
      <p class="confirm__message">{{ message }}</p>

      <ul v-if="items && items.length > 1" class="confirm__items">
        <li v-for="(item, index) in items.slice(0, VISIBLE_ITEMS)" :key="index">{{ item }}</li>
        <li v-if="items.length > VISIBLE_ITEMS" class="confirm__more">
          …и ещё {{ items.length - VISIBLE_ITEMS }}
        </li>
      </ul>

      <p class="confirm__note">Действие нельзя отменить кнопкой «Шаг назад».</p>

      <div class="confirm__actions">
        <button class="btn" type="button" @click="emit('cancel')">
          {{ cancelLabel ?? 'Отмена' }}
        </button>
        <button
          ref="confirmButton"
          class="btn"
          :class="confirmVariant === 'primary' ? 'btn--primary' : 'btn--danger'"
          type="button"
          @click="emit('confirm')"
        >
          {{ confirmLabel ?? 'Удалить' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.confirm {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.6);
  z-index: 80;
}

.confirm__card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 340px;
  max-width: 460px;
  padding: 18px;
  border-radius: 10px;
  background: #0f141b;
  border: 1px solid #30363d;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.5);
}

.confirm__title {
  margin: 0;
  font-size: 15px;
}

.confirm__message {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: #c9d1d9;
}

.confirm__items {
  margin: 0;
  padding-left: 18px;
  max-height: 168px;
  overflow-y: auto;
  font-size: 12px;
  color: #8b949e;
  line-height: 1.5;
}

.confirm__more {
  list-style: none;
  margin-left: -18px;
  color: #7d8590;
}

.confirm__note {
  margin: 0;
  font-size: 11px;
  color: #7d8590;
}

.confirm__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
</style>
