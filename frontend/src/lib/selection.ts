/**
 * Правила мультивыделения и прозрачности — чистые функции без Vue.
 *
 * Выделение зон и бригад ведётся одинаково (обычный клик, Ctrl/Cmd, Shift),
 * поэтому логика живёт в одном месте и покрыта тестами: воспроизводить
 * диапазонный выбор мышью в браузере ради регрессии слишком дорого.
 */

/** Как клик меняет выделение. */
export type SelectMode =
  /** Обычный клик: оставить только эту строку, а повторный — снять выбор. */
  | 'replace'
  /** Ctrl/Cmd: добавить или убрать одну строку. */
  | 'toggle'
  /** Shift: выбрать всё от точки опоры до этой строки. */
  | 'range'

/** Прозрачность объекта: обычный вид → полупрозрачный → скрытый. */
export type Visibility = 'normal' | 'ghost' | 'hidden'

export const VISIBILITY_CYCLE: Visibility[] = ['normal', 'ghost', 'hidden']

export interface SelectionState {
  ids: number[]
  /** Строка, от которой Shift отсчитывает диапазон. */
  anchor: number | null
}

export const EMPTY_SELECTION: SelectionState = { ids: [], anchor: null }

/** Модификаторы клавиатуры → режим выделения. */
export function modeFromEvent(event: {
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
}): SelectMode {
  if (event.shiftKey) return 'range'
  // metaKey — Cmd на macOS: там Ctrl+клик система отдаёт как контекстное меню.
  if (event.ctrlKey || event.metaKey) return 'toggle'
  return 'replace'
}

/**
 * Применить клик к выделению.
 *
 * `order` — порядок строк на экране; по нему Shift набирает диапазон.
 * Порядок самого выделения сохраняется в порядке добавления: он виден
 * пользователю в списке «Выбрано».
 *
 * Обычный клик по ЕДИНСТВЕННОЙ выбранной строке снимает выбор — так же, как
 * в панели этажей. Без этого выделение нечем было сбросить, кроме клика по
 * пустому месту сцены, которого в списках просто нет.
 *
 * Условие именно «ровно эта одна»: если выбрано несколько строк, обычный
 * клик по одной из них обязан свести выбор к ней, а не обнулить всё.
 */
export function applySelection(
  current: SelectionState,
  id: number,
  mode: SelectMode,
  order: number[] = [],
): SelectionState {
  if (mode === 'toggle') {
    return current.ids.includes(id)
      ? { ids: current.ids.filter((x) => x !== id), anchor: id }
      : { ids: [...current.ids, id], anchor: id }
  }

  if (mode === 'range') {
    const from = order.indexOf(current.anchor ?? id)
    const to = order.indexOf(id)
    // Точка опоры могла исчезнуть (зону удалили) — тогда Shift ведёт себя
    // как обычный клик, а не выделяет случайный кусок списка.
    if (from === -1 || to === -1) return { ids: [id], anchor: id }
    const [start, end] = from <= to ? [from, to] : [to, from]
    // Опора не переносится: серия Shift-кликов расширяет диапазон от одной
    // и той же строки, как в файловых менеджерах.
    return { ids: order.slice(start, end + 1), anchor: current.anchor ?? id }
  }

  if (current.ids.length === 1 && current.ids[0] === id) return { ...EMPTY_SELECTION }
  return { ids: [id], anchor: id }
}

/** Убрать из выделения то, чего больше нет (зону удалили, бригаду расформировали). */
export function pruneSelection(current: SelectionState, alive: number[]): SelectionState {
  const set = new Set(alive)
  const ids = current.ids.filter((id) => set.has(id))
  if (ids.length === current.ids.length && (current.anchor === null || set.has(current.anchor))) {
    return current
  }
  return { ids, anchor: current.anchor !== null && set.has(current.anchor) ? current.anchor : null }
}

/** Следующее состояние прозрачности по кругу. */
export function nextVisibility(current: Visibility | undefined): Visibility {
  const index = VISIBILITY_CYCLE.indexOf(current ?? 'normal')
  return VISIBILITY_CYCLE[(index + 1) % VISIBILITY_CYCLE.length]
}

/**
 * Общее следующее состояние для группы объектов.
 *
 * Если объекты в разных состояниях, первое нажатие приводит их к одному —
 * иначе кнопка «прозрачность» на смешанном выделении работала бы как
 * рассинхронизация: часть зон гасла, часть проявлялась.
 */
export function nextVisibilityForGroup(
  ids: number[],
  map: Record<number, Visibility | undefined>,
): Visibility {
  const states = ids.map((id) => map[id] ?? 'normal')
  const first = states[0] ?? 'normal'
  const uniform = states.every((state) => state === first)
  return uniform ? nextVisibility(first) : 'ghost'
}

/** Видимые (не скрытые) объекты из набора. */
export function isHidden(id: number, map: Record<number, Visibility | undefined>): boolean {
  return (map[id] ?? 'normal') === 'hidden'
}

export function isGhost(id: number, map: Record<number, Visibility | undefined>): boolean {
  return (map[id] ?? 'normal') === 'ghost'
}
