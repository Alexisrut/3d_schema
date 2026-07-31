<script setup lang="ts">
/**
 * Личный кабинет: смена пароля и привязка почты с подтверждением.
 *
 * Доступен всем ролям, включая «Читателя»: это управление своей учётной
 * записью, а не данными объекта. Отсюда же администратор попадает в раздел
 * администрирования — отдельной кнопки в шапках больше нет.
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { api } from '@/api/client'
import { ROLE_LABEL, type Account } from '@/api/types'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()

const account = ref<Account | null>(null)
const message = ref<string | null>(null)
const error = ref<string | null>(null)
const busy = ref(false)

// Смена пароля
const currentPassword = ref('')
const newPassword = ref('')
const repeatPassword = ref('')

// Почта
const emailInput = ref('')
const code = ref('')
/** Код запрошен — показываем поле подтверждения. */
const codeRequested = ref(false)

const verified = computed(() => account.value?.email_verified === true)
const roleLabel = computed(() =>
  account.value ? ROLE_LABEL[account.value.role] ?? account.value.role : '',
)

const passwordsMatch = computed(
  () => newPassword.value.length > 0 && newPassword.value === repeatPassword.value,
)
const canSubmitPassword = computed(
  () => !busy.value && currentPassword.value.length > 0 && newPassword.value.length >= 6 && passwordsMatch.value,
)

onMounted(reload)

async function reload(): Promise<void> {
  try {
    account.value = await api.account()
    emailInput.value = account.value.email ?? ''
    // Если почта привязана, но не подтверждена, поле кода нужно сразу.
    codeRequested.value = Boolean(account.value.email) && !account.value.email_verified
  } catch (e) {
    fail(e)
  }
}

function notify(text: string): void {
  message.value = text
  error.value = null
  window.setTimeout(() => {
    if (message.value === text) message.value = null
  }, 4000)
}

function fail(e: unknown): void {
  error.value = e instanceof Error ? e.message : 'Операция не выполнена'
  message.value = null
}

async function submitPassword(): Promise<void> {
  if (!canSubmitPassword.value) return
  busy.value = true
  try {
    account.value = await api.changePassword(currentPassword.value, newPassword.value)
    currentPassword.value = ''
    newPassword.value = ''
    repeatPassword.value = ''
    notify('Пароль изменён')
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

async function submitEmail(): Promise<void> {
  const address = emailInput.value.trim()
  if (!address) return
  busy.value = true
  try {
    const report = await api.bindEmail(address)
    codeRequested.value = true
    code.value = ''
    await reload()
    if (report.skipped) {
      notify(
        'Почта сохранена. Отправка писем не настроена — код записан в журнал сервера.',
      )
    } else if (report.error) {
      error.value = `Код не отправлен: ${report.error}`
    } else {
      notify(`Код отправлен на ${address}. Он действует 30 минут.`)
    }
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

async function submitCode(): Promise<void> {
  const value = code.value.trim()
  if (!value) return
  busy.value = true
  try {
    account.value = await api.confirmEmail(value)
    codeRequested.value = false
    code.value = ''
    notify('Почта подтверждена — теперь вам можно направлять уведомления')
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

async function unbind(): Promise<void> {
  if (!window.confirm('Отвязать почту? Вы перестанете получать уведомления.')) return
  busy.value = true
  try {
    account.value = await api.unbindEmail()
    emailInput.value = ''
    codeRequested.value = false
    notify('Почта отвязана')
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

function logout(): void {
  auth.logout()
  void router.push({ name: 'login' })
}
</script>

<template>
  <div class="account">
    <header class="account__header">
      <h1>Личный кабинет</h1>
      <div class="account__actions">
        <button class="btn" type="button" @click="router.push({ name: 'projects' })">
          К проектам
        </button>
        <button class="btn btn--ghost" type="button" @click="logout">Выйти</button>
      </div>
    </header>

    <p v-if="message" class="account__message">{{ message }}</p>
    <p v-if="error" class="account__error">{{ error }}</p>

    <!-- ------------------------------------------------------- профиль -->
    <section class="card">
      <h2>Профиль</h2>
      <div class="rows">
        <div class="row">
          <span class="row__label">Логин</span>
          <strong>{{ account?.username ?? '—' }}</strong>
        </div>
        <div class="row">
          <span class="row__label">Роль</span>
          <strong>{{ roleLabel || '—' }}</strong>
        </div>
        <div class="row">
          <span class="row__label">Почта</span>
          <strong v-if="account?.email">
            {{ account.email }}
            <span v-if="verified" class="tag tag--ok">подтверждена</span>
            <span v-else class="tag tag--warn">не подтверждена</span>
          </strong>
          <strong v-else class="muted">не привязана</strong>
        </div>
      </div>

      <!-- Администрирование доступно отсюда: отдельной кнопки в шапках нет -->
      <button
        v-if="auth.isAdmin"
        class="btn"
        type="button"
        @click="router.push({ name: 'admin' })"
      >
        Раздел администрирования
      </button>
    </section>

    <!-- -------------------------------------------------- смена пароля -->
    <section class="card">
      <h2>Смена пароля</h2>
      <form class="form" @submit.prevent="submitPassword">
        <label class="field">
          <span>Текущий пароль</span>
          <input v-model="currentPassword" type="password" autocomplete="current-password" required />
        </label>
        <label class="field">
          <span>Новый пароль</span>
          <input
            v-model="newPassword"
            type="password"
            minlength="6"
            autocomplete="new-password"
            required
          />
        </label>
        <label class="field">
          <span>Повторите новый пароль</span>
          <input v-model="repeatPassword" type="password" autocomplete="new-password" required />
        </label>

        <p v-if="repeatPassword && !passwordsMatch" class="hint hint--error">
          Пароли не совпадают.
        </p>
        <p v-else class="hint">Не короче 6 символов.</p>

        <button class="btn btn--primary" type="submit" :disabled="!canSubmitPassword">
          Сменить пароль
        </button>
      </form>
    </section>

    <!-- ---------------------------------------------------------- почта -->
    <section class="card">
      <h2>Почта для уведомлений</h2>
      <p class="hint">
        Письма о задачах и проблемах приходят только на подтверждённый адрес.
        Пока почта не подтверждена, вас нельзя выбрать адресатом.
      </p>

      <form class="form" @submit.prevent="submitEmail">
        <label class="field">
          <span>Адрес</span>
          <input v-model="emailInput" type="email" placeholder="name@example.com" required />
        </label>
        <div class="form__actions">
          <button class="btn btn--primary" type="submit" :disabled="busy">
            {{ verified ? 'Изменить адрес' : 'Отправить код' }}
          </button>
          <button
            v-if="account?.email"
            class="btn btn--danger"
            type="button"
            :disabled="busy"
            @click="unbind"
          >
            Отвязать
          </button>
        </div>
      </form>

      <form v-if="codeRequested && !verified" class="form form--code" @submit.prevent="submitCode">
        <label class="field">
          <span>Код из письма</span>
          <input
            v-model="code"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="12"
            placeholder="6 цифр"
            required
          />
        </label>
        <button class="btn btn--primary" type="submit" :disabled="busy">Подтвердить</button>
      </form>
    </section>
  </div>
</template>

<style scoped>
.account {
  max-width: 720px;
  margin: 0 auto;
  padding: 28px 20px 60px;
}

.account__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
  flex-wrap: wrap;
}

.account__header h1 {
  margin: 0;
  font-size: 20px;
}

.account__actions {
  display: flex;
  gap: 8px;
}

.account__message {
  color: #3fb950;
}

.account__error {
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

.rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
}

.row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}

.row__label {
  color: #8b949e;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 380px;
}

.form--code {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid #21262d;
}

.form__actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #8b949e;
}

.hint {
  margin: 0;
  font-size: 12px;
  color: #7d8590;
  line-height: 1.45;
}

.hint--error {
  color: #ff9f9a;
}

.tag {
  display: inline-block;
  margin-left: 6px;
  padding: 2px 7px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 400;
}

.tag--ok {
  background: rgba(63, 185, 80, 0.18);
  color: #56d364;
}

.tag--warn {
  background: rgba(255, 200, 87, 0.18);
  color: #ffd88a;
}

.muted {
  color: #7d8590;
  font-weight: 400;
}

@media (max-width: 900px) {
  .account {
    padding: 16px 12px 40px;
  }

  .form {
    max-width: none;
  }
}
</style>
