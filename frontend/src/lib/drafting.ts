/**
 * Двухэтапная разметка зоны и её собственная отмена.
 *
 * Шаг 1 («polygon») — пользователь кликами по модели обводит площадь.
 * Шаг 2 («extrude») — вытягивает обведённый контур вверх, задавая объём.
 *
 * Модуль намеренно чистый (без Vue и без сети): именно здесь живёт правило
 * «Шаг назад отменяет РОВНО одно последнее атомарное действие», и его надо
 * покрывать тестами. Прежняя реализация держала точки разметки в общем стеке
 * отмены и при выходе из режима вычищала оттуда все записи о точках сразу —
 * из-за этого «последним» действием оказывалось не то, что сделал
 * пользователь, а кнопка молча срабатывала впустую.
 */

export type DraftStage = 'idle' | 'polygon' | 'extrude'

export interface DraftState {
  stage: DraftStage
  /** Опорные точки основания в координатах модели. */
  points: number[][]
  /** Высота выдавливания, м. Осмысленна только на шаге «extrude». */
  height: number
}

/** Что именно отменил `undoDraft` — нужно, чтобы показать это пользователю. */
export type DraftUndoKind = 'point' | 'extrude' | null

/** Высота этажа по умолчанию: с неё начинается шаг выдавливания. */
export const DEFAULT_EXTRUDE_HEIGHT = 3
/** Тот же предел, что и на бэкенде (schemas.MAX_SECTOR_HEIGHT). */
export const MAX_EXTRUDE_HEIGHT = 500
/** Минимум опорных точек для замкнутой площади. */
export const MIN_POINTS = 3

export const EMPTY_DRAFT: DraftState = { stage: 'idle', points: [], height: 0 }

export function startDraft(): DraftState {
  return { stage: 'polygon', points: [], height: 0 }
}

export function cancelDraft(): DraftState {
  return { ...EMPTY_DRAFT }
}

export function isDrafting(draft: DraftState): boolean {
  return draft.stage !== 'idle'
}

export function addDraftPoint(draft: DraftState, point: number[]): DraftState {
  // Точки принимаются только на первом шаге: после перехода к выдавливанию
  // клик по модели не должен втихую менять уже обведённый контур.
  if (draft.stage !== 'polygon') return draft
  return { ...draft, points: [...draft.points, point] }
}

export function canBeginExtrude(draft: DraftState): boolean {
  return draft.stage === 'polygon' && draft.points.length >= MIN_POINTS
}

export function beginExtrude(
  draft: DraftState,
  height = DEFAULT_EXTRUDE_HEIGHT,
): DraftState {
  if (!canBeginExtrude(draft)) return draft
  return { ...draft, stage: 'extrude', height: clampHeight(height) }
}

export function setDraftHeight(draft: DraftState, height: number): DraftState {
  if (draft.stage !== 'extrude') return draft
  return { ...draft, height: clampHeight(height) }
}

export function clampHeight(height: number): number {
  if (!Number.isFinite(height)) return 0
  return Math.min(MAX_EXTRUDE_HEIGHT, Math.max(0, height))
}

/** Готова ли зона к отправке на сервер. */
export function canCommitDraft(draft: DraftState): boolean {
  return isDrafting(draft) && draft.points.length >= MIN_POINTS
}

/** Есть ли в черновике что отменять — от этого зависит доступность кнопки. */
export function draftHasUndo(draft: DraftState): boolean {
  if (draft.stage === 'extrude') return true
  return draft.stage === 'polygon' && draft.points.length > 0
}

/**
 * Отменить ОДНО последнее действие внутри черновика.
 *
 * Порядок обратен порядку действий пользователя: сначала откатывается
 * выдавливание (возврат к плоскому контуру), и только потом — по одной
 * точке. Если отменять в черновике нечего, возвращается undone: null,
 * и вызывающий код переходит к стеку отменяемых действий сцены.
 */
export function undoDraft(draft: DraftState): { draft: DraftState; undone: DraftUndoKind } {
  if (draft.stage === 'extrude') {
    return { draft: { ...draft, stage: 'polygon', height: 0 }, undone: 'extrude' }
  }
  if (draft.stage === 'polygon' && draft.points.length > 0) {
    return { draft: { ...draft, points: draft.points.slice(0, -1) }, undone: 'point' }
  }
  return { draft, undone: null }
}
