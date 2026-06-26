import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { useToast } from '@/components/ui/toast'
import { POIForm } from './new-collection/POIForm'
import { AtonForm } from './new-collection/AtonForm'
import { ChartFeatureForm } from './new-collection/ChartFeatureForm'
import { TileForm } from './new-collection/TileForm'
import { GcIcon, StatusBadge, TypeBadge, PlatformBadge } from '@/components/shell'
import { useTasksContext } from '@/lib/tasksContext'
import type { ShellTask, TaskStatus, TaskType } from '@/lib/shellData'
import { formatBackendTime } from '@/lib/datetime'

type SubTab = 'create' | 'active' | 'history'
type CreateType = 'poi' | 'aton' | 'feature' | 'tile'

const SUB_TABS: { key: SubTab; icon: string; label: string }[] = [
    { key: 'create', icon: 'plus', label: '创建新任务' },
    { key: 'active', icon: 'refresh', label: '进行中' },
    { key: 'history', icon: 'archive', label: '任务历史' },
]

// ──────── Type chooser cards ─────────────────────────────
interface TypeChooserProps {
    active: boolean
    onClick: () => void
    icon: string
    title: string
    sub: string
    platforms?: string[]
    platformsLabel?: string
}

function TypeChooser({ active, onClick, icon, title, sub, platforms, platformsLabel }: TypeChooserProps) {
    return (
        <div className={`tc-card${active ? ' active' : ''}`} onClick={onClick}>
            <div className="tc-icon"><GcIcon name={icon} size={20} /></div>
            <div className="tc-body">
                <div className="tc-title">{title}</div>
                <div className="tc-sub">{sub}</div>
                <div className="tc-pf">
                    {platforms && platforms.length > 0
                        ? platforms.map(p => <PlatformBadge key={p} name={p} />)
                        : platformsLabel
                            ? <span className="type-badge t-aton">{platformsLabel}</span>
                            : null}
                </div>
            </div>
            {active && <div className="tc-check"><GcIcon name="check" size={13} /></div>}
        </div>
    )
}

// ──────── Active tasks view ──────────────────────────────
function rawTaskId(id: string): string {
    const i = id.indexOf('_')
    return i >= 0 ? id.slice(i + 1) : id
}

function taskIcon(type: TaskType | string) {
    if (type === 'tile') return 'map'
    if (type === 'aton') return 'navigation'
    if (type === 'feature') return 'layers'
    return 'mapPin'
}

function BigTaskRow({ t, last, onPause, onResume, onStop }: {
    t: ShellTask
    last: boolean
    onPause: (t: ShellTask) => void
    onResume: (t: ShellTask) => void
    onStop: (t: ShellTask) => void
}) {
    return (
        <div className="big-task-row" style={{ borderBottom: last ? 'none' : '1px solid var(--hairline)' }}>
            <div className={`task-row-icon t-${t.type}`} style={{ width: 36, height: 36 }}>
                <GcIcon name={taskIcon(t.type)} size={16} />
            </div>
            <div className="big-task-main">
                <div className="big-task-title">
                    <TypeBadge type={t.type} />
                    <b>{t.name}</b>
                    <StatusBadge status={t.status} />
                </div>
                <div className="big-task-meta mono">
                    {t.started && <><span>开始 {formatBackendTime(t.started, { seconds: true })}</span><span className="sep">·</span></>}
                    {t.type === 'poi' && t.collected != null ? (
                        <span>已采集 {t.collected.toLocaleString()} 条 · {(t.done || 0)}/{(t.total || 0)} 类</span>
                    ) : (
                        <span>
                            {(t.done || 0).toLocaleString()} / {(t.total || 0).toLocaleString()}
                        </span>
                    )}
                    {t.fail > 0 && (
                        <>
                            <span className="sep">·</span>
                            <span style={{ color: 'var(--st-red)' }}>{t.fail.toLocaleString()} 失败</span>
                        </>
                    )}
                </div>
                <div style={{ marginTop: 8 }}>
                    <div className={`progress lg${['running', 'downloading', 'retrying'].includes(t.status) ? ' running' : ''
                        }${t.status === 'paused' ? ' paused' : ''}${t.status === 'failed' ? ' error' : ''
                        }${t.status === 'done' ? ' done' : ''}`}>
                        <i style={{ width: `${Math.round(t.progress * 100)}%` }} />
                    </div>
                </div>
            </div>
            <div style={{ display: 'flex', gap: 2, alignSelf: 'center' }}>
                {t.status === 'paused' ? (
                    <button className="iconbtn" type="button" title="继续" onClick={() => onResume(t)}>
                        <GcIcon name="play" size={14} />
                    </button>
                ) : t.type === 'tile' ? (
                    <button className="iconbtn" type="button" title="暂停" onClick={() => onPause(t)}>
                        <GcIcon name="pause" size={14} />
                    </button>
                ) : null}
                <button className="iconbtn" type="button" title="停止" onClick={() => onStop(t)}>
                    <GcIcon name="stop" size={14} />
                </button>
            </div>
        </div>
    )
}

interface TaskActions {
    onPause: (t: ShellTask) => void
    onResume: (t: ShellTask) => void
    onStop: (t: ShellTask) => void
}

function TaskGroup({ label, tasks, actions }: { label: string; tasks: ShellTask[]; actions: TaskActions }) {
    if (tasks.length === 0) return null
    return (
        <div style={{ marginBottom: 18 }}>
            <div className="section-head" style={{ marginBottom: 8 }}>
                <h2>{label} · {tasks.length}</h2>
            </div>
            <div className="panel">
                {tasks.map((t, i) => (
                    <BigTaskRow
                        key={t.id}
                        t={t}
                        last={i === tasks.length - 1}
                        onPause={actions.onPause}
                        onResume={actions.onResume}
                        onStop={actions.onStop}
                    />
                ))}
            </div>
        </div>
    )
}

function ActiveTasksView() {
    const { tasks } = useTasksContext()
    const { success, error: errorToast } = useToast()
    const running = tasks.filter(t => t.status === 'running' || t.status === 'downloading' || t.status === 'retrying')
    const paused = tasks.filter(t => t.status === 'paused')
    const queued = tasks.filter(t => t.status === 'queued')
    const activeTotal = running.length + paused.length + queued.length

    const onPause = async (t: ShellTask) => {
        try {
            if (t.type === 'tile') await invoke('pause_tile_download', { taskId: rawTaskId(t.id) })
            else if (t.type === 'poi') await invoke('stop_collector', { platform: t.platforms[0] })
            else await invoke('chart_stop_collection')
            success('已暂停', t.name)
        } catch (e) { errorToast('操作失败', String(e)) }
    }
    const onResume = async (t: ShellTask) => {
        try {
            if (t.type === 'tile') { await invoke('start_tile_download', { taskId: rawTaskId(t.id) }); success('已继续', t.name) }
            else errorToast('无法继续', 'POI / 航标 / 航道图任务请到「任务历史」右键继续采集')
        } catch (e) { errorToast('操作失败', String(e)) }
    }
    const onStop = async (t: ShellTask) => {
        try {
            if (t.type === 'tile') await invoke('cancel_tile_download', { taskId: rawTaskId(t.id) })
            else if (t.type === 'poi') await invoke('stop_collector', { platform: t.platforms[0] })
            else await invoke('chart_stop_collection')
            success('已停止', t.name)
        } catch (e) { errorToast('操作失败', String(e)) }
    }
    const actions: TaskActions = { onPause, onResume, onStop }

    return (
        <div className="page-scroll">
            <div style={{ padding: '14px 22px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                    <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                        共 <b className="mono" style={{ color: 'var(--text)' }}>{activeTotal}</b> 个活跃任务
                    </div>
                </div>
                <TaskGroup label="运行中" tasks={running} actions={actions} />
                <TaskGroup label="已暂停" tasks={paused} actions={actions} />
                <TaskGroup label="等待中" tasks={queued} actions={actions} />
                {activeTotal === 0 && (
                    <div className="empty" style={{ padding: '60px 20px' }}>
                        <div className="empty-icon"><GcIcon name="inbox" size={22} /></div>
                        <h4>当前没有活跃任务</h4>
                        <p>切换到「创建新任务」开始一次采集。</p>
                    </div>
                )}
            </div>
        </div>
    )
}

// ──────── History view ───────────────────────────────────
interface UnifiedTask {
    id: string
    task_type: string
    name: string
    status: string
    total: number
    completed: number
    failed: number
    platform: string | null
    output_path: string | null
    created_at: string | null
    completed_at: string | null
    extra: string | null
}

const STATUS_NORMALIZE: Record<string, TaskStatus> = {
    running: 'running', downloading: 'downloading', paused: 'paused',
    completed: 'done', done: 'done', failed: 'failed', error: 'error',
    canceled: 'canceled', cancelled: 'canceled',
    interrupted: 'interrupted', queued: 'queued', pending: 'queued',
    idle: 'idle', retrying: 'retrying',
}

function inferType(t: string): TaskType {
    const s = t.toLowerCase()
    if (s.includes('tile')) return 'tile'
    if (s.includes('feature')) return 'feature'
    if (s.includes('buoy') || s.includes('aton')) return 'aton'
    return 'poi'
}

/** POI 任务从 extra 中读取实际采集条数。 */
function poiCollected(h: UnifiedTask): number {
    if (!h.extra) return 0
    try {
        const v = JSON.parse(h.extra)?.total_collected
        return typeof v === 'number' ? v : 0
    } catch {
        return 0
    }
}

function parseExtra(extra: string | null): Record<string, unknown> {
    if (!extra) return {}
    try { return JSON.parse(extra) } catch { return {} }
}

function parseTaskLayers(extra: Record<string, unknown>): string[] {
    const raw = extra.layers
    if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === 'string')
    if (typeof raw !== 'string' || !raw.trim()) return []
    try {
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
    } catch {
        return raw.split(/[,，\s]+/).filter(Boolean)
    }
}

function parseNumberList(raw: unknown): number[] {
    if (Array.isArray(raw)) return raw.map(Number).filter(Number.isFinite)
    if (typeof raw !== 'string' || !raw.trim()) return []
    try {
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : []
    } catch {
        return raw.split(/[,，\s]+/).map(Number).filter(Number.isFinite)
    }
}

function taskBoundsParams(extra: Record<string, unknown>) {
    const west = Number(extra.bounds_west)
    const south = Number(extra.bounds_south)
    const east = Number(extra.bounds_east)
    const north = Number(extra.bounds_north)
    if ([west, south, east, north].every(Number.isFinite) && east > west && north > south) {
        return { west, south, east, north }
    }
    return null
}

function vectorLayersForHistoryTask(h: UnifiedTask, extra: Record<string, unknown>): string[] {
    if (inferType(h.task_type) !== 'feature') return []
    const layers = parseTaskLayers(extra)
    if (layers.length === 0) return ['HYDRO_A', 'electronic_fence']
    return layers.filter(layer => layer === 'HYDRO_A' || layer === 'electronic_fence')
}

interface CtxAction { label: string; icon: string; onClick: () => void }

// ──────── Task row context menu ──────────────────────────
function TaskCtxMenu({ x, y, actions, onClose }: { x: number; y: number; actions: CtxAction[]; onClose: () => void }) {
    useEffect(() => {
        const close = (e: Event) => {
            if (e instanceof KeyboardEvent && e.key !== 'Escape') return
            onClose()
        }
        const t = setTimeout(() => {
            document.addEventListener('mousedown', onClose)
            document.addEventListener('keydown', close)
        }, 0)
        return () => {
            clearTimeout(t)
            document.removeEventListener('mousedown', onClose)
            document.removeEventListener('keydown', close)
        }
    }, [onClose])

    const MENU_W = 200
    const MENU_H = actions.length * 28 + 8
    const left = Math.min(x, window.innerWidth - MENU_W - 8)
    const top = Math.min(y, window.innerHeight - MENU_H - 8)

    return createPortal(
        <div className="ctx-menu" style={{ left, top }} onContextMenu={e => e.preventDefault()}>
            {actions.map((a, i) => (
                <button
                    key={i}
                    type="button"
                    className="ctx-item"
                    onClick={() => { a.onClick(); onClose() }}
                >
                    <span className="ctx-icon"><GcIcon name={a.icon} size={12} /></span>
                    <span className="ctx-label">{a.label}</span>
                </button>
            ))}
        </div>,
        document.body,
    )
}

function HistoryView({ refreshTick }: { refreshTick: number }) {
    const navigate = useNavigate()
    const { success, error: errorToast, warning } = useToast()
    const [filter, setFilter] = useState<'all' | 'poi' | 'aton' | 'feature' | 'tile'>('all')
    const [items, setItems] = useState<UnifiedTask[]>([])
    const [loading, setLoading] = useState(true)
    const [menu, setMenu] = useState<{ x: number; y: number; actions: CtxAction[] } | null>(null)

    const resumeTask = async (h: UnifiedTask) => {
        const kind = inferType(h.task_type)
        const extra = parseExtra(h.extra)
        try {
            if (kind === 'aton' || kind === 'feature') {
                const bounds = taskBoundsParams(extra)
                if (!bounds) { warning('无法继续', '该任务未记录边界范围'); return }
                if (kind === 'feature' || h.task_type === 'feature' || extra.chart_task_type === 'feature') {
                    const taskLayers = parseTaskLayers(extra)
                    const hasLayerRecord = taskLayers.length > 0
                    const rasterLayers = taskLayers.filter(layer => ['yizhangtu', 'cjshoudong', 'soundg'].includes(layer))
                    const zoomLevels = parseNumberList(extra.zoom_levels)
                    await invoke('chart_start_feature_collection', {
                        ...bounds,
                        gridStep: (extra.grid_step as number) || 0.2,
                        includeFences: hasLayerRecord ? taskLayers.includes('electronic_fence') : ((extra.include_fences as boolean | undefined) ?? true),
                        includeHydro: hasLayerRecord ? taskLayers.includes('HYDRO_A') : ((extra.include_hydro as boolean | undefined) ?? true),
                        layers: rasterLayers,
                        zoomLevels: zoomLevels.length > 0 ? zoomLevels : undefined,
                        outputPath: rasterLayers.length > 0 ? h.output_path : null,
                        taskName: h.name,
                    })
                } else {
                    await invoke('chart_start_buoy_collection', {
                        ...bounds,
                        gridStep: (extra.grid_step as number) || 0.1,
                        taskName: h.name,
                    })
                }
            } else if (kind === 'poi') {
                const regionCode = extra.region_code as string
                if (!h.platform || !regionCode) { warning('无法继续', '该任务缺少平台或区域信息'); return }
                await invoke('start_collector', { platform: h.platform, categories: null, regions: [regionCode], taskName: h.name })
            } else {
                warning('暂不支持', '瓦片任务请在「离线地图」中重新下载'); return
            }
            success('已启动', `${h.name} 采集已开始`)
        } catch (err) {
            errorToast('启动失败', String(err))
        }
    }

    const canQuickExport = (h: UnifiedTask, extra: Record<string, unknown>) => {
        const kind = inferType(h.task_type)
        if (kind === 'feature') return vectorLayersForHistoryTask(h, extra).length > 0
        return kind === 'poi' || kind === 'aton'
    }

    const quickExport = async (h: UnifiedTask) => {
        const kind = inferType(h.task_type)
        const extra = parseExtra(h.extra)
        const date = new Date().toISOString().slice(0, 10)
        const safeId = h.id.replace(/[^a-zA-Z0-9_-]/g, '_')
        try {
            if (kind === 'feature') {
                const sourceLayers = vectorLayersForHistoryTask(h, extra)
                if (sourceLayers.length === 0) {
                    warning('无法导出', '该航道图任务只包含瓦片覆盖层，没有水域面或航道要素')
                    return
                }
                const path = await save({
                    defaultPath: `chart_features_${safeId}_${date}.geojson`,
                    filters: [{ name: 'GeoJSON', extensions: ['geojson'] }],
                })
                if (!path) return
                await invoke<string>('chart_export_features', {
                    format: 'geojson',
                    outputPath: path,
                    sourceLayers,
                    ...(taskBoundsParams(extra) ?? {}),
                })
                success('导出成功', '已导出水域面 / 航道要素')
                return
            }

            if (kind === 'aton') {
                const path = await save({
                    defaultPath: `buoys_${safeId}_${date}.csv`,
                    filters: [{ name: 'CSV', extensions: ['csv'] }],
                })
                if (!path) return
                await invoke<string>('chart_export_buoys', {
                    format: 'csv',
                    outputPath: path,
                    ...(taskBoundsParams(extra) ?? {}),
                })
                success('导出成功', '已导出航标数据')
                return
            }

            if (kind === 'poi') {
                const path = await save({
                    defaultPath: `poi_${safeId}_${date}.csv`,
                    filters: [{ name: 'CSV', extensions: ['csv'] }],
                })
                if (!path) return
                await invoke<number>('export_poi_to_file', {
                    path,
                    format: 'csv',
                    filters: {
                        query: null,
                        platforms: h.platform ? [h.platform] : [],
                        bounds: null,
                        region_codes: typeof extra.region_code === 'string' ? [extra.region_code] : [],
                    },
                })
                success('导出成功', '已导出 POI 数据')
            }
        } catch (err) {
            errorToast('导出失败', String(err))
        }
    }

    const openMenu = (e: ReactMouseEvent, h: UnifiedTask) => {
        e.preventDefault()
        e.stopPropagation()
        const kind = inferType(h.task_type)
        const s = STATUS_NORMALIZE[h.status.toLowerCase()] ?? 'idle'
        const extra = parseExtra(h.extra)
        const actions: CtxAction[] = []
        if (kind === 'poi' || kind === 'aton' || kind === 'feature') {
            actions.push({
                label: s === 'done' ? '重新采集' : '继续采集',
                icon: 'play',
                onClick: () => resumeTask(h),
            })
        }
        if (canQuickExport(h, extra)) {
            actions.push({
                label: kind === 'feature' ? '导出水域面/航道要素' : '导出数据',
                icon: 'download',
                onClick: () => quickExport(h),
            })
        }
        if (kind === 'poi' || kind === 'aton' || kind === 'feature') {
            actions.push({ label: '在数据中心查看', icon: 'database', onClick: () => navigate('/data') })
        }
        if (h.output_path) {
            actions.push({
                label: '打开所在文件夹',
                icon: 'folder',
                onClick: () => { if (h.output_path) revealItemInDir(h.output_path).catch(() => { }) },
            })
        }
        actions.push({
            label: '复制名称',
            icon: 'copy',
            onClick: () => navigator.clipboard.writeText(h.name).catch(() => { }),
        })
        setMenu({ x: e.clientX, y: e.clientY, actions })
    }

    useEffect(() => {
        let cancelled = false
        invoke<UnifiedTask[]>('get_all_task_history')
            .then(list => { if (!cancelled) { setItems(list); setLoading(false) } })
            .catch(() => { if (!cancelled) { setItems([]); setLoading(false) } })
        return () => { cancelled = true }
    }, [refreshTick])

    const filtered = useMemo(() => {
        const done = items.filter(i => {
            const s = STATUS_NORMALIZE[i.status.toLowerCase()] ?? 'idle'
            return s === 'done' || s === 'failed' || s === 'canceled' || s === 'interrupted'
        })
        if (filter === 'all') return done
        return done.filter(i => inferType(i.task_type) === filter)
    }, [items, filter])

    return (
        <div className="page-scroll">
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 22px',
                    borderBottom: '1px solid var(--hairline)',
                    background: 'var(--panel)',
                }}
            >
                <div className="seg">
                    {(['all', 'poi', 'aton', 'feature', 'tile'] as const).map(k => (
                        <button
                            key={k}
                            type="button"
                            className={filter === k ? 'active' : ''}
                            onClick={() => setFilter(k)}
                        >
                            {k === 'all' ? '全部' : k === 'poi' ? 'POI' : k === 'aton' ? '航标' : k === 'feature' ? '航道图' : '瓦片'}
                        </button>
                    ))}
                </div>
                <div style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--text-3)' }}>
                    {loading ? '加载中...' : `${filtered.length} 条记录`}
                </div>
            </div>

            <div style={{ padding: '0 22px 22px' }}>
                <table className="table" style={{ marginTop: 8 }}>
                    <thead>
                        <tr>
                            <th>任务</th>
                            <th style={{ width: 90 }}>类型</th>
                            <th style={{ width: 110 }}>状态</th>
                            <th style={{ width: 130, textAlign: 'right' }}>进度</th>
                            <th style={{ width: 100 }}>平台</th>
                            <th style={{ width: 160 }}>完成时间</th>
                            <th style={{ width: 112, textAlign: 'right' }}>操作</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filtered.map(h => {
                            const t = inferType(h.task_type)
                            const s = STATUS_NORMALIZE[h.status.toLowerCase()] ?? 'idle'
                            const extra = parseExtra(h.extra)
                            const showExport = canQuickExport(h, extra)
                            return (
                                <tr
                                    key={h.id}
                                    data-context-path={h.output_path || undefined}
                                    onContextMenu={e => openMenu(e, h)}
                                >
                                    <td>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                            <GcIcon
                                                name={taskIcon(t)}
                                                size={13}
                                                style={{ color: 'var(--text-3)' }}
                                            />
                                            <span style={{ color: 'var(--text)', fontWeight: 500 }}>{h.name}</span>
                                        </div>
                                    </td>
                                    <td><TypeBadge type={t} /></td>
                                    <td><StatusBadge status={s} /></td>
                                    <td className="num mono">
                                        {t === 'poi'
                                            ? `${poiCollected(h).toLocaleString()} 条`
                                            : `${h.completed.toLocaleString()} / ${h.total.toLocaleString()}`}
                                        {h.failed > 0 && (
                                            <span style={{ color: 'var(--st-red)', marginLeft: 4 }}>
                                                /{h.failed}
                                            </span>
                                        )}
                                    </td>
                                    <td className="mono">{h.platform ?? '—'}</td>
                                    <td className="mono">{formatBackendTime(h.completed_at ?? h.created_at, { seconds: true })}</td>
                                    <td>
                                        <div className="row-actions" style={{ opacity: 1, justifyContent: 'flex-end' }}>
                                            {showExport && (
                                                <button
                                                    className="iconbtn"
                                                    type="button"
                                                    title={t === 'feature' ? '导出水域面/航道要素' : '导出数据'}
                                                    onClick={() => quickExport(h)}
                                                >
                                                    <GcIcon name="download" size={13} />
                                                </button>
                                            )}
                                            {h.output_path && (
                                                <button
                                                    className="iconbtn"
                                                    type="button"
                                                    title="打开文件夹"
                                                    onClick={() => {
                                                        if (h.output_path) revealItemInDir(h.output_path).catch(() => { })
                                                    }}
                                                >
                                                    <GcIcon name="folder" size={13} />
                                                </button>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            )
                        })}
                    </tbody>
                </table>

                {!loading && filtered.length === 0 && (
                    <div className="empty" style={{ padding: '60px 20px' }}>
                        <div className="empty-icon"><GcIcon name="archive" size={22} /></div>
                        <h4>没有匹配的历史记录</h4>
                        <p>试试其他筛选条件，或新建一个采集任务。</p>
                    </div>
                )}
            </div>

            {menu && (
                <TaskCtxMenu x={menu.x} y={menu.y} actions={menu.actions} onClose={() => setMenu(null)} />
            )}
        </div>
    )
}

// ──────── Page wrapper ───────────────────────────────────
export default function NewCollection() {
    const [params, setParams] = useSearchParams()
    const initialSub = (params.get('sub') as SubTab) || 'create'
    const initialTab = (params.get('tab') as CreateType) || 'poi'
    const [subtab, setSubtab] = useState<SubTab>(initialSub)
    const [createType, setCreateType] = useState<CreateType>(initialTab)
    const [historyTick, setHistoryTick] = useState(0)
    const { activeCount } = useTasksContext()

    useEffect(() => {
        const sub = params.get('sub') as SubTab | null
        const tab = params.get('tab') as CreateType | null
        if (sub && sub !== subtab) setSubtab(sub)
        if (tab && tab !== createType) setCreateType(tab)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [params])

    const setSub = (k: SubTab) => {
        setSubtab(k)
        const next = new URLSearchParams(params)
        next.set('sub', k)
        setParams(next, { replace: true })
        if (k === 'history') setHistoryTick(t => t + 1)
    }

    const setType = (k: CreateType) => {
        setCreateType(k)
        const next = new URLSearchParams(params)
        next.set('tab', k)
        setParams(next, { replace: true })
    }

    return (
        <div className="page">
            <div className="page-header">
                <div>
                    <h1 className="page-title">新建采集</h1>
                    <div className="page-subtitle">
                        {subtab === 'create' && '选择采集类型，配置参数，启动任务'}
                        {subtab === 'active' && '运行中、暂停、等待中的任务统一管理'}
                        {subtab === 'history' && '已完成 / 失败 / 已取消的任务记录'}
                    </div>
                </div>
                <div className="page-header-actions">
                    <div className="seg">
                        {SUB_TABS.map(t => (
                            <button
                                key={t.key}
                                type="button"
                                className={subtab === t.key ? 'active' : ''}
                                onClick={() => setSub(t.key)}
                            >
                                <GcIcon
                                    name={t.icon}
                                    size={11}
                                    style={{ marginRight: 4, verticalAlign: '-1px' }}
                                />
                                {t.label}
                                {t.key === 'active' && activeCount > 0 && (
                                    <span
                                        style={{
                                            marginLeft: 5,
                                            padding: '0 5px',
                                            borderRadius: 8,
                                            background: 'var(--accent)',
                                            color: '#fff',
                                            fontSize: 9.5,
                                            fontWeight: 600,
                                            verticalAlign: 'middle',
                                        }}
                                    >
                                        {activeCount}
                                    </span>
                                )}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {subtab === 'create' && (
                <div className="nc-create-shell">
                    <div className="nc-typebar">
                        <TypeChooser
                            active={createType === 'poi'}
                            onClick={() => setType('poi')}
                            icon="mapPin"
                            title="POI 数据采集"
                            sub="餐厅、酒店、景点等兴趣点数据"
                            platforms={['tianditu', 'amap', 'baidu', 'osm']}
                        />
                        <TypeChooser
                            active={createType === 'aton'}
                            onClick={() => setType('aton')}
                            icon="navigation"
                            title="航标数据采集"
                            sub="长江航道航标 · 坐标 / 形状 / 灯质"
                            platformsLabel="长江航道图"
                        />
                        <TypeChooser
                            active={createType === 'feature'}
                            onClick={() => setType('feature')}
                            icon="layers"
                            title="航道图专题采集"
                            sub="航道图 / 水域 / 水深 · 水域面 / 航道要素"
                            platformsLabel="长江航道图"
                        />
                        <TypeChooser
                            active={createType === 'tile'}
                            onClick={() => setType('tile')}
                            icon="map"
                            title="离线地图瓦片"
                            sub="按区域 + 缩放范围批量下载"
                            platforms={['tianditu', 'amap', 'osm']}
                        />
                    </div>
                    {createType === 'poi' && <POIForm />}
                    {createType === 'aton' && <AtonForm />}
                    {createType === 'feature' && <ChartFeatureForm />}
                    {createType === 'tile' && <TileForm />}
                </div>
            )}

            {subtab === 'active' && <ActiveTasksView />}
            {subtab === 'history' && <HistoryView refreshTick={historyTick} />}
        </div>
    )
}
