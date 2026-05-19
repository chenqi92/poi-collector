import { useEffect, useMemo, useRef } from 'react'
import { CheckCircle2, Info, AlertTriangle, XCircle, BellOff, X } from 'lucide-react'
import { useNotifications, type NotificationItem, type NotificationVariant } from '@/lib/notificationsContext'

interface NotificationTrayProps {
    onClose: () => void
}

const VARIANT_ICON: Record<NotificationVariant, typeof Info> = {
    info: Info,
    success: CheckCircle2,
    warn: AlertTriangle,
    error: XCircle,
}

const SOURCE_LABEL: Record<NotificationItem['source'], string> = {
    toast: '提示',
    task: '任务',
    system: '系统',
}

function formatTime(ts: number): string {
    const diff = Date.now() - ts
    if (diff < 60_000) return '刚刚'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
    const d = new Date(ts)
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const hh = String(d.getHours()).padStart(2, '0')
    const mi = String(d.getMinutes()).padStart(2, '0')
    return `${mm}-${dd} ${hh}:${mi}`
}

export function NotificationTray({ onClose }: NotificationTrayProps) {
    const ref = useRef<HTMLDivElement | null>(null)
    const { items, markAllRead, remove, clear, unreadCount } = useNotifications()

    useEffect(() => {
        const onDoc = (e: MouseEvent) => {
            if (!ref.current) return
            if (ref.current.contains(e.target as Node)) return
            const btn = (e.target as HTMLElement).closest?.('.notif-btn')
            if (btn) return
            onClose()
        }
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
        document.addEventListener('mousedown', onDoc)
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('mousedown', onDoc)
            document.removeEventListener('keydown', onKey)
        }
    }, [onClose])

    const sorted = useMemo(() => items, [items])

    return (
        <div className="tray-pop notif-pop" ref={ref}>
            <div className="tray-pop-head">
                <h4>消息 ({sorted.length}{unreadCount > 0 ? ` · ${unreadCount} 未读` : ''})</h4>
                <div style={{ display: 'flex', gap: 4 }}>
                    <button
                        className="btn ghost sm"
                        type="button"
                        onClick={markAllRead}
                        disabled={unreadCount === 0}
                    >
                        全部已读
                    </button>
                    <button
                        className="btn ghost sm"
                        type="button"
                        onClick={clear}
                        disabled={sorted.length === 0}
                    >
                        清空
                    </button>
                </div>
            </div>
            <div className="tray-pop-list">
                {sorted.map(n => {
                    const Icon = VARIANT_ICON[n.variant]
                    return (
                        <div className={`notif-row${n.read ? '' : ' unread'}`} key={n.id}>
                            <div className={`notif-icon ${n.variant}`}>
                                <Icon size={14} />
                            </div>
                            <div className="notif-main">
                                <div className="notif-title-row">
                                    <span className="notif-title">{n.title || '(无标题)'}</span>
                                    <span className="notif-src">{SOURCE_LABEL[n.source]}</span>
                                </div>
                                {n.description && <div className="notif-sub">{n.description}</div>}
                                <div className="notif-time">{formatTime(n.ts)}</div>
                            </div>
                            <button
                                className="iconbtn notif-x"
                                type="button"
                                title="移除"
                                onClick={() => remove(n.id)}
                            >
                                <X size={11} />
                            </button>
                        </div>
                    )
                })}
                {sorted.length === 0 && (
                    <div className="empty" style={{ padding: '28px 16px' }}>
                        <div className="empty-icon"><BellOff size={22} /></div>
                        <h4>暂无消息</h4>
                        <p>任务完成、错误提示会出现在这里。</p>
                    </div>
                )}
            </div>
        </div>
    )
}
