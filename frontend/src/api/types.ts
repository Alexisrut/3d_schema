/** Типы, зеркалящие Pydantic-схемы бэкенда (backend/app/schemas.py). */

/**
 * `contractor` — основная рабочая роль (прежнее «user»),
 * `reader` — только чтение: камера, выбор объектов и карточки, без изменений.
 */
export type UserRole = 'admin' | 'contractor' | 'reader'
export type TaskStatus = 'todo' | 'in_progress' | 'done'

/** Подписи ролей — в одном месте, чтобы не расходились по экранам. */
export const ROLE_LABEL: Record<UserRole, string> = {
  admin: 'администратор',
  contractor: 'подрядчик',
  reader: 'читатель',
}

export interface User {
  id: number
  username: string
  role: UserRole
  allowed_project_ids: number[]
  created_at: string
  email?: string | null
  email_verified?: boolean
}

/** Профиль личного кабинета. */
export interface Account {
  id: number
  username: string
  role: UserRole
  email: string | null
  email_verified: boolean
  allowed_project_ids: number[]
  created_at: string
}

/** Файл, приложенный к карточке задачи или проблемы. */
export interface Attachment {
  id: number
  filename: string
  content_type: string
  size_bytes: number
  created_at: string
  /** Путь скачивания; токен подставляет `mediaUrl`. */
  url: string
}

/** Итог рассылки писем — показывается пользователю. */
export interface MailReport {
  sent: string[]
  failed: string[]
  skipped: boolean
  error: string | null
}

/** Пользователь с подтверждённой почтой — вариант в списке адресатов. */
export interface NotifyRecipient {
  id: number
  username: string
  email: string
}

/** Этаж (уровень) объекта — горизонтальная отметка по оси Y. */
export interface Level {
  id: number
  project_id: number
  name: string
  elevation: number
  created_at: string
}

/** Вид карточки для маршрутов вложений и рассылки. */
export type CardKind = 'task' | 'problem'

export interface TokenResponse {
  access_token: string
  token_type: string
  user: User
}

export interface Project {
  id: number
  name: string
  /** Первый слой моделей; полный список — в `ProjectSnapshot.models`. */
  model_url: string | null
  created_at: string
}

/** Один .glb-слой сцены — строка панели «Слои». */
export interface ProjectModel {
  id: number
  project_id: number
  name: string
  model_url: string
  sort_order: number
  created_at: string
}

export interface Brigade {
  id: number
  project_id: number
  name: string
  brigadir: string
  cnt_people: number
}

export interface BrigadeWithAssignment extends Brigade {
  assigned_sector_ids: number[]
}

export interface Task {
  id: number
  name: string
  definition: string
  status: TaskStatus
  progress: number
  /** От этого момента интерфейс считает таймер активности. */
  created_at: string
  attachments: Attachment[]
}

export interface Problem {
  id: number
  name: string
  definition: string
  is_resolved: boolean
  created_at: string
  attachments: Attachment[]
}

/** Готовая сводка сектора — бэкенд считает всё сам (п. 5.1 ТЗ). */
export interface SectorSummary {
  id: number
  project_id: number
  name: string
  /** Основание зоны: массив опорных точек [[x, y, z], ...] в координатах модели. */
  coordinates: number[][]
  /** Высота выдавливания основания вверх, в метрах. 0 — плоская зона. */
  height: number
  /** Правленая верхняя грань; null — верх повторяет основание. */
  top_coordinates: number[][] | null
  progress_percent: number
  /** Все бригады зоны: на одном секторе их может работать несколько. */
  brigades: Brigade[]
  tasks: Task[]
  problems: Problem[]
  in_progress_task_ids: number[]
  tasks_total: number
  tasks_done: number
  open_problems: number
}

export interface ProjectSnapshot {
  project: Project
  models: ProjectModel[]
  brigades: BrigadeWithAssignment[]
  sectors: SectorSummary[]
  levels: Level[]
}

/** Ответ массового действия: пересчитанные сводки всех затронутых зон. */
export interface BulkSectorsResult {
  sectors: SectorSummary[]
}

export interface BulkDeleteResult {
  deleted_ids: number[]
}

export interface RealtimeMessage {
  event:
    | 'connected'
    | 'sector.created'
    | 'sector.updated'
    | 'sector.deleted'
    | 'sector.brigade_changed'
    | 'brigade.created'
    | 'brigade.updated'
    | 'brigade.deleted'
    | 'project.model_updated'
    | 'project.models_changed'
    | 'levels.changed'
  project_id: number
  payload: unknown
}
