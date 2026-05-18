import { useEffect, useRef } from 'react'
import { GcIcon } from './Icon'
import { StatusBadge } from './Badges'
import { useTasksContext } from '@/lib/tasksContext'
import { isActive } from '@/lib/shellData'

interface TaskTrayProps {
    onClose: () => void
}

export function TaskTray({ onClose }: TaskTrayProps) {
    const ref = useRef<HTMLDivElement | null>(null)
    const { tasks } = useTasksContext()
    const active = tasks.filter(isActive)

    useEffect(() => {
        const onDoc = (e: MouseEvent) => {
            if (!ref.current) return
            if (ref.current.contains(e.target as Node)) return
            const btn = (e.target as HTMLElement).closest?.('.tray-btn')
            if (btn) return
            onClose()
        }
        document.addEventListener('mousedown', onDoc)
        return () => document.removeEventListener('mousedown', onDoc)
    }, [onClose])

    return (
        <div className="tray-pop" ref={ref}>
            <div className="tray-pop-head">
                <h4>活跃任务 ({active.length})</h4>
                <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn ghost sm" type="button">
                        <GcIcon name="pause" size={12} />全部暂停
                    </button>
                </div>
            </div>
            <div className="tray-pop-list">
                {active.map(t => (
                    <div className="tray-row" key={t.id}>
                        <div className="task-row-icon" style={{ width: 24, height: 24 }}>
                            <GcIcon
                                name={t.type === 'tile' ? 'map' : t.type === 'aton' ? 'navigation' : 'mapPin'}
                                size={13}
                            />
                        </div>
                        <div className="tray-row-main">
                            <div className="tray-row-title">
                                <span className="tt-name">{t.name}</span>
                                <StatusBadge status={t.status} />
                            </div>
                            <div style={{ marginTop: 6 }}>
                                <div
                                    className={`progress thin${t.status === 'running' || t.status === 'downloading'
                                            ? ' running'
                                            : ''
                                        }${t.status === 'paused' ? ' paused' : ''}`}
                                >
                                    <i style={{ width: `${Math.round(t.progress * 100)}%` }} />
                                </div>
                            </div>
                            <div className="tray-row-meta">
                                <span className="tnum">
                                    {(t.done || 0).toLocaleString()}/{(t.total || 0).toLocaleString()}
                                </span>
                                <span className="sep">·</span>
                                <span>{t.speed}</span>
                                <span className="sep">·</span>
                                <span>剩余 {t.eta}</span>
                            </div>
                        </div>
                        <div className="tray-row-actions">
                            {t.status === 'paused' ? (
                                <button className="iconbtn" title="继续" type="button">
                                    <GcIcon name="play" size={13} />
                                </button>
                            ) : (
                                <button className="iconbtn" title="暂停" type="button">
                                    <GcIcon name="pause" size={13} />
                                </button>
                            )}
                            <button className="iconbtn" title="停止" type="button">
                                <GcIcon name="stop" size={13} />
                            </button>
                        </div>
                    </div>
                ))}
                {active.length === 0 && (
                    <div className="empty" style={{ padding: '24px 16px' }}>
                        <div className="empty-icon"><GcIcon name="inbox" size={22} /></div>
                        <h4>当前没有运行中的任务</h4>
                        <p>到「新建采集」开始一个 POI 或瓦片下载任务。</p>
                    </div>
                )}
            </div>
        </div>
    )
}
