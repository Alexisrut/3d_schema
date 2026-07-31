<script setup lang="ts">
/**
 * Список зон объекта — второй способ их выделить (п. 2.1 и 2.3 доработок).
 *
 * В сцене зону не всегда удобно поймать курсором: она может быть скрыта
 * фасадом или отнесена за пределы кадра. Список даёт те же Ctrl/Cmd и Shift,
 * что и клик по модели, и из него же работает массовое удаление.
 */
import { computed } from 'vue'

import type { SectorSummary } from '@/api/types'
import { modeFromEvent, nextVisibility, type SelectMode, type Visibility } from '@/lib/selection'

const props = defineProps<{
  sectors: SectorSummary[]
  selectedIds: number[]
  visibility: Record<number, Visibility>
  canEdit: boolean
}>()

const emit = defineEmits<{
  (e: 'select', payload: { sectorId: number; mode: SelectMode }): void
  (e: 'open-card', sectorId: number): void
  (e: 'set-visibility', payload: { id: number; value: Visibility }): void
  (e: 'select-all'): void
  (e: 'clear'): void
  (e: 'delete-selected'): void
}>()

const VISIBILITY_ICON: Record<Visibility, string> = {
  normal: '👁',
  ghost: '◐',
  hidden: '🚫',
}

const allSelected = computed(
  () => props.sectors.length > 0 && props.selectedIds.length === props.sectors.length,
)

function stateOf(id: number): Visibility {
  return props.visibility[id] ?? 'normal'
}

function statusColor(sector: SectorSummary): string {
  if (sector.open_problems > 0) return '#e5534b'
  if (sector.progress_percent >= 100) return '#3fb950'
  if (sector.progress_percent > 0) return '#2f81f7'
  return '#8b9bb4'
}
</script>

<template>
  <section class="sectors">
    <header class="sectors__header">
      <h2>Зоны</h2>
      <span class="sectors__count">{{ sectors.length }}</span>
    </header>

    <div class="sectors__toolbar">
      <button
        class="btn btn--tiny"
        type="button"
        :disabled="!sectors.length"
        @click="allSelected ? emit('clear') : emit('select-all')"
      >
        {{ allSelected ? 'Снять выбор' : 'Выбрать все' }}
      </button>
      <button
        v-if="canEdit"
        class="btn btn--tiny btn--danger"
        type="button"
        :disabled="!selectedIds.length"
        @click="emit('delete-selected')"
      >
        Удалить выбранные
      </button>
    </div>

    <p v-if="!sectors.length" class="sectors__empty">Зон пока нет — разметьте первую.</p>

    <ul class="sectors__list">
      <li
        v-for="sector in sectors"
        :key="sector.id"
        class="row"
        :class="{
          'is-selected': selectedIds.includes(sector.id),
          'is-dim': stateOf(sector.id) !== 'normal',
        }"
        @click="emit('select', { sectorId: sector.id, mode: modeFromEvent($event) })"
      >
        <span class="row__dot" :style="{ background: statusColor(sector) }" />
        <span class="row__name" :title="sector.name">{{ sector.name }}</span>
        <span v-if="sector.height > 0" class="row__badge" title="Зона задана объёмом">об.</span>
        <span class="row__percent">{{ sector.progress_percent.toFixed(0) }}%</span>
        <button
          class="row__action"
          type="button"
          title="Прозрачность зоны"
          @click.stop="emit('set-visibility', { id: sector.id, value: nextVisibility(stateOf(sector.id)) })"
        >
          {{ VISIBILITY_ICON[stateOf(sector.id)] }}
        </button>
        <button
          class="row__action"
          type="button"
          title="Открыть карточку зоны"
          @click.stop="emit('open-card', sector.id)"
        >
          ⤢
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.sectors {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid #21262d;
}

.sectors__header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sectors__header h2 {
  margin: 0;
  font-size: 15px;
}

.sectors__count {
  font-size: 11px;
  color: #7d8590;
}

.sectors__toolbar {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.sectors__empty {
  margin: 0;
  font-size: 12px;
  color: #7d8590;
}

.sectors__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.row {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 6px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: #161b22;
  cursor: pointer;
  font-size: 12px;
}

.row:hover {
  border-color: #30363d;
}

.row.is-selected {
  border-color: var(--accent);
  background: rgba(47, 129, 247, 0.16);
}

.row.is-dim .row__name {
  color: #6e7681;
}

.row__dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.row__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row__badge {
  flex: none;
  font-size: 10px;
  padding: 0 4px;
  border-radius: 4px;
  background: rgba(47, 129, 247, 0.2);
  color: #8ab4f8;
}

.row__percent {
  flex: none;
  color: #8b949e;
  font-variant-numeric: tabular-nums;
}

.row__action {
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

.row__action:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #e6edf3;
}
</style>
