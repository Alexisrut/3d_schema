/**
 * Таймер активности карточки: сколько времени прошло с её создания.
 *
 * Формат — часы и минуты, как просили: на стройке важно «висит третий час»,
 * а не «02:47:13». Секунды не показываем и не пересчитываем каждую секунду —
 * это дало бы перерисовку всего списка карточек раз в секунду без пользы.
 */
import { onScopeDispose, ref, readonly, type Ref } from 'vue'

/** Как часто обновляется отсчёт. Минута — шаг младшего разряда. */
export const TICK_MS = 30_000

/**
 * Разобрать метку времени из API.
 *
 * SQLite отдаёт время без зоны («2026-07-31T13:10:10.831472»), и браузер
 * трактует такую строку как ЛОКАЛЬНУЮ. Бэкенд же пишет UTC — без явного
 * суффикса таймер уходил бы на величину часового пояса, а у пользователей
 * восточнее Гринвича показывал бы отрицательное время.
 */
export function parseServerTime(value: string): number {
  if (!value) return Number.NaN
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value)
  return Date.parse(hasZone ? value : `${value}Z`)
}

/**
 * «сколько прошло» в виде «3 ч 05 мин».
 *
 * Отрицательная разница (часы на клиенте отстают от сервера) показывается
 * как ноль: «-2 мин назад» выглядит поломкой, а не расхождением часов.
 */
export function formatElapsed(createdAt: string, now: number): string {
  const started = parseServerTime(createdAt)
  if (!Number.isFinite(started)) return '—'

  const minutesTotal = Math.max(0, Math.floor((now - started) / 60_000))
  const hours = Math.floor(minutesTotal / 60)
  const minutes = minutesTotal % 60

  if (hours === 0) return `${minutes} мин`
  return `${hours} ч ${String(minutes).padStart(2, '0')} мин`
}

/** Длинная подпись для title: точный момент создания. */
export function formatCreatedAt(createdAt: string): string {
  const stamp = parseServerTime(createdAt)
  if (!Number.isFinite(stamp)) return ''
  return new Date(stamp).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// --------------------------------------------------------------- общий тик
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
let subscribers = 0

/**
 * Общее «сейчас» для всех карточек.
 *
 * Один таймер на приложение, а не по одному на карточку: их на объекте
 * сотни, и сотня интервалов будила бы вкладку вразнобой.
 */
export function useNow(): Readonly<Ref<number>> {
  subscribers += 1
  if (timer === null) {
    now.value = Date.now()
    timer = setInterval(() => {
      now.value = Date.now()
    }, TICK_MS)
  }

  onScopeDispose(() => {
    subscribers -= 1
    if (subscribers <= 0 && timer !== null) {
      clearInterval(timer)
      timer = null
      subscribers = 0
    }
  })

  return readonly(now)
}
