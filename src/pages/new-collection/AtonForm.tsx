import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { GcIcon } from '@/components/shell'
import { useToast } from '@/components/ui/toast'
import { RegionTagsPicker, type SelectedRegion } from './RegionTagsPicker'

// Approximate bounding boxes for the Yangtze waterway provinces / prefectures.
// Same lookup the legacy Collector used — kept in-page for transparency.
const REGION_BOUNDS: Record<string, { west: number; south: number; east: number; north: number }> = {
    '420000': { west: 108.3, south: 29.0, east: 116.1, north: 33.3 },
    '420100': { west: 113.7, south: 29.97, east: 115.08, north: 31.36 }, // 武汉
    '420500': { west: 110.15, south: 29.56, east: 112.18, north: 31.75 }, // 宜昌
    '421000': { west: 111.15, south: 29.26, east: 114.01, north: 30.65 }, // 荆州
    '420600': { west: 112.31, south: 30.23, east: 113.32, north: 30.71 }, // 襄阳
    '420700': { west: 113.52, south: 30.07, east: 114.87, north: 30.71 }, // 鄂州
    '420200': { west: 114.32, south: 29.71, east: 115.43, north: 30.24 }, // 黄石
    '421200': { west: 114.87, south: 29.83, east: 116.07, north: 31.22 }, // 咸宁
    '421100': { west: 114.25, south: 29.83, east: 116.07, north: 31.06 }, // 黄冈
    '430000': { west: 108.8, south: 24.6, east: 114.3, north: 30.1 },
    '430600': { west: 113.08, south: 28.88, east: 113.85, north: 29.69 }, // 岳阳
    '430100': { west: 111.88, south: 27.85, east: 114.26, north: 28.67 }, // 长沙
    '360000': { west: 113.6, south: 24.5, east: 118.5, north: 30.1 },
    '360400': { west: 115.22, south: 29.03, east: 116.82, north: 29.96 }, // 九江
    '320000': { west: 116.4, south: 30.7, east: 121.9, north: 35.1 },
    '310000': { west: 120.9, south: 30.7, east: 122.0, north: 31.9 },
}

const FALLBACK_BOUNDS = { west: 111.37, south: 29.23, east: 114.01, north: 30.37 }

const REGIONS_STORE_KEY = 'poi_selected_regions'

const STEP_OPTIONS: { v: number; label: string; desc: string; relCost: string }[] = [
    { v: 0.05, label: '0.05°', desc: '高精度', relCost: '~120 min' },
    { v: 0.1, label: '0.1°', desc: '推荐', relCost: '~36 min' },
    { v: 0.2, label: '0.2°', desc: '快速', relCost: '~12 min' },
    { v: 0.5, label: '0.5°', desc: '概览', relCost: '~3 min' },
]

interface ChartProgress {
    task_type: string
    status: string
    current: number
    total: number
    message: string | null
}

export function AtonForm() {
    const { success, error: errorToast, warning } = useToast()

    const [taskName, setTaskName] = useState('长江航标采集任务')
    const [regions, setRegions] = useState<SelectedRegion[]>(() => {
        try {
            return JSON.parse(localStorage.getItem(REGIONS_STORE_KEY) ?? '[]')
        } catch { return [] }
    })
    const [step, setStep] = useState(0.1)
    const [featureStep, setFeatureStep] = useState(0.2)
    const [includeFences, setIncludeFences] = useState(true)
    const [includeHydro, setIncludeHydro] = useState(true)
    const [buoyCount, setBuoyCount] = useState(0)
    const [featureCount, setFeatureCount] = useState(0)
    const [status, setStatus] = useState<'idle' | 'running'>('idle')
    const [featureStatus, setFeatureStatus] = useState<'idle' | 'running'>('idle')
    const [progress, setProgress] = useState<ChartProgress | null>(null)
    const [featureProgress, setFeatureProgress] = useState<ChartProgress | null>(null)

    useEffect(() => {
        localStorage.setItem(REGIONS_STORE_KEY, JSON.stringify(regions))
    }, [regions])

    useEffect(() => {
        const load = async () => {
            try {
                const [c, fc] = await Promise.all([
                    invoke<number>('chart_get_buoy_count'),
                    invoke<number>('chart_get_feature_count'),
                ])
                setBuoyCount(c)
                setFeatureCount(fc)
            } catch { /* ignore */ }
        }
        load()
        const unlisten = listen<ChartProgress>('chart-progress', e => {
            const p = e.payload
            if (p.task_type === 'buoy') {
                setProgress(p)
                if (p.status === 'completed') {
                    setStatus('idle')
                    load()
                } else if (p.status === 'running' || p.status === 'collecting') {
                    setStatus('running')
                }
            }
            if (p.task_type === 'feature') {
                setFeatureProgress(p)
                if (p.status === 'completed') {
                    setFeatureStatus('idle')
                    load()
                } else if (p.status === 'running' || p.status === 'collecting') {
                    setFeatureStatus('running')
                }
            }
        })
        return () => { unlisten.then(fn => fn()) }
    }, [])

    const bounds = useMemo(() => {
        if (regions.length === 0) return null
        let west = 180, south = 90, east = -180, north = -90
        let matched = false
        for (const r of regions) {
            const b = REGION_BOUNDS[r.code]
            if (b) {
                matched = true
                west = Math.min(west, b.west)
                south = Math.min(south, b.south)
                east = Math.max(east, b.east)
                north = Math.max(north, b.north)
            }
        }
        return matched ? { west, south, east, north } : FALLBACK_BOUNDS
    }, [regions])

    const gridX = bounds ? Math.ceil((bounds.east - bounds.west) / step) : 0
    const gridY = bounds ? Math.ceil((bounds.north - bounds.south) / step) : 0
    const totalCells = gridX * gridY
    const featureGridX = bounds ? Math.ceil((bounds.east - bounds.west) / featureStep) : 0
    const featureGridY = bounds ? Math.ceil((bounds.north - bounds.south) / featureStep) : 0
    const featureCells = featureGridX * featureGridY
    const featureSources = (includeFences ? 1 : 0) + (includeHydro ? 1 : 0)
    const featureRequests = featureCells * featureSources
    const anyRunning = status === 'running' || featureStatus === 'running'

    const start = async () => {
        if (!bounds) {
            warning('未选择地区', '请先选择沿江省市')
            return
        }
        try {
            setStatus('running')
            await invoke('chart_start_buoy_collection', {
                west: bounds.west,
                south: bounds.south,
                east: bounds.east,
                north: bounds.north,
                gridStep: step,
            })
            success(
                '航标采集已启动',
                `范围 [${bounds.west.toFixed(2)}, ${bounds.south.toFixed(2)}] → [${bounds.east.toFixed(2)}, ${bounds.north.toFixed(2)}]`
            )
        } catch (e) {
            setStatus('idle')
            errorToast('启动失败', String(e))
        }
    }

    const stop = async () => {
        try {
            await invoke('chart_stop_collection')
            setStatus('idle')
            setFeatureStatus('idle')
            success('已停止', '采集任务已停止')
        } catch (e) {
            errorToast('停止失败', String(e))
        }
    }

    const startFeatures = async () => {
        if (!bounds) {
            warning('未选择地区', '请先选择沿江省市')
            return
        }
        if (!includeFences && !includeHydro) {
            warning('未选择要素', '请至少选择电子围栏或 HYDRO_A 水域面')
            return
        }
        try {
            setFeatureStatus('running')
            await invoke('chart_start_feature_collection', {
                west: bounds.west,
                south: bounds.south,
                east: bounds.east,
                north: bounds.north,
                gridStep: featureStep,
                includeFences,
                includeHydro,
            })
            success(
                '航道要素采集已启动',
                `预计 ${featureRequests.toLocaleString()} 个请求`
            )
        } catch (e) {
            setFeatureStatus('idle')
            errorToast('启动失败', String(e))
        }
    }

    return (
        <div className="nc-create-scroll">
            <div className="nc-form-shell">
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
                            <span className="step-no">2</span>沿江省市
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
                        <div className="aton-coords mono">
                            <span>推导经纬度范围</span>
                            {bounds ? (
                                <span>
                                    SW {bounds.south.toFixed(2)}°N, {bounds.west.toFixed(2)}°E
                                    {' → '}
                                    NE {bounds.north.toFixed(2)}°N, {bounds.east.toFixed(2)}°E
                                </span>
                            ) : (
                                <span>请先选择地区</span>
                            )}
                        </div>
                    </div>

                    <div className="td-block">
                        <div className="td-block-title"><span className="step-no">3</span>网格步长</div>
                        <div className="step-grid">
                            {STEP_OPTIONS.map(opt => (
                                <label
                                    key={opt.v}
                                    className={`step-opt${step === opt.v ? ' active' : ''}`}
                                    onClick={() => setStep(opt.v)}
                                >
                                    <span className="step-radio">{step === opt.v && <i />}</span>
                                    <div>
                                        <div className="step-label">{opt.label}</div>
                                        <div className="step-desc">{opt.desc}</div>
                                    </div>
                                    <span className="mono step-cost">{opt.relCost}</span>
                                </label>
                            ))}
                        </div>
                        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-3)', lineHeight: 1.5 }}>
                            步长越小覆盖越精细，但 API 调用次数呈平方增长。0.1° 通常足够发现所有航标。
                        </div>
                    </div>

                    <div className="td-block">
                        <div className="td-block-title"><span className="step-no">4</span>航道要素</div>
                        <div className="step-grid">
                            <label
                                className={`step-opt${includeFences ? ' active' : ''}`}
                                onClick={() => setIncludeFences(v => !v)}
                            >
                                <span className="step-radio">{includeFences && <i />}</span>
                                <div>
                                    <div className="step-label">电子围栏</div>
                                    <div className="step-desc">报告线 / 卡口 / 保护区</div>
                                </div>
                                <span className="mono step-cost">fence</span>
                            </label>
                            <label
                                className={`step-opt${includeHydro ? ' active' : ''}`}
                                onClick={() => setIncludeHydro(v => !v)}
                            >
                                <span className="step-radio">{includeHydro && <i />}</span>
                                <div>
                                    <div className="step-label">HYDRO_A 水域面</div>
                                    <div className="step-desc">AIS 航道外过滤推荐</div>
                                </div>
                                <span className="mono step-cost">polygon</span>
                            </label>
                        </div>
                        <div style={{ marginTop: 10 }}>
                            <div className="lab-tiny" style={{ marginBottom: 6 }}>要素采集步长</div>
                            <div className="step-grid">
                                {STEP_OPTIONS.map(opt => (
                                    <label
                                        key={`feature-${opt.v}`}
                                        className={`step-opt${featureStep === opt.v ? ' active' : ''}`}
                                        onClick={() => setFeatureStep(opt.v)}
                                    >
                                        <span className="step-radio">{featureStep === opt.v && <i />}</span>
                                        <div>
                                            <div className="step-label">{opt.label}</div>
                                            <div className="step-desc">{opt.desc}</div>
                                        </div>
                                        <span className="mono step-cost">{opt.relCost}</span>
                                    </label>
                                ))}
                            </div>
                        </div>
                        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-3)', lineHeight: 1.5 }}>
                            HYDRO_A 是水域/深度面，适合作为 AIS 点位过滤的基础面；电子围栏作为卡口、报告线、保护区等专题补充。
                        </div>
                    </div>

                    {status === 'running' && progress && (
                        <div className="td-block">
                            <div className="td-block-title"><span className="step-no">●</span>采集进度</div>
                            <div className="panel">
                                <div style={{ padding: 14 }}>
                                    <div className="progress running">
                                        <i
                                            style={{
                                                width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%`,
                                            }}
                                        />
                                    </div>
                                    <div
                                        style={{
                                            marginTop: 8,
                                            display: 'flex',
                                            gap: 10,
                                            fontSize: 11.5,
                                            color: 'var(--text-3)',
                                        }}
                                    >
                                        <span className="mono">
                                            {progress.current} / {progress.total}
                                        </span>
                                        <span style={{ flex: 1 }}>{progress.message}</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {featureStatus === 'running' && featureProgress && (
                        <div className="td-block">
                            <div className="td-block-title"><span className="step-no">●</span>要素采集进度</div>
                            <div className="panel">
                                <div style={{ padding: 14 }}>
                                    <div className="progress running">
                                        <i
                                            style={{
                                                width: `${featureProgress.total > 0 ? (featureProgress.current / featureProgress.total) * 100 : 0}%`,
                                            }}
                                        />
                                    </div>
                                    <div
                                        style={{
                                            marginTop: 8,
                                            display: 'flex',
                                            gap: 10,
                                            fontSize: 11.5,
                                            color: 'var(--text-3)',
                                        }}
                                    >
                                        <span className="mono">
                                            {featureProgress.current} / {featureProgress.total}
                                        </span>
                                        <span style={{ flex: 1 }}>{featureProgress.message}</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                <div className="nc-form-side">
                    <div className="panel sub">
                        <div className="panel-head"><h3>配置概要</h3></div>
                        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
                            <div>
                                <div className="lab-tiny">扫描网格</div>
                                <div className="big-num">{totalCells.toLocaleString() || '—'}</div>
                                <div className="mono small-meta">
                                    {bounds ? `${gridX} × ${gridY} 格 · 步长 ${step}°` : '请先选择地区'}
                                </div>
                            </div>
                            <div className="divider" style={{ margin: 0 }} />
                            <div>
                                <div className="lab-tiny">已采航标总数</div>
                                <div className="big-num">{buoyCount.toLocaleString()}</div>
                                <div className="mono small-meta">来源：长江航道图（实时）</div>
                            </div>
                            <div className="divider" style={{ margin: 0 }} />
                            <div>
                                <div className="lab-tiny">已采航道要素</div>
                                <div className="big-num">{featureCount.toLocaleString()}</div>
                                <div className="mono small-meta">
                                    {bounds ? `${featureGridX} × ${featureGridY} 格 · 约 ${featureRequests.toLocaleString()} 请求` : '请先选择地区'}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div className="td-footer">
                <div style={{ flex: 1 }} />
                {anyRunning ? (
                    <button type="button" className="btn danger" onClick={stop}>
                        <GcIcon name="stop" size={13} />停止采集
                    </button>
                ) : (
                    <>
                        <button
                            type="button"
                            className="btn"
                            onClick={startFeatures}
                            disabled={!bounds || featureSources === 0}
                        >
                            <GcIcon name="database" size={13} />采集航道要素
                        </button>
                        <button
                            type="button"
                            className="btn primary"
                            onClick={start}
                            disabled={!bounds}
                        >
                            <GcIcon name="play" size={13} />采集航标
                        </button>
                    </>
                )}
            </div>
        </div>
    )
}
