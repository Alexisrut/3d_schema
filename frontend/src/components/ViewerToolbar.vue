<script setup lang="ts">
/** Верхняя панель 3D-вида: режим разметки, «Шаг назад», сброс камеры. */
defineProps<{
  projectName: string
  connected: boolean
  drawing: boolean
  pointCount: number
  canUndo: boolean
  canCommit: boolean
  isAdmin: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle-drawing'): void
  (e: 'commit'): void
  (e: 'undo'): void
  (e: 'reset-view'): void
  (e: 'back'): void
  (e: 'admin'): void
  (e: 'logout'): void
}>()
</script>

<template>
  <header class="toolbar">
    <button class="btn btn--ghost" type="button" @click="emit('back')">← Проекты</button>

    <h1 class="toolbar__title">{{ projectName }}</h1>

    <span class="toolbar__status" :class="{ 'is-online': connected }">
      {{ connected ? 'обновления в реальном времени' : 'резервный режим опроса' }}
    </span>

    <div class="toolbar__spacer" />

    <template v-if="drawing">
      <span class="toolbar__hint">
        Кликайте по модели: точек — {{ pointCount }} (минимум 3)
      </span>
      <button class="btn btn--primary" type="button" :disabled="!canCommit" @click="emit('commit')">
        Закрепить зону
      </button>
    </template>

    <button
      class="btn"
      :class="drawing ? 'btn--danger' : 'btn--primary'"
      type="button"
      @click="emit('toggle-drawing')"
    >
      {{ drawing ? 'Выйти из разметки' : 'Разметить зону' }}
    </button>

    <button
      class="btn"
      type="button"
      :disabled="!canUndo"
      title="Отменить последнее действие (Ctrl+Z)"
      @click="emit('undo')"
    >
      ↶ Шаг назад
    </button>

    <button class="btn" type="button" @click="emit('reset-view')">Сбросить вид</button>

    <button v-if="isAdmin" class="btn btn--ghost" type="button" @click="emit('admin')">
      Администрирование
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

.toolbar__spacer {
  flex: 1;
}

.toolbar__hint {
  font-size: 12px;
  color: #ffc857;
}
</style>
