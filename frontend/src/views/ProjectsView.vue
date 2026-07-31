<script setup lang="ts">
/** Список доступных пользователю проектов. */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { api } from '@/api/client'
import { ROLE_LABEL } from '@/api/types'
import type { Project } from '@/api/types'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()

const projects = ref<Project[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

onMounted(async () => {
  try {
    projects.value = await api.listProjects()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Не удалось получить список проектов'
  } finally {
    loading.value = false
  }
})

function logout(): void {
  auth.logout()
  void router.push({ name: 'login' })
}
</script>

<template>
  <div class="projects">
    <header class="projects__header">
      <h1>Проекты</h1>
      <div class="projects__actions">
        <span class="projects__user">
          {{ auth.user?.username }} ·
          {{ auth.user ? ROLE_LABEL[auth.user.role] : '' }}
        </span>
        <!-- Раздел администрирования переехал внутрь личного кабинета. -->
        <button class="btn" type="button" @click="router.push({ name: 'account' })">
          Личный кабинет
        </button>
        <button class="btn btn--ghost" type="button" @click="logout">Выйти</button>
      </div>
    </header>

    <p v-if="loading">Загрузка…</p>
    <p v-else-if="error" class="projects__error">{{ error }}</p>
    <p v-else-if="!projects.length" class="projects__empty">
      Доступных проектов нет. Обратитесь к администратору.
    </p>

    <div class="projects__grid">
      <button
        v-for="project in projects"
        :key="project.id"
        class="project"
        type="button"
        @click="router.push({ name: 'viewer', params: { projectId: project.id } })"
      >
        <span class="project__name">{{ project.name }}</span>
        <span class="project__meta">
          {{ project.model_url ? 'модель загружена' : 'модель не загружена' }}
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.projects {
  max-width: 960px;
  margin: 0 auto;
  padding: 28px 20px;
}

.projects__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 22px;
  flex-wrap: wrap;
}

.projects__header h1 {
  margin: 0;
  font-size: 20px;
}

.projects__actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.projects__user {
  font-size: 12px;
  color: #7d8590;
}

.projects__error {
  color: #ff9f9a;
}

.projects__empty {
  color: #7d8590;
}

.projects__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}

.project {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 16px;
  text-align: left;
  border-radius: 10px;
  background: #0f141b;
  border: 1px solid #21262d;
  color: inherit;
  cursor: pointer;
  transition: border-color 0.15s ease;
}

.project:hover {
  border-color: #2f81f7;
}

.project__name {
  font-size: 15px;
  font-weight: 600;
}

.project__meta {
  font-size: 11px;
  color: #7d8590;
}
</style>
