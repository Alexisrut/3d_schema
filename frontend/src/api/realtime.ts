/** WebSocket-подписка на проект с ping'ом и авто-переподключением.
 *
 * Если сокет недоступен (прокси, корпоративный firewall), автоматически
 * включается резервный polling — требование п. 5.2 ТЗ выполняется в обоих случаях.
 */
import { getToken } from './client'
import type { RealtimeMessage } from './types'

interface Handlers {
  onMessage: (message: RealtimeMessage) => void
  onStatus?: (connected: boolean) => void
}

const PING_INTERVAL = 25_000
const MAX_RECONNECT_DELAY = 15_000
const POLL_INTERVAL = 10_000

export function openProjectSocket(projectId: number, handlers: Handlers): () => void {
  let socket: WebSocket | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let attempt = 0
  let disposed = false

  const stopTimers = () => {
    if (pingTimer) clearInterval(pingTimer)
    if (pollTimer) clearInterval(pollTimer)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    pingTimer = pollTimer = null
    reconnectTimer = null
  }

  /** Резервный режим: раз в 10 с просим клиент перечитать сводку проекта. */
  const startPolling = () => {
    if (pollTimer) return
    pollTimer = setInterval(() => {
      handlers.onMessage({ event: 'sector.updated', project_id: projectId, payload: null })
    }, POLL_INTERVAL)
  }

  const stopPolling = () => {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
  }

  const connect = () => {
    if (disposed) return
    const token = getToken()
    if (!token) {
      startPolling()
      return
    }

    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${scheme}://${window.location.host}/ws/projects/${projectId}?token=${encodeURIComponent(token)}`

    try {
      socket = new WebSocket(url)
    } catch {
      startPolling()
      scheduleReconnect()
      return
    }

    socket.onopen = () => {
      attempt = 0
      stopPolling()
      handlers.onStatus?.(true)
      pingTimer = setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN) socket.send('ping')
      }, PING_INTERVAL)
    }

    socket.onmessage = (event) => {
      try {
        handlers.onMessage(JSON.parse(event.data as string) as RealtimeMessage)
      } catch {
        /* игнорируем нечитаемые кадры */
      }
    }

    socket.onerror = () => {
      /* закрытие обработаем в onclose */
    }

    socket.onclose = () => {
      handlers.onStatus?.(false)
      if (pingTimer) clearInterval(pingTimer)
      pingTimer = null
      socket = null
      if (disposed) return
      startPolling()
      scheduleReconnect()
    }
  }

  const scheduleReconnect = () => {
    if (disposed || reconnectTimer) return
    attempt += 1
    const delay = Math.min(1000 * 2 ** Math.min(attempt, 4), MAX_RECONNECT_DELAY)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  connect()

  return () => {
    disposed = true
    stopTimers()
    handlers.onStatus?.(false)
    if (socket) {
      socket.onclose = null
      socket.close()
      socket = null
    }
  }
}
