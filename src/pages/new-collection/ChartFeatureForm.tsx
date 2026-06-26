import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { TileBoundsMap, type Bounds } from '@/components/TileBoundsMap'
import { GcIcon } from '@/components/shell'
import { useToast } from '@/components/ui/toast'

const EMPTY_BOUNDS: Bounds = { north: 0, south: 0, east: 0, west: 0 }

const STEP_OPTIONS: { v: number; label: string; desc: string; relCost: string }[] = [
    { v: 0.05, label: '0.05°', desc: '高精度', relCost: '~120 min' },
    { v: 0.1, label: '0.1°', desc: '推荐', relCost: '~36 min' },
    { v: 0.2, label: '0.2°', desc: '快速', relCost: '~12 min' },
    { v: 0.5, label: '0.5°', desc: '概览', relCost: '~3 min' },
]

const RASTER_LAYERS: { id: string; label: string; desc: string }[] = [
    { id: 'yizhangtu', label: '航道图', desc: '一张图 / 航道专题底图' },
    { id: 'cjshoudong', label: '水域', desc: '航道水域瓦片覆盖层' },
    { id: 'soundg', label: '水深', desc: '水深专题瓦片覆盖层' },
]

const ZOOM_PRESETS: { label: string; range: [number, number] }[] = [
    { label: '概览', range: [4, 6] },
    { label: '航段', range: [7, 8] },
    { label: '细节', range: [9, 10] },
]

interface ChartProgress {
    task_type: string
    status: string
    current: number
    total: number
    message: string | null
}

interface ChartTileEstimate {
    total_tiles: number
    tiles_per_level: [number, number][]
    layers_count: number
    total_with_layers: number
}

function validBounds(bounds: Bounds) {
    return bounds.north > bounds.south && bounds.east > bounds.west
}

function formatBounds(bounds: Bounds) {
    return `SW ${bounds.south.toFixed(4)}°N, ${bounds.west.toFixed(4)}°E -> NE ${bounds.north.toFixed(4)}°N, ${bounds.east.toFixed(4)}°E`
}

export function ChartFeatureForm() {
    const { success, error: errorToast, warning } = useToast()

    const [taskName, setTaskName] = useState('航道图专题采集任务')
    const [bounds, setBounds] = useState<Bounds>(EMPTY_BOUNDS)
    const [selectionMode, setSelectionMode] = useState<'draw' | 'region'>('draw')
    const [selectedRegionCode, setSelectedRegionCode] = useState<string | null>(null)
    const [gridStep, setGridStep] = useState(0.2)
    const [includeHydro, setIncludeHydro] = useState(true)
    const [includeFences, setIncludeFences] = useState(true)
    const [chartLayerSet, setChartLayerSet] = useState<Set<string>>(() => new Set(['yizhangtu']))
    const [zoomSet, setZoomSet] = useState<Set<number>>(() => new Set([4, 5, 6, 7, 8, 9, 10]))
    const [outputPath, setOutputPath] = useState('')
    const [tileEstimate, setTileEstimate] = useState<ChartTileEstimate | null>(null)
    const [featureCount, setFeatureCount] = useState(0)
    const [status, setStatus] = useState<'idle' | 'running'>('idle')
    const [progress, setProgress] = useState<ChartProgress | null>(null)

    const hasBounds = validBounds(bounds)
    const chartLayers = useMemo(() => Array.from(chartLayerSet), [chartLayerSet])
    const zoomLevels = useMemo(() => Array.from(zoomSet).sort((a, b) => a - b), [zoomSet])
    const vectorSourceCount = (includeHydro ? 1 : 0) + (includeFences ? 1 : 0)
    const sourceCount = vectorSourceCount + chartLayers.length
    const gridX = hasBounds ? Math.ceil((bounds.east - bounds.west) / gridStep) : 0
    const gridY = hasBounds ? Math.ceil((bounds.north - bounds.south) / gridStep) : 0
    const gridCells = gridX * gridY
    const estimatedFeatureRequests = gridCells * vectorSourceCount
    const estimatedTileRequests = tileEstimate?.total_with_layers ?? 0
    const estimatedRequests = estimatedFeatureRequests + estimatedTileRequests
    const rangeLabel = useMemo(() => hasBounds ? formatBounds(bounds) : '请先框选范围或选择行政区', [bounds, hasBounds])
    const previewMapType = chartLayerSet.has('yizhangtu')
        ? 'street'
        : chartLayerSet.has('cjshoudong')
            ? 'satellite'
            : chartLayerSet.has('soundg')
                ? 'terrain'
                : 'street'

    useEffect(() => {
        const load = async () => {
            try {
                setFeatureCount(await invoke<number>('chart_get_feature_count'))
            } catch { /* ignore */ }
        }
        load()
        const unlisten = listen<ChartProgress>('chart-progress', e => {
            const p = e.payload
            if (p.task_type !== 'feature' && p.task_type !== 'tile') return
            setProgress(p)
            if (p.status === 'completed') {
                setStatus('idle')
                load()
            } else if (p.status === 'running' || p.status === 'collecting') {
                setStatus('running')
            }
        })
        return () => { unlisten.then(fn => fn()) }
    }, [])

    useEffect(() => {
        if (!hasBounds || chartLayers.length === 0 || zoomLevels.length === 0) {
            setTileEstimate(null)
            return
        }
        invoke<ChartTileEstimate>('chart_estimate_tiles', {
            west: bounds.west,
            south: bounds.south,
            east: bounds.east,
            north: bounds.north,
            zoomLevels,
            layers: chartLayers,
        })
            .then(setTileEstimate)
            .catch(() => setTileEstimate(null))
    }, [bounds, chartLayers, hasBounds, zoomLevels])

    const toggleChartLayer = (id: string) => {
        setChartLayerSet(prev => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    const toggleZoom = (z: number) => {
        setZoomSet(prev => {
            const next = new Set(prev)
            if (next.has(z)) next.delete(z)
            else next.add(z)
            return next
        })
    }

    const presetActive = (range: [number, number]) => {
        for (let z = range[0]; z <= range[1]; z++) {
            if (!zoomSet.has(z)) return false
        }
        return true
    }

    const togglePreset = (range: [number, number]) => {
        setZoomSet(prev => {
            const next = new Set(prev)
            const active = presetActive(range)
            for (let z = range[0]; z <= range[1]; z++) {
                if (active) next.delete(z)
                else next.add(z)
            }
            return next
        })
    }

    const pickOutputDir = async () => {
        try {
            const picked = await openDialog({
                multiple: false,
                directory: true,
                title: '选择航道图覆盖层保存目录',
            })
            if (typeof picked === 'string') setOutputPath(picked)
        } catch { /* user cancelled */ }
    }

    const start = async () => {
        if (!hasBounds) {
            warning('未选择范围', '请先绘制采集范围，或搜索并选择行政区划')
            return
        }
        if (sourceCount === 0) {
            warning('未选择内容', '请至少选择水域面、航道要素或一个航道图覆盖层')
            return
        }
        if (chartLayers.length > 0 && zoomLevels.length === 0) {
            warning('未选择层级', '下载航道图覆盖层时请至少选择一个层级')
            return
        }
        if (chartLayers.length > 0 && !outputPath.trim()) {
            warning('未选择保存目录', '下载航道图覆盖层时请先选择瓦片保存目录')
            return
        }

        try {
            setStatus('running')
            await invoke('chart_start_feature_collection', {
                west: bounds.west,
                south: bounds.south,
                east: bounds.east,
                north: bounds.north,
                gridStep,
                includeFences,
                includeHydro,
                layers: chartLayers,
                zoomLevels,
                outputPath: chartLayers.length > 0 ? outputPath.trim() : null,
                taskName: taskName.trim() || '航道图专题采集任务',
            })
            success('航道图专题采集已启动', `${taskName || '未命名任务'} · 约 ${estimatedRequests.toLocaleString()} 个项目`)
        } catch (e) {
            setStatus('idle')
            errorToast('启动失败', String(e))
        }
    }

    const stop = async () => {
        try {
            await invoke('chart_stop_collection')
            setStatus('idle')
            success('已停止', '航道图专题采集已停止')
        } catch (e) {
            errorToast('停止失败', String(e))
        }
    }

    return (
        <div className="nc-create-shell">
            <div className="td-layout">
                <div className="td-form">
                    <div className="td-block">
                        <div className="td-block-title"><span className="step-no">1</span>基础</div>
                        <div className="field-row">
                            <label className="field-label">任务名称</label>
                            <input
                                className="input"
                                value={taskName}
                                onChange={e => setTaskName(e.target.value)}
                            />
                        </div>
                        <div className="field-row" style={{ marginTop: 10 }}>
                            <label className="field-label">覆盖层保存目录</label>
                            <div style={{ display: 'flex', gap: 8 }}>
                                <input
                                    className="input mono"
                                    value={outputPath}
                                    onChange={e => setOutputPath(e.target.value)}
                                    placeholder={chartLayers.length > 0 ? '请选择瓦片覆盖层保存目录' : '未选择瓦片覆盖层时无需填写'}
                                    disabled={chartLayers.length === 0}
                                    style={{ flex: 1 }}
                                />
                                <button
                                    type="button"
                                    className="btn"
                                    onClick={pickOutputDir}
                                    disabled={chartLayers.length === 0}
                                >
                                    <GcIcon name="folder" size={13} />选择
                                </button>
                            </div>
                            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-3)', lineHeight: 1.5 }}>
                                瓦片覆盖层会持久化到该目录；水域面和航道要素保存到本地数据库，后续在数据中心导出。
                            </div>
                        </div>
                    </div>

                    <div className="td-block">
                        <div className="td-block-title"><span className="step-no">2</span>采集范围</div>
                        <div className="aton-coords mono">
                            <span>{selectionMode === 'draw' ? '框选范围' : '行政区范围'}</span>
                            <span>{rangeLabel}</span>
                        </div>
                        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-3)', lineHeight: 1.5 }}>
                            右侧地图支持手动绘制矩形，也可以搜索省、市、区县后自动提取行政区边界范围。
                        </div>
                    </div>

                    <div className="td-block">
                        <div className="td-block-title"><span className="step-no">3</span>采集内容</div>
                        <div className="lab-tiny" style={{ marginBottom: 6 }}>矢量要素</div>
                        <div className="step-grid">
                            <label
                                className={`step-opt${includeHydro ? ' active' : ''}`}
                                onClick={() => setIncludeHydro(v => !v)}
                            >
                                <span className="step-radio">{includeHydro && <i />}</span>
                                <div>
                                    <div className="step-label">HYDRO_A 水域面</div>
                                    <div className="step-desc">水域 / 深度面，多边形数据</div>
                                </div>
                                <span className="mono step-cost">polygon</span>
                            </label>
                            <label
                                className={`step-opt${includeFences ? ' active' : ''}`}
                                onClick={() => setIncludeFences(v => !v)}
                            >
                                <span className="step-radio">{includeFences && <i />}</span>
                                <div>
                                    <div className="step-label">航道要素</div>
                                    <div className="step-desc">电子围栏 / 报告线 / 卡口</div>
                                </div>
                                <span className="mono step-cost">feature</span>
                            </label>
                        </div>
                        <div className="lab-tiny" style={{ marginTop: 12, marginBottom: 6 }}>瓦片覆盖层</div>
                        <div className="step-grid">
                            {RASTER_LAYERS.map(layer => (
                                <label
                                    key={layer.id}
                                    className={`step-opt${chartLayerSet.has(layer.id) ? ' active' : ''}`}
                                    onClick={() => toggleChartLayer(layer.id)}
                                >
                                    <span className="step-radio">{chartLayerSet.has(layer.id) && <i />}</span>
                                    <div>
                                        <div className="step-label">{layer.label}</div>
                                        <div className="step-desc">{layer.desc}</div>
                                    </div>
                                    <span className="mono step-cost">tile</span>
                                </label>
                            ))}
                        </div>
                    </div>

                    <div className="td-block">
                        <div className="td-block-title"><span className="step-no">4</span>要素网格步长</div>
                        <div className="step-grid">
                            {STEP_OPTIONS.map(opt => (
                                <label
                                    key={opt.v}
                                    className={`step-opt${gridStep === opt.v ? ' active' : ''}`}
                                    onClick={() => setGridStep(opt.v)}
                                >
                                    <span className="step-radio">{gridStep === opt.v && <i />}</span>
                                    <div>
                                        <div className="step-label">{opt.label}</div>
                                        <div className="step-desc">{opt.desc}</div>
                                    </div>
                                    <span className="mono step-cost">{opt.relCost}</span>
                                </label>
                            ))}
                        </div>
                        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-3)', lineHeight: 1.5 }}>
                            步长越小覆盖越精细，但请求数会按网格数量增长。行政区范围较大时建议先用 0.2° 试采。
                        </div>
                    </div>

                    <div className="td-block">
                        <div className="td-block-title">
                            <span className="step-no">5</span>覆盖层级
                            <span className="mono" style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--text-3)' }}>
                                {zoomLevels.length > 0 ? `z${zoomLevels[0]}–z${zoomLevels[zoomLevels.length - 1]}` : '未选择'}
                            </span>
                        </div>
                        <div className="preset-row">
                            {ZOOM_PRESETS.map(p => (
                                <button
                                    key={p.label}
                                    type="button"
                                    className={`preset-chip${presetActive(p.range) ? ' active' : ''}`}
                                    onClick={() => togglePreset(p.range)}
                                >
                                    {p.label}
                                    <span className="pc-range">z{p.range[0]}–z{p.range[1]}</span>
                                </button>
                            ))}
                        </div>
                        <div className="field-chips" style={{ marginTop: 8 }}>
                            {Array.from({ length: 10 }, (_, i) => i + 4).map(z => (
                                <button
                                    key={z}
                                    type="button"
                                    className={`field-chip${zoomSet.has(z) ? ' on' : ''}`}
                                    onClick={() => toggleZoom(z)}
                                >
                                    z{z}
                                </button>
                            ))}
                        </div>
                        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-3)', lineHeight: 1.5 }}>
                            航道图覆盖层为 ArcGIS 4326 切片，范围较大时建议先下载 z4–z10。
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

                    <div className="panel sub">
                        <div className="panel-head"><h3>配置概要</h3></div>
                        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
                            <div>
                                <div className="lab-tiny">扫描网格</div>
                                <div className="big-num">{gridCells.toLocaleString() || '—'}</div>
                                <div className="mono small-meta">
                                    {hasBounds ? `${gridX} x ${gridY} 格 · 要素步长 ${gridStep}°` : '请先选择范围'}
                                </div>
                            </div>
                            <div className="divider" style={{ margin: 0 }} />
                            <div>
                                <div className="lab-tiny">预计任务量</div>
                                <div className="big-num">{estimatedRequests.toLocaleString()}</div>
                                <div className="mono small-meta">
                                    要素 {estimatedFeatureRequests.toLocaleString()} · 瓦片 {estimatedTileRequests.toLocaleString()}
                                </div>
                            </div>
                            <div className="divider" style={{ margin: 0 }} />
                            <div>
                                <div className="lab-tiny">已选内容</div>
                                <div className="big-num">{sourceCount}</div>
                                <div className="mono small-meta">
                                    矢量 {vectorSourceCount} 类 · 覆盖层 {chartLayers.length} 类
                                </div>
                            </div>
                            <div className="divider" style={{ margin: 0 }} />
                            <div>
                                <div className="lab-tiny">已采要素总数</div>
                                <div className="big-num">{featureCount.toLocaleString()}</div>
                                <div className="mono small-meta">来源：feature / HYDRO_A</div>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="td-map-wrap">
                    <TileBoundsMap
                        platform="cjhy"
                        mapType={previewMapType}
                        minZoom={0}
                        maxZoom={13}
                        bounds={bounds}
                        onBoundsChange={setBounds}
                        selectedRegionCode={selectedRegionCode}
                        onSelectedRegionCodeChange={setSelectedRegionCode}
                        selectionMode={selectionMode}
                        onSelectionModeChange={setSelectionMode}
                    />
                </div>
            </div>

            <div className="td-footer">
                <div style={{ flex: 1 }} />
                {status === 'running' ? (
                    <button type="button" className="btn danger" onClick={stop}>
                        <GcIcon name="stop" size={13} />停止采集
                    </button>
                ) : (
                    <button
                        type="button"
                        className="btn primary"
                        onClick={start}
                        disabled={!hasBounds || sourceCount === 0 || (chartLayers.length > 0 && !outputPath.trim())}
                    >
                        <GcIcon name="play" size={13} />开始航道图专题采集
                    </button>
                )}
            </div>
        </div>
    )
}
