/** Тонкий HTTP-клиент над fetch: подставляет JWT и разворачивает ошибки FastAPI. */
import type {
  Account,
  Attachment,
  Brigade,
  BrigadeWithAssignment,
  BulkDeleteResult,
  BulkSectorsResult,
  CardKind,
  Level,
  MailReport,
  NotifyRecipient,
  Problem,
  Project,
  ProjectModel,
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

/**
 * Ссылка на вложение с токеном.
 *
 * Файл открывается обычным переходом браузера — заголовок Authorization туда
 * не подставить, поэтому здесь тот же приём, что и для .glb.
 */
export const attachmentUrl = modelUrl

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

/**
 * Имя файла из заголовка Content-Disposition.
 *
 * Предпочитаем `filename*` (RFC 5987) — там кириллица; простой `filename`
 * сервер отдаёт латиницей для клиентов, которые расширение не понимают.
 */
function filenameFromDisposition(header: string | null): string {
  const fallback = 'export.xlsx'
  if (!header) return fallback
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (extended) {
    try {
      return decodeURIComponent(extended[1])
    } catch {
      /* битая кодировка — используем простое имя ниже */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header)
  return plain ? plain[1] : fallback
}

export const api = {
  // ---------------------------------------------------------------- auth
  login: (username: string, password: string) =>
    request<TokenResponse>('/api/auth/login', { method: 'POST', ...json({ username, password }) }),

  me: () => request<User>('/api/auth/me'),

  // ------------------------------------------------------ личный кабинет
  account: () => request<Account>('/api/account'),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<Account>('/api/account/password', {
      method: 'POST',
      ...json({ current_password: currentPassword, new_password: newPassword }),
    }),

  /** Привязать почту и получить на неё код подтверждения. */
  bindEmail: (email: string) =>
    request<MailReport>('/api/account/email', { method: 'POST', ...json({ email }) }),

  confirmEmail: (code: string) =>
    request<Account>('/api/account/email/confirm', { method: 'POST', ...json({ code }) }),

  unbindEmail: () => request<Account>('/api/account/email', { method: 'DELETE' }),

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

  snapshot: (projectId: number) =>
    request<ProjectSnapshot>(`/api/projects/${projectId}/snapshot`),

  // ---------------------------------------------------------- слои моделей
  listModels: (projectId: number) =>
    request<ProjectModel[]>(`/api/projects/${projectId}/models`),

  /** Каждая загрузка добавляет слой и не затрагивает уже загруженные. */
  uploadModel: (projectId: number, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<ProjectModel>(`/api/projects/${projectId}/models`, {
      method: 'POST',
      body: form,
    })
  },

  renameModel: (projectId: number, modelId: number, name: string) =>
    request<ProjectModel>(`/api/projects/${projectId}/models/${modelId}`, {
      method: 'PATCH',
      ...json({ name }),
    }),

  deleteModel: (projectId: number, modelId: number) =>
    request<void>(`/api/projects/${projectId}/models/${modelId}`, { method: 'DELETE' }),

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

  deleteBrigades: (projectId: number, brigadeIds: number[]) =>
    request<BulkDeleteResult>(`/api/projects/${projectId}/brigades/bulk/delete`, {
      method: 'POST',
      ...json({ brigade_ids: brigadeIds }),
    }),

  // ------------------------------------------------------------- sectors
  createSector: (
    projectId: number,
    payload: {
      name: string
      coordinates: number[][]
      height?: number
      top_coordinates?: number[][] | null
      brigade_ids?: number[]
    },
  ) =>
    request<SectorSummary>(`/api/projects/${projectId}/sectors`, {
      method: 'POST',
      ...json(payload),
    }),

  updateSector: (
    projectId: number,
    sectorId: number,
    payload: {
      name?: string
      coordinates?: number[][]
      height?: number
      top_coordinates?: number[][] | null
    },
  ) =>
    request<SectorSummary>(`/api/projects/${projectId}/sectors/${sectorId}`, {
      method: 'PATCH',
      ...json(payload),
    }),

  deleteSector: (projectId: number, sectorId: number) =>
    request<void>(`/api/projects/${projectId}/sectors/${sectorId}`, { method: 'DELETE' }),

  deleteSectors: (projectId: number, sectorIds: number[]) =>
    request<BulkDeleteResult>(`/api/projects/${projectId}/sectors/bulk/delete`, {
      method: 'POST',
      ...json({ sector_ids: sectorIds }),
    }),

  // ------------------------------------------------------ бригады сектора
  /** Полная замена состава бригад: пустой список снимает все. */
  setBrigades: (projectId: number, sectorId: number, brigadeIds: number[]) =>
    request<SectorSummary>(`/api/projects/${projectId}/sectors/${sectorId}/brigades`, {
      method: 'PUT',
      ...json({ brigade_ids: brigadeIds }),
    }),

  /** Точечное добавление — сюда приходит drag-and-drop. */
  addBrigade: (projectId: number, sectorId: number, brigadeId: number) =>
    request<SectorSummary>(`/api/projects/${projectId}/sectors/${sectorId}/brigades`, {
      method: 'POST',
      ...json({ brigade_id: brigadeId }),
    }),

  removeBrigade: (projectId: number, sectorId: number, brigadeId: number) =>
    request<SectorSummary>(
      `/api/projects/${projectId}/sectors/${sectorId}/brigades/${brigadeId}`,
      { method: 'DELETE' },
    ),

  assignBrigadesBulk: (projectId: number, sectorIds: number[], brigadeIds: number[]) =>
    request<BulkSectorsResult>(`/api/projects/${projectId}/sectors/bulk/brigades`, {
      method: 'PUT',
      ...json({ sector_ids: sectorIds, brigade_ids: brigadeIds }),
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

  // -------------------------------------------------- вложения карточек
  listAttachments: (projectId: number, kind: CardKind, cardId: number) =>
    request<Attachment[]>(`/api/projects/${projectId}/cards/${kind}/${cardId}/attachments`),

  uploadAttachments: (projectId: number, kind: CardKind, cardId: number, files: File[]) => {
    const form = new FormData()
    // Поле называется files и повторяется — так FastAPI собирает список.
    for (const file of files) form.append('files', file)
    return request<Attachment[]>(
      `/api/projects/${projectId}/cards/${kind}/${cardId}/attachments`,
      { method: 'POST', body: form },
    )
  },

  deleteAttachment: (projectId: number, attachmentId: number) =>
    request<void>(`/api/projects/${projectId}/attachments/${attachmentId}`, {
      method: 'DELETE',
    }),

  // --------------------------------------------------- адресаты и письма
  listRecipients: (projectId: number) =>
    request<NotifyRecipient[]>(`/api/projects/${projectId}/recipients`),

  notifyAboutCard: (projectId: number, kind: CardKind, cardId: number, userIds: number[]) =>
    request<MailReport>(`/api/projects/${projectId}/cards/${kind}/${cardId}/notify`, {
      method: 'POST',
      ...json({ user_ids: userIds }),
    }),

  // ---------------------------------------------------------- уровни
  listLevels: (projectId: number) => request<Level[]>(`/api/projects/${projectId}/levels`),

  createLevel: (projectId: number, payload: { name: string; elevation: number }) =>
    request<Level>(`/api/projects/${projectId}/levels`, { method: 'POST', ...json(payload) }),

  updateLevel: (
    projectId: number,
    levelId: number,
    payload: { name?: string; elevation?: number },
  ) =>
    request<Level>(`/api/projects/${projectId}/levels/${levelId}`, {
      method: 'PATCH',
      ...json(payload),
    }),

  deleteLevel: (projectId: number, levelId: number) =>
    request<void>(`/api/projects/${projectId}/levels/${levelId}`, { method: 'DELETE' }),

  // ------------------------------------------------------ выгрузка Excel
  /**
   * Книга скачивается через fetch с заголовком авторизации, а не переходом по
   * ссылке: токен не должен попадать в историю браузера и логи прокси.
   */
  async downloadExport(projectId: number): Promise<{ blob: Blob; filename: string }> {
    const headers = new Headers()
    const token = getToken()
    if (token) headers.set('Authorization', `Bearer ${token}`)

    const response = await fetch(`/api/projects/${projectId}/export.xlsx`, { headers })
    if (!response.ok) {
      const text = await response.text()
      throw new ApiError(extractDetail(safeParse(text)) ?? 'Не удалось выгрузить файл', response.status)
    }
    return {
      blob: await response.blob(),
      filename: filenameFromDisposition(response.headers.get('Content-Disposition')),
    }
  },

  // ---------------------------------------------------- массовые действия
  /** Одна задача заводится в каждой из выбранных зон отдельной записью. */
  addTaskBulk: (
    projectId: number,
    sectorIds: number[],
    task: { name: string; definition: string; status: TaskStatus; progress: number },
  ) =>
    request<BulkSectorsResult>(`/api/projects/${projectId}/sectors/bulk/tasks`, {
      method: 'POST',
      ...json({ sector_ids: sectorIds, task }),
    }),

  addProblemBulk: (
    projectId: number,
    sectorIds: number[],
    problem: { name: string; definition: string; is_resolved: boolean },
  ) =>
    request<BulkSectorsResult>(`/api/projects/${projectId}/sectors/bulk/problems`, {
      method: 'POST',
      ...json({ sector_ids: sectorIds, problem }),
    }),
}
