import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { invoke } from '@tauri-apps/api/core'
import { GcIcon, StatusBadge, TypeBadge, PlatformBadge } from '@/components/shell'
import { useTasksContext } from '@/lib/tasksContext'
import type { PlatformKey, ShellTask } from '@/lib/shellData'

interface BackendStats {
    total: number
    by_platform: Record<string, number>
    by_category: Record<string, number>
}

interface RegionRow {
    code: string
    name: string
    level: string
    parent_code: string | null
}

interface ApiKey {
    id: number
    key: string
    name?: string
}

const PLATFORM_CAPS: Record<string, number> = {
    tianditu: 100000,
    amap: 100000,
    baidu: 50000,
    osm: 999999,
    cjhd: 999999,
}

const PLATFORM_UNLIMITED: Record<string, boolean> = {
    osm: true,
    cjhd: true,
}

function taskIcon(type: ShellTask['type']) {
    if (type === 'tile') return 'map'
    if (type === 'aton') return 'navigation'
    if (type === 'feature') return 'layers'
    return 'mapPin'
}

interface StatItem {
    label: string
    value: number
    share?: number // 0..1 — share of total POI数 if applicable, for the bar at bottom
}

function StatCard({ k }: { k: StatItem }) {
    const big = k.value >= 100000
    const display = k.value === 0
        ? '0'
        : k.value < 1000
            ? String(k.value)
            : `${(k.value / 1000).toFixed(big ? 0 : 1)}`
    const showK = k.value >= 1000
    const sharePct = k.share != null ? Math.max(0, Math.min(1, k.share)) * 100 : null
    return (
        <div className="stat">
            <div className="stat-label">{k.label}</div>
            <div className="stat-value">
                {display}
                {showK && (
                    <span style={{ fontSize: 13, color: 'var(--text-3)', fontWeight: 500, marginLeft: 2 }}>
                        k
                    </span>
                )}
            </div>
            {sharePct != null && k.value > 0 && (
                <div className="stat-delta">
                    <span style={{ color: 'var(--text-3)' }} className="mono">
                        占总量 {sharePct.toFixed(1)}%
                    </span>
                </div>
            )}
        </div>
    )
}

function QuotaCard({ keysByPlatform, onManage }: {
    keysByPlatform: Record<string, ApiKey[]>
    onManage: () => void
}) {
    const platforms: PlatformKey[] = ['tianditu', 'amap', 'baidu', 'osm']
    return (
        <div className="panel">
            <div className="panel-head">
                <h3>API Key 配额</h3>
                <span className="meta">基于已配置 Key</span>
                <div className="panel-head-actions">
                    <button className="btn ghost sm" type="button" onClick={onManage}>
                        <GcIcon name="settings" size={12} />管理
                    </button>
                </div>
            </div>
            <div className="quota-card">
                {platforms.map(p => {
                    const keys = keysByPlatform[p] ?? []
                    const cap = PLATFORM_CAPS[p] ?? 1
                    const unlimited = PLATFORM_UNLIMITED[p]
                    const count = keys.length
                    const totalCap = cap * Math.max(1, count)
                    const isUnconfigured = !unlimited && count === 0
                    const fillCls = unlimited ? 'unlimited' : count === 0 ? 'crit' : count === 1 ? 'warn' : 'ok'
                    const fillPct = unlimited ? 100 : count === 0 ? 0 : Math.min(100, 25 + count * 25)
                    return (
                        <div
                            className={`quota-row${isUnconfigured ? ' unconfigured' : ''}`}
                            key={p}
                        >
                            <div className="quota-platform"><PlatformBadge name={p} /></div>
                            <div className="quota-bar">
                                {!isUnconfigured && (
                                    <i className={fillCls} style={{ width: `${fillPct}%` }} />
                                )}
                            </div>
                            <div className="quota-num">
                                {unlimited ? (
                                    <span className="qnum-mute">无限制</span>
                                ) : count === 0 ? (
                                    <span className="qnum-warn">未配置</span>
                                ) : (
                                    <>
                                        <span className="qnum-main">{count}</span>
                                        <span className="qnum-sub">把 · {(totalCap / 1000).toFixed(0)}k/日</span>
                                    </>
                                )}
                            </div>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}

function ActiveTasksCard({
    tasks,
    onGoNew,
}: { tasks: ShellTask[]; onGoNew: () => void }) {
    const running = tasks.filter(t => t.status === 'running' || t.status === 'downloading' || t.status === 'retrying').length
    if (tasks.length === 0) {
        return (
            <div className="panel">
                <div className="panel-head"><h3>最近任务</h3></div>
                <div className="empty" style={{ padding: '36px 20px' }}>
                    <div className="empty-icon"><GcIcon name="inbox" size={22} /></div>
                    <h4>还没有任务</h4>
                    <p>开始你的第一个采集任务。可以是 POI 数据、长江航标或离线地图瓦片。</p>
                    <div className="empty-actions">
                        <button className="btn primary sm" type="button" onClick={onGoNew}>
                            <GcIcon name="plus" size={13} /> 新建采集任务
                        </button>
                    </div>
                </div>
            </div>
        )
    }
    return (
        <div className="panel task-list-card">
            <div className="panel-head">
                <h3>最近任务</h3>
                <span className="meta">{tasks.length} 项 · {running} 个运行中</span>
                <div className="panel-head-actions">
                    <button className="btn ghost sm" type="button" onClick={onGoNew}>
                        查看全部 <GcIcon name="chevronRight" size={11} />
                    </button>
                </div>
            </div>
            {tasks.slice(0, 5).map(t => (
                <div className={`task-row t-${t.type}`} key={t.id}>
                    <div className="task-row-icon">
                        <GcIcon name={taskIcon(t.type)} size={14} />
                    </div>
                    <div className="task-row-main">
                        <div className="task-row-title">
                            <TypeBadge type={t.type} />
                            <span className="tt-name">{t.name}</span>
                            <StatusBadge status={t.status} />
                        </div>
                        <div
                            style={{
                                marginTop: 7,
                                display: 'grid',
                                gridTemplateColumns: '1fr 220px',
                                gap: 10,
                                alignItems: 'center',
                            }}
                        >
                            <div
                                className={`progress${['running', 'downloading'].includes(t.status) ? ' running' : ''
                                    }${t.status === 'paused' ? ' paused' : ''}${t.status === 'done' ? ' done' : ''
                                    }${t.status === 'failed' ? ' error' : ''}`}
                            >
                                <i style={{ width: `${Math.round(t.progress * 100)}%` }} />
                            </div>
                            <div className="task-row-meta" style={{ marginTop: 0, justifyContent: 'flex-end' }}>
                                <span className="tnum">
                                    {t.type === 'poi' && t.collected != null
                                        ? `${t.collected.toLocaleString()} 条 · ${(t.done || 0)}/${(t.total || 0)} 类`
                                        : `${(t.done || 0).toLocaleString()} / ${(t.total || 0).toLocaleString()}`}
                                </span>
                                {t.fail > 0 && (
                                    <>
                                        <span className="sep">·</span>
                                        <span style={{ color: 'var(--st-red)' }}>{t.fail.toLocaleString()} 失败</span>
                                    </>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            ))}
        </div>
    )
}

function RegionsCard({
    rows,
}: { rows: { name: string; count: number }[] }) {
    if (rows.length === 0) {
        return (
            <div className="panel">
                <div className="panel-head"><h3>已采集地区</h3></div>
                <div className="empty" style={{ padding: '28px 20px' }}>
                    <div className="empty-icon"><GcIcon name="globe" size={22} /></div>
                    <h4>暂无数据</h4>
                    <p>采集任务完成后，地区数据会汇总在这里。</p>
                </div>
            </div>
        )
    }
    const max = rows[0]?.count ?? 1
    return (
        <div className="panel">
            <div className="panel-head">
                <h3>已采集地区 Top {rows.length}</h3>
                <span className="meta">共 {rows.length} 个</span>
            </div>
            <div style={{ padding: '4px 14px 12px' }}>
                {rows.map(r => (
                    <div className="region-row" key={r.name}>
                        <div className="region-name">{r.name}</div>
                        <div className="region-bar"><i style={{ width: `${(r.count / max) * 100}%` }} /></div>
                        <div className="region-count">{r.count.toLocaleString()}</div>
                    </div>
                ))}
            </div>
        </div>
    )
}

function CategoriesCard({ rows }: { rows: [string, number][] }) {
    if (rows.length === 0) return null
    const max = rows[0][1]
    return (
        <div className="panel">
            <div className="panel-head">
                <h3>分类排行 Top {rows.length}</h3>
                <span className="meta">基于 POI 类别</span>
            </div>
            <div style={{ padding: '4px 14px 12px' }}>
                {rows.map(([name, count]) => (
                    <div className="region-row" key={name}>
                        <div className="region-name">{name}</div>
                        <div className="region-bar">
                            <i style={{ width: `${(count / max) * 100}%`, background: 'var(--st-violet)' }} />
                        </div>
                        <div className="region-count">{count.toLocaleString()}</div>
                    </div>
                ))}
            </div>
        </div>
    )
}

function QuickActions({ onGo }: { onGo: (p: string) => void }) {
    const actions = [
        { id: 'poi', icon: 'mapPin', title: '新建 POI 采集', sub: '天地图 / 高德 / 百度 / OSM', path: '/new?tab=poi' },
        { id: 'tile', icon: 'map', title: '下载离线瓦片', sub: '按区域 + 缩放范围', path: '/new?tab=tile' },
        { id: 'open', icon: 'database', title: '打开数据中心', sub: '浏览 / 导出 / 整理', path: '/data' },
        { id: 'offline', icon: 'archive', title: '管理离线地图', sub: '查看已下载瓦片包', path: '/offline' },
    ]
    return (
        <div>
            <div className="section-head"><h2>快捷操作</h2></div>
            <div className="quick-actions">
                {actions.map(a => (
                    <div className="quick-action" key={a.id} onClick={() => onGo(a.path)}>
                        <div className="quick-action-icon"><GcIcon name={a.icon} size={15} /></div>
                        <div className="quick-action-title">{a.title}</div>
                        <div className="quick-action-sub">{a.sub}</div>
                    </div>
                ))}
            </div>
        </div>
    )
}

export default function Dashboard() {
    const navigate = useNavigate()
    const { tasks: tasksList } = useTasksContext()
    const [stats, setStats] = useState<BackendStats | null>(null)
    const [regionTops, setRegionTops] = useState<{ name: string; count: number }[]>([])
    const [keys, setKeys] = useState<Record<string, ApiKey[]>>({})
    const [loading, setLoading] = useState(true)
    const [refreshTick, setRefreshTick] = useState(0)

    useEffect(() => {
        let cancelled = false
        const load = async () => {
            const safe = async <T,>(fn: () => Promise<T>, fallback: T): Promise<T> => {
                try { return await fn() } catch { return fallback }
            }

            const [s, rs, ks] = await Promise.all([
                safe(() => invoke<BackendStats>('get_stats'), { total: 0, by_platform: {}, by_category: {} }),
                safe(() => invoke<[string, number][]>('get_poi_stats_by_region'), []),
                safe(() => invoke<Record<string, ApiKey[]>>('get_api_keys'), {}),
            ])

            // Region name lookup (provinces + their children, two-level)
            let regionMap: Record<string, string> = {}
            try {
                const provinces = await invoke<RegionRow[]>('get_provinces')
                for (const p of provinces) regionMap[p.code] = p.name
                // 区划码是层级前缀：省 2 位 / 市 4 位 / 县 6 位。
                // 市名要查省的子级（parent=前 2 位），县名要查市的子级（parent=前 4 位）。
                const codesNeeded = new Set(rs.map(([c]) => c).filter(c => !regionMap[c]))
                const parentCodes = new Set<string>()
                for (const c of codesNeeded) {
                    if (c.length >= 4) parentCodes.add(c.slice(0, 2)) // 省 → 市
                    if (c.length >= 6) parentCodes.add(c.slice(0, 4)) // 市 → 县
                }
                await Promise.all(
                    Array.from(parentCodes).map(async pc => {
                        try {
                            const children = await invoke<RegionRow[]>('get_region_children', { parentCode: pc })
                            for (const c of children) regionMap[c.code] = c.name
                        } catch { /* ignore */ }
                    })
                )
            } catch { /* ignore */ }

            const tops = rs
                .map(([code, n]) => ({ name: regionMap[code] ?? code, count: Number(n) }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 7)

            if (cancelled) return
            setStats(s)
            setRegionTops(tops)
            setKeys(ks)
            setLoading(false)
        }
        load()
        return () => { cancelled = true }
    }, [refreshTick])

    const topCategories = useMemo(() => {
        if (!stats) return [] as [string, number][]
        return Object.entries(stats.by_category)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 8)
    }, [stats])

    const statItems: StatItem[] = useMemo(() => {
        const bp = stats?.by_platform ?? {}
        const total = stats?.total ?? 0
        return [
            { label: '总 POI 数', value: total },
            { label: '天地图', value: bp.tianditu ?? 0, share: total > 0 ? (bp.tianditu ?? 0) / total : 0 },
            { label: '高德', value: bp.amap ?? 0, share: total > 0 ? (bp.amap ?? 0) / total : 0 },
            { label: '百度', value: bp.baidu ?? 0, share: total > 0 ? (bp.baidu ?? 0) / total : 0 },
            { label: 'OSM', value: bp.osm ?? 0, share: total > 0 ? (bp.osm ?? 0) / total : 0 },
        ]
    }, [stats])

    const populated = (stats?.total ?? 0) > 0 || tasksList.length > 0

    return (
        <div className="page">
            <div className="page-header">
                <div>
                    <h1 className="page-title">工作台</h1>
                    <div className="page-subtitle">
                        {loading
                            ? '正在加载...'
                            : populated
                                ? `已采集 ${(stats?.total ?? 0).toLocaleString()} 条 POI · ${tasksList.length} 个任务`
                                : '欢迎使用 GeoCollector — 从右上角新建第一个采集任务开始'}
                    </div>
                </div>
                <div className="page-header-actions">
                    <button className="btn" type="button" onClick={() => setRefreshTick(t => t + 1)}>
                        <GcIcon name="refresh" size={13} />刷新
                    </button>
                    <button className="btn primary" type="button" onClick={() => navigate('/new')}>
                        <GcIcon name="plus" size={13} />新建任务
                    </button>
                </div>
            </div>
            <div className="page-scroll">
                <div className="page-pad">
                    {populated && (
                        <div className="ws-grid" style={{ marginBottom: 18 }}>
                            {statItems.map(s => (
                                <StatCard key={s.label} k={s} />
                            ))}
                        </div>
                    )}

                    <ActiveTasksCard tasks={tasksList} onGoNew={() => navigate('/new')} />

                    <div className="ws-row">
                        <RegionsCard rows={regionTops} />
                        <QuotaCard keysByPlatform={keys} onManage={() => navigate('/settings')} />
                    </div>

                    {populated && topCategories.length > 0 && (
                        <div className="ws-row" style={{ marginTop: 14 }}>
                            <CategoriesCard rows={topCategories} />
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                                <QuickActions onGo={p => navigate(p)} />
                            </div>
                        </div>
                    )}

                    {!populated && (
                        <div style={{ marginTop: 16 }}>
                            <QuickActions onGo={p => navigate(p)} />
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
