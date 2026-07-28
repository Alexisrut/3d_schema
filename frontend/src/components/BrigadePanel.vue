<script setup lang="ts">
/**
 * Панель бригад (п. 3.4 ТЗ). Карточку можно перетащить мышью
 * на сектор в 3D-сцене или на его виджет.
 */
import { computed, ref } from 'vue'

import type { BrigadeWithAssignment, SectorSummary } from '@/api/types'
import { draggingBrigadeId, dragHoverSectorId } from '@/three/sceneBus'

const props = defineProps<{
  brigades: BrigadeWithAssignment[]
  sectors: SectorSummary[]
}>()

const emit = defineEmits<{
  (e: 'create', payload: { name: string; brigadir: string; cnt_people: number }): void
  (e: 'delete', brigadeId: number): void
  (e: 'unassign', sectorId: number): void
}>()

const showForm = ref(false)
const name = ref('')
const brigadir = ref('')
const cntPeople = ref(1)

const free = computed(() => props.brigades.filter((b) => b.assigned_sector_ids.length === 0))
const busy = computed(() => props.brigades.filter((b) => b.assigned_sector_ids.length > 0))

function sectorNames(brigade: BrigadeWithAssignment): string {
  return brigade.assigned_sector_ids
    .map((id) => props.sectors.find((s) => s.id === id)?.name ?? `#${id}`)
    .join(', ')
}

function onDragStart(event: DragEvent, brigadeId: number): void {
  event.dataTransfer?.setData('application/x-brigade-id', String(brigadeId))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
  draggingBrigadeId.value = brigadeId
}

function onDragEnd(): void {
  draggingBrigadeId.value = null
  dragHoverSectorId.value = null
}

function submit(): void {
  const trimmed = name.value.trim()
  if (!trimmed) return
  emit('create', {
    name: trimmed,
    brigadir: brigadir.value.trim(),
    cnt_people: Math.max(0, Number(cntPeople.value) || 0),
  })
  name.value = ''
  brigadir.value = ''
  cntPeople.value = 1
  showForm.value = false
}
</script>

<template>
  <aside class="panel">
    <header class="panel__header">
      <h2>Бригады</h2>
      <button class="btn btn--ghost" type="button" @click="showForm = !showForm">
        {{ showForm ? 'Отмена' : '+ Бригада' }}
      </button>
    </header>

    <form v-if="showForm" class="panel__form" @submit.prevent="submit">
      <input v-model="name" placeholder="Название (Монолитчики 3)" required />
      <input v-model="brigadir" placeholder="ФИО бригадира" />
      <input v-model.number="cntPeople" type="number" min="0" placeholder="Человек" />
      <button class="btn btn--primary" type="submit">Добавить</button>
    </form>

    <p class="panel__hint">Перетащите карточку на зону в 3D-сцене, чтобы назначить бригаду.</p>

    <section v-if="free.length" class="panel__group">
      <h3>Свободные</h3>
      <article
        v-for="brigade in free"
        :key="brigade.id"
        class="brigade"
        draggable="true"
        @dragstart="onDragStart($event, brigade.id)"
        @dragend="onDragEnd"
      >
        <div class="brigade__name">{{ brigade.name }}</div>
        <div class="brigade__meta">
          <span v-if="brigade.brigadir">{{ brigade.brigadir }}</span>
          <span>{{ brigade.cnt_people }} чел.</span>
        </div>
        <button
          class="brigade__remove"
          type="button"
          title="Удалить бригаду"
          @click="emit('delete', brigade.id)"
        >
          ×
        </button>
      </article>
    </section>

    <section v-if="busy.length" class="panel__group">
      <h3>Назначены</h3>
      <article
        v-for="brigade in busy"
        :key="brigade.id"
        class="brigade brigade--busy"
        draggable="true"
        @dragstart="onDragStart($event, brigade.id)"
        @dragend="onDragEnd"
      >
        <div class="brigade__name">{{ brigade.name }}</div>
        <div class="brigade__meta">
          <span v-if="brigade.brigadir">{{ brigade.brigadir }}</span>
          <span>{{ brigade.cnt_people }} чел.</span>
        </div>
        <div class="brigade__sectors">→ {{ sectorNames(brigade) }}</div>
        <button
          v-for="sectorId in brigade.assigned_sector_ids"
          :key="sectorId"
          class="btn btn--tiny"
          type="button"
          @click="emit('unassign', sectorId)"
        >
          Снять с «{{ props.sectors.find((s) => s.id === sectorId)?.name ?? sectorId }}»
        </button>
      </article>
    </section>

    <p v-if="!brigades.length" class="panel__empty">Бригад пока нет.</p>
  </aside>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 260px;
  padding: 14px;
  overflow-y: auto;
  background: #0f141b;
  border-right: 1px solid #21262d;
}

.panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.panel__header h2 {
  margin: 0;
  font-size: 15px;
}

.panel__form {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.panel__hint {
  margin: 0;
  font-size: 11px;
  color: #7d8590;
  line-height: 1.4;
}

.panel__group h3 {
  margin: 0 0 8px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #7d8590;
}

.panel__empty {
  color: #7d8590;
  font-size: 12px;
}

.brigade {
  position: relative;
  padding: 10px;
  margin-bottom: 8px;
  border-radius: 8px;
  background: #161b22;
  border: 1px solid #21262d;
  cursor: grab;
}

.brigade:active {
  cursor: grabbing;
}

.brigade--busy {
  border-color: rgba(47, 129, 247, 0.45);
}

.brigade__name {
  font-weight: 600;
  font-size: 13px;
}

.brigade__meta {
  display: flex;
  gap: 10px;
  margin-top: 4px;
  font-size: 11px;
  color: #8b949e;
}

.brigade__sectors {
  margin-top: 6px;
  font-size: 11px;
  color: #58a6ff;
}

.brigade__remove {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #7d8590;
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
}

.brigade__remove:hover {
  background: rgba(229, 83, 75, 0.2);
  color: #ff9f9a;
}
</style>
