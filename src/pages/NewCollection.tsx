import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { invoke } from '@tauri-apps/api/core'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { useToast } from '@/components/ui/toast'
import { POIForm } from './new-collection/POIForm'
import { AtonForm } from './new-collection/AtonForm'
import { TileForm } from './new-collection/TileForm'
import { GcIcon, StatusBadge, TypeBadge, PlatformBadge } from '@/components/shell'
import { useTasksContext } from '@/lib/tasksContext'
import type { ShellTask, TaskStatus, TaskType } from '@/lib/shellData'

type SubTab = 'create' | 'active' | 'history'
type CreateType = 'poi' | 'aton' | 'tile'

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
function BigTaskRow({ t, last }: { t: ShellTask; last: boolean }) {
    return (
        <div className="big-task-row" style={{ borderBottom: last ? 'none' : '1px solid var(--hairline)' }}>
            <div className={`task-row-icon t-${t.type}`} style={{ width: 36, height: 36 }}>
                <GcIcon
                    name={t.type === 'tile' ? 'map' : t.type === 'aton' ? 'navigation' : 'mapPin'}
                    size={16}
                />
            </div>
            <div className="big-task-main">
                <div className="big-task-title">
                    <TypeBadge type={t.type} />
                    <b>{t.name}</b>
                    <StatusBadge status={t.status} />
                </div>
                <div className="big-task-meta mono">
                    {t.started && <><span>开始 {t.started}</span><span className="sep">·</span></>}
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
        </div>
    )
}

function TaskGroup({ label, tasks }: { label: string; tasks: ShellTask[] }) {
    if (tasks.length === 0) return null
    return (
        <div style={{ marginBottom: 18 }}>
            <div className="section-head" style={{ marginBottom: 8 }}>
                <h2>{label} · {tasks.length}</h2>
            </div>
            <div className="panel">
                {tasks.map((t, i) => (
                    <BigTaskRow key={t.id} t={t} last={i === tasks.length - 1} />
                ))}
            </div>
        </div>
    )
}

function ActiveTasksView() {
    const { tasks } = useTasksContext()
    const running = tasks.filter(t => t.status === 'running' || t.status === 'downloading' || t.status === 'retrying')
    const paused = tasks.filter(t => t.status === 'paused')
    const queued = tasks.filter(t => t.status === 'queued')
    const activeTotal = running.length + paused.length + queued.length

    return (
        <div className="page-scroll">
            <div style={{ padding: '14px 22px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                    <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                        共 <b className="mono" style={{ color: 'var(--text)' }}>{activeTotal}</b> 个活跃任务
                    </div>
                </div>
                <TaskGroup label="运行中" tasks={running} />
                <TaskGroup label="已暂停" tasks={paused} />
                <TaskGroup label="等待中" tasks={queued} />
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
    const [filter, setFilter] = useState<'all' | 'poi' | 'aton' | 'tile'>('all')
    const [items, setItems] = useState<UnifiedTask[]>([])
    const [loading, setLoading] = useState(true)
    const [menu, setMenu] = useState<{ x: number; y: number; actions: CtxAction[] } | null>(null)

    const resumeTask = async (h: UnifiedTask) => {
        const kind = inferType(h.task_type)
        const extra = parseExtra(h.extra)
        try {
            if (kind === 'aton') {
                const w = extra.bounds_west as number, s = extra.bounds_south as number
                const e = extra.bounds_east as number, n = extra.bounds_north as number
                if (!w && !s && !e && !n) { warning('无法继续', '该任务未记录边界范围'); return }
                await invoke('chart_start_buoy_collection', {
                    west: w, south: s, east: e, north: n,
                    gridStep: (extra.grid_step as number) || 0.1,
                })
            } else if (kind === 'poi') {
                const regionCode = extra.region_code as string
                if (!h.platform || !regionCode) { warning('无法继续', '该任务缺少平台或区域信息'); return }
                await invoke('start_collector', { platform: h.platform, categories: null, regions: [regionCode] })
            } else {
                warning('暂不支持', '瓦片任务请在「离线地图」中重新下载'); return
            }
            success('已启动', `${h.name} 采集已开始`)
        } catch (err) {
            errorToast('启动失败', String(err))
        }
    }

    const openMenu = (e: ReactMouseEvent, h: UnifiedTask) => {
        e.preventDefault()
        e.stopPropagation()
        const kind = inferType(h.task_type)
        const s = STATUS_NORMALIZE[h.status.toLowerCase()] ?? 'idle'
        const actions: CtxAction[] = []
        if (kind === 'poi' || kind === 'aton') {
            actions.push({
                label: s === 'done' ? '重新采集' : '继续采集',
                icon: 'play',
                onClick: () => resumeTask(h),
            })
        }
        if (kind === 'poi' || kind === 'aton') {
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
                    {(['all', 'poi', 'aton', 'tile'] as const).map(k => (
                        <button
                            key={k}
                            type="button"
                            className={filter === k ? 'active' : ''}
                            onClick={() => setFilter(k)}
                        >
                            {k === 'all' ? '全部' : k === 'poi' ? 'POI' : k === 'aton' ? '航标' : '瓦片'}
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
                            <th style={{ width: 80 }}></th>
                        </tr>
                    </thead>
                    <tbody>
                        {filtered.map(h => {
                            const t = inferType(h.task_type)
                            const s = STATUS_NORMALIZE[h.status.toLowerCase()] ?? 'idle'
                            return (
                                <tr
                                    key={h.id}
                                    data-context-path={h.output_path || undefined}
                                    onContextMenu={e => openMenu(e, h)}
                                >
                                    <td>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                            <GcIcon
                                                name={t === 'tile' ? 'map' : t === 'aton' ? 'navigation' : 'mapPin'}
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
                                    <td className="mono">{h.completed_at ?? h.created_at ?? '—'}</td>
                                    <td>
                                        <div className="row-actions">
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
                    {createType === 'tile' && <TileForm />}
                </div>
            )}

            {subtab === 'active' && <ActiveTasksView />}
            {subtab === 'history' && <HistoryView refreshTick={historyTick} />}
        </div>
    )
}
