/** Типы, зеркалящие Pydantic-схемы бэкенда (backend/app/schemas.py). */

export type UserRole = 'admin' | 'user'
export type TaskStatus = 'todo' | 'in_progress' | 'done'

export interface User {
  id: number
  username: string
  role: UserRole
  allowed_project_ids: number[]
  created_at: string
}

export interface TokenResponse {
  access_token: string
  token_type: string
  user: User
}

export interface Project {
  id: number
  name: string
  model_url: string | null
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
  created_at: string
}

export interface Problem {
  id: number
  name: string
  definition: string
  is_resolved: boolean
  created_at: string
}

/** Готовая сводка сектора — бэкенд считает всё сам (п. 5.1 ТЗ). */
export interface SectorSummary {
  id: number
  project_id: number
  name: string
  /** Массив опорных точек [[x, y, z], ...] в координатах модели. */
  coordinates: number[][]
  progress_percent: number
  brigade: Brigade | null
  tasks: Task[]
  problems: Problem[]
  in_progress_task_ids: number[]
  tasks_total: number
  tasks_done: number
  open_problems: number
}

export interface ProjectSnapshot {
  project: Project
  brigades: BrigadeWithAssignment[]
  sectors: SectorSummary[]
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
  project_id: number
  payload: unknown
}
