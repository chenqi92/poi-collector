import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { invoke } from '@tauri-apps/api/core'
import { GcIcon, PlatformBadge } from '@/components/shell'
import { useToast } from '@/components/ui/toast'
import { RegionTagsPicker, type SelectedRegion } from './RegionTagsPicker'

interface Category {
    id: string
    name: string
    keywords: string[]
}

interface CollectorStatus {
    platform: string
    status: 'idle' | 'running' | 'paused' | 'completed' | 'error'
    total_collected: number
    completed_categories: string[]
    current_category_id: string
    error_message?: string
}

interface ApiKey {
    id: number
    api_key: string
    name?: string | null
}

const PLATFORMS: {
    id: 'tianditu' | 'amap' | 'baidu' | 'osm'
    label: string
    desc: string
    needsKey: boolean
    dailyQuota: string
    unlimited?: boolean
}[] = [
        { id: 'tianditu', label: '天地图', desc: '国家测绘局，覆盖最全', needsKey: true, dailyQuota: '100k / 天' },
        { id: 'amap', label: '高德', desc: 'POI 数据丰富，分类细致', needsKey: true, dailyQuota: '100k / 天' },
        { id: 'baidu', label: '百度', desc: '城市生活类数据强', needsKey: true, dailyQuota: '50k / 天' },
        { id: 'osm', label: 'OpenStreetMap', desc: '国际数据，无需 Key', needsKey: false, dailyQuota: '无限', unlimited: true },
    ]

const REGIONS_STORE_KEY = 'poi_selected_regions'

export function POIForm() {
    const navigate = useNavigate()
    const { success, error: errorToast, warning } = useToast()

    const [taskName, setTaskName] = useState('未命名 POI 采集任务')
    // 默认不预选任何平台；加载到 Key 后，仅自动勾选「有 Key / 无需 Key」的首选平台
    const [enabled, setEnabled] = useState<Record<string, boolean>>({
        tianditu: false, amap: false, baidu: false, osm: false,
    })
    const autoPickedRef = useRef(false)
    const [regions, setRegions] = useState<SelectedRegion[]>(() => {
        try {
            const saved = localStorage.getItem(REGIONS_STORE_KEY)
            return saved ? JSON.parse(saved) : []
        } catch { return [] }
    })
    const [categories, setCategories] = useState<Category[]>([])
    const [selectedCats, setSelectedCats] = useState<Record<string, string[]>>({})
    const [apiKeys, setApiKeys] = useState<Record<string, ApiKey[]>>({})
    const [statuses, setStatuses] = useState<Record<string, CollectorStatus>>({})
    const [openCatPlatform, setOpenCatPlatform] = useState<string | null>(null)

    const [retries, setRetries] = useState(3)
    const [concurrency, setConcurrency] = useState(4)

    useEffect(() => {
        const load = async () => {
            try {
                const [cats, keys, stat] = await Promise.all([
                    invoke<Category[]>('get_categories'),
                    invoke<Record<string, ApiKey[]>>('get_api_keys'),
                    invoke<Record<string, CollectorStatus>>('get_collector_statuses'),
                ])
                setCategories(cats)
                setApiKeys(keys)
                setStatuses(stat)
                const init: Record<string, string[]> = {}
                for (const p of PLATFORMS) init[p.id] = cats.map(c => c.id)
                setSelectedCats(init)

                // 首次加载：仅自动勾选有 Key（或无需 Key）的首选平台，缺 Key 的不预选
                if (!autoPickedRef.current) {
                    autoPickedRef.current = true
                    const PREFERRED = ['tianditu', 'amap']
                    setEnabled(e => {
                        const next = { ...e }
                        for (const id of PREFERRED) {
                            const p = PLATFORMS.find(x => x.id === id)
                            if (!p) continue
                            const hasKey = !p.needsKey || (keys[id]?.length ?? 0) > 0
                            if (hasKey) next[id] = true
                        }
                        return next
                    })
                }
            } catch (e) {
                console.error(e)
            }
        }
        load()
        const t = setInterval(async () => {
            try {
                const s = await invoke<Record<string, CollectorStatus>>('get_collector_statuses')
                setStatuses(s)
            } catch { /* ignore */ }
        }, 3000)
        return () => clearInterval(t)
    }, [])

    useEffect(() => {
        localStorage.setItem(REGIONS_STORE_KEY, JSON.stringify(regions))
    }, [regions])

    const togglePlatform = (id: string, needsKey: boolean) => {
        if (needsKey && (apiKeys[id]?.length ?? 0) === 0) {
            warning('未配置 Key', `请先到「设置 → API Keys」录入 ${id} 的 Key`)
            return
        }
        setEnabled(e => ({ ...e, [id]: !e[id] }))
    }

    const activePlatforms = useMemo(
        () => PLATFORMS.filter(p => enabled[p.id]),
        [enabled]
    )

    const toggleCategory = (platform: string, catId: string) => {
        setSelectedCats(s => {
            const cur = new Set(s[platform] ?? [])
            if (cur.has(catId)) cur.delete(catId); else cur.add(catId)
            return { ...s, [platform]: Array.from(cur) }
        })
    }

    const startOne = async (platform: string) => {
        if (regions.length === 0) {
            warning('未选择地区', '请先选择采集地区')
            return
        }
        const pf = PLATFORMS.find(x => x.id === platform)
        if (pf?.needsKey && (apiKeys[platform]?.length ?? 0) === 0) {
            warning('未配置 Key', `${pf.label} 缺少 API Key，请到「设置 → API Keys」录入`)
            return
        }
        const cats = selectedCats[platform] ?? []
        if (cats.length === 0) {
            warning('未选择类别', `请先为 ${platform} 选择类别`)
            return
        }
        try {
            await invoke('start_collector', {
                platform,
                categories: cats,
                regions: regions.map(r => r.code),
                taskName: taskName.trim() || '未命名 POI 采集任务',
            })
            success('已启动', `${platform} 采集已开始`)
        } catch (e) {
            errorToast('启动失败', String(e))
        }
    }

    const stopOne = async (platform: string) => {
        try {
            await invoke('stop_collector', { platform })
            success('已暂停', `${platform} 采集已暂停`)
        } catch (e) {
            errorToast('暂停失败', String(e))
        }
    }

    const resetOne = async (platform: string) => {
        if (!confirm('确定要重置该平台的采集进度吗？')) return
        try {
            await invoke('reset_collector', { platform })
            success('已重置', `${platform} 进度已清空`)
        } catch (e) {
            errorToast('重置失败', String(e))
        }
    }

    const startAll = async () => {
        if (activePlatforms.length === 0) {
            warning('未选择平台', '至少勾选一个采集平台')
            return
        }
        for (const p of activePlatforms) await startOne(p.id)
    }

    const stopAll = async () => {
        for (const p of activePlatforms) await stopOne(p.id)
    }

    const totalCats = activePlatforms.reduce(
        (n, p) => n + (selectedCats[p.id]?.length ?? 0),
        0
    )
    const totalCollected = Object.values(statuses).reduce(
        (n, s) => n + (s?.total_collected ?? 0),
        0
    )

    return (
        <div className="nc-create-scroll">
            <div className="nc-form-shell">
                {/* Main column */}
                <div className="nc-form-main">
                    <div className="td-block">
                        <div className="td-block-title"><span className="step-no">1</span>基础信息</div>
                        <div className="field-row">
                            <label className="field-label">任务名称</label>
                            <input
                                className="input"
                                value={taskName}
                                onChange={e => setTaskName(e.target.value)}
                            />
                        </div>
                    </div>

                    <div className="td-block">
                        <div className="td-block-title">
                            <span className="step-no">2</span>选择平台
                            <span
                                style={{
                                    marginLeft: 'auto',
                                    fontSize: 10.5,
                                    color: 'var(--text-3)',
                                    textTransform: 'none',
                                    letterSpacing: 0,
                                    fontWeight: 500,
                                }}
                            >
                                已选 <b style={{ color: 'var(--text)' }}>{activePlatforms.length}</b> 个
                            </span>
                        </div>
                        <div className="pf-grid">
                            {PLATFORMS.map(p => {
                                const on = !!enabled[p.id]
                                const hasKey = !p.needsKey || (apiKeys[p.id]?.length ?? 0) > 0
                                const cats = selectedCats[p.id] ?? []
                                const status = statuses[p.id]
                                return (
                                    <div
                                        key={p.id}
                                        className={`pf-card${on ? ' on' : ''}${!hasKey ? ' disabled' : ''}`}
                                        onClick={() => hasKey && togglePlatform(p.id, p.needsKey)}
                                    >
                                        <div className="pf-card-head">
                                            <PlatformBadge name={p.id} />
                                            <span style={{ flex: 1 }} />
                                            <span
                                                style={{
                                                    width: 16, height: 16, borderRadius: 4,
                                                    border: '1.5px solid var(--border-2)',
                                                    background: on ? 'var(--accent)' : 'transparent',
                                                    display: 'grid', placeItems: 'center', color: '#fff',
                                                    flexShrink: 0,
                                                }}
                                            >
                                                {on && <GcIcon name="check" size={10} strokeWidth={2.5} />}
                                            </span>
                                        </div>
                                        <div className="pf-card-desc">{p.desc}</div>
                                        <div className="pf-card-foot">
                                            <span className="mono">{p.dailyQuota}</span>
                                            {!hasKey && (
                                                <span className="pf-warn">
                                                    <GcIcon name="alertTriangle" size={10} /> 缺 Key
                                                </span>
                                            )}
                                            {status && (status.status === 'running' || status.status === 'paused') && (
                                                <span style={{ color: 'var(--st-amber)', marginLeft: 'auto', fontSize: 10.5 }}>
                                                    {status.status === 'running' ? '运行中' : '已暂停'} ·{' '}
                                                    {status.total_collected.toLocaleString()}
                                                </span>
                                            )}
                                        </div>
                                        {on && (
                                            <button
                                                type="button"
                                                className="pf-cat-btn"
                                                onClick={e => {
                                                    e.stopPropagation()
                                                    setOpenCatPlatform(openCatPlatform === p.id ? null : p.id)
                                                }}
                                            >
                                                <GcIcon name="grid" size={11} />
                                                选择类别 ({cats.length} / {categories.length})
                                            </button>
                                        )}
                                        {on && openCatPlatform === p.id && (
                                            <div
                                                style={{
                                                    marginTop: 6,
                                                    padding: 8,
                                                    border: '1px solid var(--border)',
                                                    borderRadius: 6,
                                                    background: 'var(--panel-2)',
                                                    maxHeight: 200,
                                                    overflow: 'auto',
                                                }}
                                                onClick={e => e.stopPropagation()}
                                            >
                                                <div className="field-chips">
                                                    {categories.map(c => (
                                                        <button
                                                            key={c.id}
                                                            type="button"
                                                            className={`field-chip${cats.includes(c.id) ? ' on' : ''}`}
                                                            onClick={() => toggleCategory(p.id, c.id)}
                                                        >
                                                            {cats.includes(c.id) && <GcIcon name="check" size={10} strokeWidth={2.5} />}
                                                            {c.name}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    </div>

                    <div className="td-block">
                        <div className="td-block-title">
                            <span className="step-no">3</span>选择地区
                            <span
                                style={{
                                    marginLeft: 'auto',
                                    fontSize: 10.5,
                                    color: 'var(--text-3)',
                                    textTransform: 'none',
                                    letterSpacing: 0,
                                    fontWeight: 500,
                                }}
                            >
                                已选 <b style={{ color: 'var(--text)' }}>{regions.length}</b> 个
                            </span>
                        </div>
                        <RegionTagsPicker value={regions} onChange={setRegions} />
                    </div>

                    <div className="td-block">
                        <div className="td-block-title"><span className="step-no">4</span>高级选项</div>
                        <div className="td-field-grid">
                            <div className="field-row">
                                <label className="field-label">失败重试次数</label>
                                <input
                                    className="input"
                                    type="number"
                                    min={0}
                                    max={10}
                                    value={retries}
                                    onChange={e => setRetries(+e.target.value)}
                                />
                            </div>
                            <div className="field-row">
                                <label className="field-label">
                                    并发数 <span className="hint">建议 4–8</span>
                                </label>
                                <input
                                    className="input"
                                    type="number"
                                    min={1}
                                    max={32}
                                    value={concurrency}
                                    onChange={e => setConcurrency(+e.target.value)}
                                />
                            </div>
                        </div>
                    </div>
                </div>

                {/* Side: real configuration summary (no fabricated estimates) */}
                <div className="nc-form-side">
                    <div className="panel sub">
                        <div className="panel-head"><h3>配置概要</h3></div>
                        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
                            <div>
                                <div className="lab-tiny">已选地区</div>
                                <div className="big-num">{regions.length}</div>
                                <div className="mono small-meta">
                                    {regions.length === 0
                                        ? '请先选择地区'
                                        : regions.slice(0, 2).map(r => r.name).join(', ') + (regions.length > 2 ? ` +${regions.length - 2}` : '')}
                                </div>
                            </div>
                            <div className="divider" style={{ margin: 0 }} />
                            <div>
                                <div className="lab-tiny">已选平台 × 类别</div>
                                <div className="big-num">
                                    {activePlatforms.length}
                                    <span style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 500 }}>
                                        {' '}× {totalCats}
                                    </span>
                                </div>
                                <div className="mono small-meta">
                                    {activePlatforms.length === 0 ? '请勾选至少一个平台' : activePlatforms.map(p => p.label).join(' · ')}
                                </div>
                            </div>
                            <div className="divider" style={{ margin: 0 }} />
                            <div>
                                <div className="lab-tiny">当前已采集（本会话）</div>
                                <div className="big-num">{totalCollected.toLocaleString()}</div>
                                <div className="mono small-meta">合计所有平台运行结果</div>
                            </div>
                            <div className="divider" style={{ margin: 0 }} />
                            <div>
                                <div className="lab-tiny">API Key 状态</div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 6 }}>
                                    {activePlatforms.map(p => {
                                        const keyCount = apiKeys[p.id]?.length ?? 0
                                        const warn = p.needsKey && keyCount === 0
                                        return (
                                            <div
                                                key={p.id}
                                                style={{
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: 6,
                                                    fontSize: 11.5,
                                                }}
                                            >
                                                <PlatformBadge name={p.id} />
                                                <span style={{ flex: 1 }} />
                                                <span
                                                    className="mono"
                                                    style={{ color: warn ? 'var(--st-amber)' : 'var(--text-2)' }}
                                                >
                                                    {p.unlimited ? '无需 Key' : warn ? '缺 Key' : `${keyCount} 把 Key`}
                                                </span>
                                            </div>
                                        )
                                    })}
                                </div>
                                {activePlatforms.some(p => p.needsKey && (apiKeys[p.id]?.length ?? 0) === 0) && (
                                    <div className="quota-warn" style={{ marginTop: 8 }}>
                                        <GcIcon name="alertTriangle" size={11} />
                                        <span>
                                            部分平台缺 Key，到「
                                            <a
                                                style={{ color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer' }}
                                                onClick={() => navigate('/settings?tab=keys')}
                                            >
                                                设置 → API Keys
                                            </a>
                                            」录入。
                                        </span>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div className="td-footer">
                <div style={{ flex: 1 }} />
                <button type="button" className="btn" onClick={stopAll} disabled={activePlatforms.length === 0}>
                    <GcIcon name="pause" size={11} />全部暂停
                </button>
                <button
                    type="button"
                    className="btn"
                    onClick={() => activePlatforms.forEach(p => resetOne(p.id))}
                    disabled={activePlatforms.length === 0}
                >
                    <GcIcon name="refresh" size={11} />重置已选
                </button>
                <button
                    type="button"
                    className="btn primary"
                    onClick={startAll}
                    disabled={activePlatforms.length === 0 || regions.length === 0}
                >
                    <GcIcon name="play" size={13} />立即开始
                </button>
            </div>
        </div>
    )
}
