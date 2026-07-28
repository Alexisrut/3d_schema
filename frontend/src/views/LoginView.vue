<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const router = useRouter()
const route = useRoute()

const username = ref('')
const password = ref('')

async function submit(): Promise<void> {
  const ok = await auth.login(username.value.trim(), password.value)
  if (!ok) return
  const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : null
  await router.replace(redirect ?? { name: 'projects' })
}
</script>

<template>
  <div class="login">
    <form class="login__card" @submit.prevent="submit">
      <h1>3D-мониторинг строительства</h1>
      <p class="login__subtitle">Внутренняя платформа контроля хода работ</p>

      <label>
        Логин
        <input v-model="username" autocomplete="username" required />
      </label>

      <label>
        Пароль
        <input v-model="password" type="password" autocomplete="current-password" required />
      </label>

      <p v-if="auth.error" class="login__error">{{ auth.error }}</p>

      <button class="btn btn--primary" type="submit" :disabled="auth.loading">
        {{ auth.loading ? 'Вход…' : 'Войти' }}
      </button>
    </form>
  </div>
</template>

<style scoped>
.login {
  display: grid;
  place-items: center;
  min-height: 100vh;
  padding: 20px;
}

.login__card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  max-width: 360px;
  padding: 26px;
  border-radius: 12px;
  background: #0f141b;
  border: 1px solid #21262d;
}

.login__card h1 {
  margin: 0;
  font-size: 19px;
}

.login__subtitle {
  margin: 0 0 6px;
  font-size: 12px;
  color: #7d8590;
}

.login__card label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 12px;
  color: #8b949e;
}

.login__error {
  margin: 0;
  font-size: 12px;
  color: #ff9f9a;
}
</style>
