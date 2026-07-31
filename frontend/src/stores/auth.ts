import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { api, getToken, setToken } from '@/api/client'
import type { User } from '@/api/types'

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  const isAuthenticated = computed(() => user.value !== null)
  const isAdmin = computed(() => user.value?.role === 'admin')
  /**
   * Может ли пользователь менять данные.
   *
   * Роли «Читатель» интерфейс не показывает кнопок изменения; это удобство,
   * а не защита — запрет обеспечивает бэкенд (deps.deny_reader_writes).
   * Пока профиль не загружен, право не выдаётся: иначе на долю секунды
   * читателю мигали бы кнопки, которые тут же исчезают.
   */
  const canEdit = computed(() => user.value !== null && user.value.role !== 'reader')
  const isReader = computed(() => user.value?.role === 'reader')

  async function login(username: string, password: string): Promise<boolean> {
    loading.value = true
    error.value = null
    try {
      const response = await api.login(username, password)
      setToken(response.access_token)
      user.value = response.user
      return true
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Не удалось войти'
      return false
    } finally {
      loading.value = false
    }
  }

  /** Восстановление сессии по сохранённому токену при перезагрузке страницы. */
  async function restore(): Promise<boolean> {
    if (!getToken()) return false
    try {
      user.value = await api.me()
      return true
    } catch {
      setToken(null)
      user.value = null
      return false
    }
  }

  function logout(): void {
    setToken(null)
    user.value = null
  }

  return {
    user,
    loading,
    error,
    isAuthenticated,
    isAdmin,
    canEdit,
    isReader,
    login,
    restore,
    logout,
  }
})
