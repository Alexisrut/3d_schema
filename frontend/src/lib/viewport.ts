/**
 * Определение мобильного экрана.
 *
 * Одно место на всё приложение: раскладка вида, панели-шторки и подсказки
 * должны переключаться синхронно, а не каждая по своему условию.
 *
 * Порог намеренно завязан на ШИРИНУ, а не на «это телефон»: на планшете в
 * альбомной ориентации колонки помещаются и полезны, а в портретной — нет.
 * Проверять User-Agent бессмысленно: он ничего не говорит о доступном месте.
 */
import { ref, readonly } from 'vue'

/** Ширина, ниже которой боковые колонки не помещаются рядом со сценой. */
export const MOBILE_MAX_WIDTH = 900

/** Чистая проверка порога — вынесена ради тестов, без обращения к DOM. */
export function isMobileWidth(width: number): boolean {
  if (!Number.isFinite(width) || width <= 0) return false
  return width <= MOBILE_MAX_WIDTH
}

const mobile = ref(false)
let initialised = false

function setup(): void {
  if (initialised || typeof window === 'undefined' || !window.matchMedia) return
  initialised = true

  const query = window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`)
  mobile.value = query.matches

  const apply = (event: MediaQueryList | MediaQueryListEvent) => {
    mobile.value = event.matches
  }
  // Слушатель живёт столько же, сколько вкладка: раскладка нужна всему
  // приложению, поэтому подписку не считаем по компонентам — она одна.
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', apply)
  } else {
    // Safari младше 14 — там только устаревший addListener.
    ;(query as unknown as { addListener: (cb: (e: MediaQueryListEvent) => void) => void })
      .addListener(apply)
  }
}

/** Реактивный признак «узкий экран». */
export function useViewport(): { isMobile: Readonly<typeof mobile> } {
  setup()
  return { isMobile: readonly(mobile) as unknown as typeof mobile }
}
