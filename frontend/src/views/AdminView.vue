<script setup lang="ts">
/**
 * Панель администратора (п. 2 ТЗ): проекты и загрузка .glb,
 * пользователи и выдача доступов к конкретным проектам.
 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { api } from '@/api/client'
import type { Project, User, UserRole } from '@/api/types'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()

const projects = ref<Project[]>([])
const users = ref<User[]>([])
const message = ref<string | null>(null)
const error = ref<string | null>(null)
const uploadingFor = ref<number | null>(null)

const newProjectName = ref('')
const newUser = ref<{ username: string; password: string; role: UserRole }>({
  username: '',
  password: '',
  role: 'user',
})

async function reload(): Promise<void> {
  try {
    const [p, u] = await Promise.all([api.listProjects(), api.listUsers()])
    projects.value = p
    users.value = u
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Не удалось загрузить данные'
  }
}

onMounted(reload)

function notify(text: string): void {
  message.value = text
  error.value = null
  window.setTimeout(() => {
    if (message.value === text) message.value = null
  }, 3500)
}

function fail(e: unknown): void {
  error.value = e instanceof Error ? e.message : 'Операция не выполнена'
}

async function createProject(): Promise<void> {
  const name = newProjectName.value.trim()
  if (!name) return
  try {
    await api.createProject(name)
    newProjectName.value = ''
    await reload()
    notify('Проект создан')
  } catch (e) {
    fail(e)
  }
}

async function deleteProject(project: Project): Promise<void> {
  if (!window.confirm(`Удалить проект «${project.name}» со всеми зонами?`)) return
  try {
    await api.deleteProject(project.id)
    await reload()
    notify('Проект удалён')
  } catch (e) {
    fail(e)
  }
}

async function onModelSelected(event: Event, project: Project): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  uploadingFor.value = project.id
  try {
    await api.uploadModel(project.id, file)
    await reload()
    notify(`Модель загружена в «${project.name}»`)
  } catch (e) {
    fail(e)
  } finally {
    uploadingFor.value = null
    input.value = ''
  }
}

async function createUser(): Promise<void> {
  const { username, password, role } = newUser.value
  if (!username.trim() || !password) return
  try {
    await api.createUser({
      username: username.trim(),
      password,
      role,
      allowed_project_ids: [],
    })
    newUser.value = { username: '', password: '', role: 'user' }
    await reload()
    notify('Пользователь создан')
  } catch (e) {
    fail(e)
  }
}

async function toggleAccess(user: User, projectId: number, allowed: boolean): Promise<void> {
  const next = allowed
    ? [...new Set([...user.allowed_project_ids, projectId])]
    : user.allowed_project_ids.filter((id) => id !== projectId)
  try {
    const updated = await api.updateUser(user.id, { allowed_project_ids: next })
    users.value = users.value.map((u) => (u.id === updated.id ? updated : u))
  } catch (e) {
    fail(e)
  }
}

function onAccessToggle(event: Event, user: User, projectId: number): void {
  void toggleAccess(user, projectId, (event.target as HTMLInputElement).checked)
}

async function deleteUser(user: User): Promise<void> {
  if (!window.confirm(`Удалить пользователя «${user.username}»?`)) return
  try {
    await api.deleteUser(user.id)
    await reload()
    notify('Пользователь удалён')
  } catch (e) {
    fail(e)
  }
}

function logout(): void {
  auth.logout()
  void router.push({ name: 'login' })
}

async function resetPassword(user: User): Promise<void> {
  const password = window.prompt(`Новый пароль для «${user.username}»`)
  if (!password) return
  try {
    await api.updateUser(user.id, { password })
    notify('Пароль изменён')
  } catch (e) {
    fail(e)
  }
}
</script>

<template>
  <div class="admin">
    <header class="admin__header">
      <h1>Администрирование</h1>
      <div class="admin__actions">
        <button class="btn" type="button" @click="router.push({ name: 'projects' })">
          К проектам
        </button>
        <button class="btn btn--ghost" type="button" @click="logout">Выйти</button>
      </div>
    </header>

    <p v-if="message" class="admin__message">{{ message }}</p>
    <p v-if="error" class="admin__error">{{ error }}</p>

    <!-- ---------------------------------------------------------- проекты -->
    <section class="card">
      <h2>Проекты и 3D-модели</h2>

      <form class="row" @submit.prevent="createProject">
        <input v-model="newProjectName" placeholder="Название объекта" required />
        <button class="btn btn--primary" type="submit">Создать проект</button>
      </form>

      <table class="table">
        <thead>
          <tr>
            <th>#</th>
            <th>Название</th>
            <th>Модель (.glb)</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="project in projects" :key="project.id">
            <td>{{ project.id }}</td>
            <td>{{ project.name }}</td>
            <td>
              <span v-if="project.model_url" class="tag tag--ok">загружена</span>
              <span v-else class="tag">нет</span>
              <label class="upload">
                <input
                  type="file"
                  accept=".glb,.gltf"
                  @change="onModelSelected($event, project)"
                />
                <span>{{ uploadingFor === project.id ? 'Загрузка…' : 'Загрузить .glb' }}</span>
              </label>
            </td>
            <td class="table__actions">
              <button
                class="btn btn--tiny"
                type="button"
                @click="router.push({ name: 'viewer', params: { projectId: project.id } })"
              >
                Открыть
              </button>
              <button class="btn btn--tiny btn--danger" type="button" @click="deleteProject(project)">
                Удалить
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- ----------------------------------------------------- пользователи -->
    <section class="card">
      <h2>Пользователи и доступы</h2>

      <form class="row" @submit.prevent="createUser">
        <input v-model="newUser.username" placeholder="Логин" required />
        <input v-model="newUser.password" type="password" placeholder="Пароль" required />
        <select v-model="newUser.role">
          <option value="user">Пользователь</option>
          <option value="admin">Администратор</option>
        </select>
        <button class="btn btn--primary" type="submit">Создать</button>
      </form>

      <table class="table">
        <thead>
          <tr>
            <th>Логин</th>
            <th>Роль</th>
            <th>Доступ к проектам</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="user in users" :key="user.id">
            <td>{{ user.username }}</td>
            <td>
              <span class="tag" :class="{ 'tag--admin': user.role === 'admin' }">
                {{ user.role === 'admin' ? 'администратор' : 'пользователь' }}
              </span>
            </td>
            <td>
              <span v-if="user.role === 'admin'" class="muted">все проекты</span>
              <div v-else class="access">
                <label v-for="project in projects" :key="project.id" class="access__item">
                  <input
                    type="checkbox"
                    :checked="user.allowed_project_ids.includes(project.id)"
                    @change="onAccessToggle($event, user, project.id)"
                  />
                  {{ project.name }}
                </label>
              </div>
            </td>
            <td class="table__actions">
              <button class="btn btn--tiny" type="button" @click="resetPassword(user)">
                Сменить пароль
              </button>
              <button
                v-if="user.id !== auth.user?.id"
                class="btn btn--tiny btn--danger"
                type="button"
                @click="deleteUser(user)"
              >
                Удалить
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<style scoped>
.admin {
  max-width: 1040px;
  margin: 0 auto;
  padding: 28px 20px 60px;
}

.admin__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
  flex-wrap: wrap;
}

.admin__header h1 {
  margin: 0;
  font-size: 20px;
}

.admin__actions {
  display: flex;
  gap: 8px;
}

.admin__message {
  color: #3fb950;
}

.admin__error {
  color: #ff9f9a;
}

.card {
  padding: 18px;
  margin-bottom: 18px;
  border-radius: 10px;
  background: #0f141b;
  border: 1px solid #21262d;
}

.card h2 {
  margin: 0 0 14px;
  font-size: 15px;
}

.row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.table th,
.table td {
  padding: 8px 6px;
  text-align: left;
  border-bottom: 1px solid #21262d;
  vertical-align: top;
}

.table th {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #7d8590;
}

.table__actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.tag {
  display: inline-block;
  padding: 2px 7px;
  margin-right: 8px;
  border-radius: 10px;
  font-size: 11px;
  background: rgba(255, 255, 255, 0.07);
  color: #8b949e;
}

.tag--ok {
  background: rgba(63, 185, 80, 0.18);
  color: #56d364;
}

.tag--admin {
  background: rgba(47, 129, 247, 0.2);
  color: #58a6ff;
}

.upload {
  display: inline-block;
  cursor: pointer;
  font-size: 12px;
  color: #58a6ff;
}

.upload input {
  display: none;
}

.access {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.access__item {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
}

.muted {
  color: #7d8590;
  font-size: 12px;
}
</style>
