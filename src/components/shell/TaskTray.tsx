import { useEffect, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { GcIcon } from './Icon'
import { StatusBadge } from './Badges'
import { useToast } from '@/components/ui/toast'
import { useTasksContext } from '@/lib/tasksContext'
import { isActive, type ShellTask } from '@/lib/shellData'

interface TaskTrayProps {
    onClose: () => void
}

/** 去掉 poi_/buoy_/tile_ 前缀，得到底层任务 id。 */
function rawId(id: string): string {
    const i = id.indexOf('_')
    return i >= 0 ? id.slice(i + 1) : id
}

function taskIcon(type: ShellTask['type']) {
    if (type === 'tile') return 'map'
    if (type === 'aton') return 'navigation'
    if (type === 'feature') return 'layers'
    return 'mapPin'
}

export function TaskTray({ onClose }: TaskTrayProps) {
    const ref = useRef<HTMLDivElement | null>(null)
    const { tasks } = useTasksContext()
    const { success, error: errorToast } = useToast()
    const active = tasks.filter(isActive)

    // 暂停（仅瓦片支持真正的暂停/继续；POI/航标只能停止）
    const pauseTask = async (t: ShellTask) => {
        try {
            if (t.type === 'tile') await invoke('pause_tile_download', { taskId: rawId(t.id) })
            else if (t.type === 'poi') await invoke('stop_collector', { platform: t.platforms[0] })
            else await invoke('chart_stop_collection')
            success('已暂停', t.name)
        } catch (e) { errorToast('操作失败', String(e)) }
    }

    const resumeTask = async (t: ShellTask) => {
        try {
            if (t.type === 'tile') { await invoke('start_tile_download', { taskId: rawId(t.id) }); success('已继续', t.name) }
            else errorToast('无法继续', 'POI / 航标 / 航道图任务请到「任务历史」右键继续采集')
        } catch (e) { errorToast('操作失败', String(e)) }
    }

    const stopTask = async (t: ShellTask) => {
        try {
            if (t.type === 'tile') await invoke('cancel_tile_download', { taskId: rawId(t.id) })
            else if (t.type === 'poi') await invoke('stop_collector', { platform: t.platforms[0] })
            else await invoke('chart_stop_collection')
            success('已停止', t.name)
        } catch (e) { errorToast('操作失败', String(e)) }
    }

    const stopAll = async () => {
        for (const t of active) await stopTask(t)
    }

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
                    <button
                        className="btn ghost sm"
                        type="button"
                        onClick={stopAll}
                        disabled={active.length === 0}
                    >
                        <GcIcon name="stop" size={12} />全部停止
                    </button>
                </div>
            </div>
            <div className="tray-pop-list">
                {active.map(t => (
                    <div className="tray-row" key={t.id}>
                        <div className="task-row-icon" style={{ width: 24, height: 24 }}>
                            <GcIcon name={taskIcon(t.type)} size={13} />
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
                                    {t.type === 'poi' && t.collected != null
                                        ? `${t.collected.toLocaleString()} 条 · ${t.done || 0}/${t.total || 0} 类`
                                        : `${(t.done || 0).toLocaleString()}/${(t.total || 0).toLocaleString()}`}
                                </span>
                            </div>
                        </div>
                        <div className="tray-row-actions">
                            {t.status === 'paused' ? (
                                <button className="iconbtn" title="继续" type="button" onClick={() => resumeTask(t)}>
                                    <GcIcon name="play" size={13} />
                                </button>
                            ) : t.type === 'tile' ? (
                                <button className="iconbtn" title="暂停" type="button" onClick={() => pauseTask(t)}>
                                    <GcIcon name="pause" size={13} />
                                </button>
                            ) : null}
                            <button className="iconbtn" title="停止" type="button" onClick={() => stopTask(t)}>
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
