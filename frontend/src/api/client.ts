/** Тонкий HTTP-клиент над fetch: подставляет JWT и разворачивает ошибки FastAPI. */
import type {
  Brigade,
  BrigadeWithAssignment,
  Problem,
  Project,
  ProjectSnapshot,
  SectorSummary,
  TaskStatus,
  TokenResponse,
  User,
  UserRole,
} from './types'

const TOKEN_KEY = 'monitoring.token'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token)
  else localStorage.removeItem(TOKEN_KEY)
}

/**
 * URL модели с токеном в query-строке.
 *
 * GLTFLoader в three.js грузит файл сам и не умеет добавлять заголовок
 * Authorization, а бэкенд отдаёт .glb только авторизованным — поэтому здесь
 * единственное место, где токен идёт параметром.
 */
export function modelUrl(path: string | null): string | null {
  if (!path) return null
  const token = getToken()
  if (!token) return path
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}token=${encodeURIComponent(token)}`
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(path, { ...init, headers })

  if (response.status === 204) return undefined as T

  const text = await response.text()
  const data = text ? safeParse(text) : null

  if (!response.ok) {
    throw new ApiError(extractDetail(data) ?? `Ошибка ${response.status}`, response.status)
  }
  return data as T
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function extractDetail(data: unknown): string | null {
  if (typeof data === 'string') return data
  if (data && typeof data === 'object' && 'detail' in data) {
    const detail = (data as { detail: unknown }).detail
    if (typeof detail === 'string') return detail
    if (Array.isArray(detail)) {
      return detail
        .map((item) =>
          item && typeof item === 'object' && 'msg' in item
            ? String((item as { msg: unknown }).msg)
            : String(item),
        )
        .join('; ')
    }
  }
  return null
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) })

export const api = {
  // ---------------------------------------------------------------- auth
  login: (username: string, password: string) =>
    request<TokenResponse>('/api/auth/login', { method: 'POST', ...json({ username, password }) }),

  me: () => request<User>('/api/auth/me'),

  // --------------------------------------------------------------- users
  listUsers: () => request<User[]>('/api/users'),

  createUser: (payload: {
    username: string
    password: string
    role: UserRole
    allowed_project_ids: number[]
  }) => request<User>('/api/users', { method: 'POST', ...json(payload) }),

  updateUser: (
    id: number,
    payload: Partial<{ password: string; role: UserRole; allowed_project_ids: number[] }>,
  ) => request<User>(`/api/users/${id}`, { method: 'PATCH', ...json(payload) }),

  deleteUser: (id: number) => request<void>(`/api/users/${id}`, { method: 'DELETE' }),

  // ------------------------------------------------------------ projects
  listProjects: () => request<Project[]>('/api/projects'),

  createProject: (name: string) =>
    request<Project>('/api/projects', { method: 'POST', ...json({ name }) }),

  deleteProject: (id: number) => request<void>(`/api/projects/${id}`, { method: 'DELETE' }),

  uploadModel: (projectId: number, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<Project>(`/api/projects/${projectId}/model`, { method: 'POST', body: form })
  },

  snapshot: (projectId: number) =>
    request<ProjectSnapshot>(`/api/projects/${projectId}/snapshot`),

  // ------------------------------------------------------------ brigades
  listBrigades: (projectId: number) =>
    request<BrigadeWithAssignment[]>(`/api/projects/${projectId}/brigades`),

  createBrigade: (projectId: number, payload: Omit<Brigade, 'id' | 'project_id'>) =>
    request<BrigadeWithAssignment>(`/api/projects/${projectId}/brigades`, {
      method: 'POST',
      ...json(payload),
    }),

  deleteBrigade: (projectId: number, brigadeId: number) =>
    request<void>(`/api/projects/${projectId}/brigades/${brigadeId}`, { method: 'DELETE' }),

  // ------------------------------------------------------------- sectors
  createSector: (projectId: number, payload: { name: string; coordinates: number[][] }) =>
    request<SectorSummary>(`/api/projects/${projectId}/sectors`, {
      method: 'POST',
      ...json(payload),
    }),

  updateSector: (projectId: number, sectorId: number, payload: { name?: string }) =>
    request<SectorSummary>(`/api/projects/${projectId}/sectors/${sectorId}`, {
      method: 'PATCH',
      ...json(payload),
    }),

  deleteSector: (projectId: number, sectorId: number) =>
    request<void>(`/api/projects/${projectId}/sectors/${sectorId}`, { method: 'DELETE' }),

  assignBrigade: (projectId: number, sectorId: number, brigadeId: number | null) =>
    request<SectorSummary>(`/api/projects/${projectId}/sectors/${sectorId}/brigade`, {
      method: 'PUT',
      ...json({ brigade_id: brigadeId }),
    }),

  // --------------------------------------------------------------- tasks
  addTask: (
    projectId: number,
    sectorId: number,
    payload: { name: string; definition: string; status: TaskStatus; progress: number },
  ) =>
    request<SectorSummary>(`/api/projects/${projectId}/sectors/${sectorId}/tasks`, {
      method: 'POST',
      ...json(payload),
    }),

  updateTask: (
    projectId: number,
    sectorId: number,
    taskId: number,
    payload: Partial<{ name: string; definition: string; status: TaskStatus; progress: number }>,
  ) =>
    request<SectorSummary>(`/api/projects/${projectId}/sectors/${sectorId}/tasks/${taskId}`, {
      method: 'PATCH',
      ...json(payload),
    }),

  deleteTask: (projectId: number, sectorId: number, taskId: number) =>
    request<SectorSummary>(`/api/projects/${projectId}/sectors/${sectorId}/tasks/${taskId}`, {
      method: 'DELETE',
    }),

  // ------------------------------------------------------------ problems
  addProblem: (
    projectId: number,
    sectorId: number,
    payload: { name: string; definition: string; is_resolved: boolean },
  ) =>
    request<SectorSummary>(`/api/projects/${projectId}/sectors/${sectorId}/problems`, {
      method: 'POST',
      ...json(payload),
    }),

  updateProblem: (
    projectId: number,
    sectorId: number,
    problemId: number,
    payload: Partial<Pick<Problem, 'name' | 'definition' | 'is_resolved'>>,
  ) =>
    request<SectorSummary>(
      `/api/projects/${projectId}/sectors/${sectorId}/problems/${problemId}`,
      { method: 'PATCH', ...json(payload) },
    ),

  deleteProblem: (projectId: number, sectorId: number, problemId: number) =>
    request<SectorSummary>(
      `/api/projects/${projectId}/sectors/${sectorId}/problems/${problemId}`,
      { method: 'DELETE' },
    ),
}
