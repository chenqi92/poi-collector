import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react'

export type NotificationVariant = 'info' | 'success' | 'warn' | 'error'
export type NotificationSource = 'toast' | 'task' | 'system'

export interface NotificationItem {
    id: string
    title: string
    description?: string
    variant: NotificationVariant
    source: NotificationSource
    ts: number
    read: boolean
}

interface NotificationsContextValue {
    items: NotificationItem[]
    unreadCount: number
    push: (n: Omit<NotificationItem, 'id' | 'ts' | 'read'>) => void
    markAllRead: () => void
    remove: (id: string) => void
    clear: () => void
}

const STORE_KEY = 'poi-notifications-v1'
const MAX_KEEP = 100

const NotificationsContext = createContext<NotificationsContextValue | null>(null)

function loadInitial(): NotificationItem[] {
    try {
        const raw = localStorage.getItem(STORE_KEY)
        if (!raw) return []
        const arr = JSON.parse(raw)
        if (!Array.isArray(arr)) return []
        return arr.slice(0, MAX_KEEP)
    } catch {
        return []
    }
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
    const [items, setItems] = useState<NotificationItem[]>(loadInitial)

    useEffect(() => {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(items)) } catch { /* ignore */ }
    }, [items])

    const push = useCallback((n: Omit<NotificationItem, 'id' | 'ts' | 'read'>) => {
        const next: NotificationItem = {
            ...n,
            id: Math.random().toString(36).slice(2, 10),
            ts: Date.now(),
            read: false,
        }
        setItems(prev => [next, ...prev].slice(0, MAX_KEEP))
    }, [])

    const markAllRead = useCallback(() => {
        setItems(prev => prev.some(x => !x.read) ? prev.map(x => ({ ...x, read: true })) : prev)
    }, [])

    const remove = useCallback((id: string) => {
        setItems(prev => prev.filter(x => x.id !== id))
    }, [])

    const clear = useCallback(() => setItems([]), [])

    const unreadCount = useMemo(() => items.reduce((s, x) => s + (x.read ? 0 : 1), 0), [items])

    const value = useMemo<NotificationsContextValue>(() => ({
        items, unreadCount, push, markAllRead, remove, clear,
    }), [items, unreadCount, push, markAllRead, remove, clear])

    return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>
}

export function useNotifications() {
    const ctx = useContext(NotificationsContext)
    if (!ctx) throw new Error('useNotifications must be used inside NotificationsProvider')
    return ctx
}

/* Stable ref-style accessor so non-React modules (e.g. toast) can push without
   subscribing.  Set once by NotificationsBridge below. */
const externalPushRef: { current: NotificationsContextValue['push'] | null } = { current: null }

export function setExternalPush(fn: NotificationsContextValue['push'] | null) {
    externalPushRef.current = fn
}

export function externalPushNotification(n: Omit<NotificationItem, 'id' | 'ts' | 'read'>) {
    externalPushRef.current?.(n)
}

/* Mount inside NotificationsProvider to expose push() to the module-level
   helper above.  Lets non-context callers (toast) record notifications. */
export function NotificationsBridge() {
    const { push } = useNotifications()
    const pushRef = useRef(push)
    pushRef.current = push
    useEffect(() => {
        setExternalPush((n) => pushRef.current(n))
        return () => setExternalPush(null)
    }, [])
    return null
}
