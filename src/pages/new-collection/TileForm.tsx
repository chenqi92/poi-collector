import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { TileBoundsMap } from '@/components/TileBoundsMap'
import { GcIcon } from '@/components/shell'
import { useToast } from '@/components/ui/toast'

interface Bounds {
    north: number
    south: number
    east: number
    west: number
}

interface PlatformInfo {
    id: string
    name: string
    enabled: boolean
    min_zoom: number
    max_zoom: number
    map_types: string[]
    requires_key: boolean
    crs_info: string
}

interface TileEstimate {
    total_tiles: number
    tiles_per_level: [number, number][]
    estimated_size_mb: number
}

interface ApiKey {
    id: number
    api_key: string
    name?: string | null
}

const MAP_TYPE_LABEL: Record<string, string> = {
    street: '街道图',
    satellite: '影像图',
    terrain: '地形图',
    vector: '矢量底图',
    image: '影像',
    annotation: '注记',
}

const OUTPUT_FORMATS: { id: string; label: string; ext: string }[] = [
    { id: 'folder', label: '目录 (XYZ)', ext: '' },
    { id: 'zip', label: 'ZIP (XYZ)', ext: 'zip' },
    { id: 'mbtiles', label: 'MBTiles', ext: 'mbtiles' },
]

const ZOOM_PRESETS: { label: string; range: [number, number] }[] = [
    { label: '概览', range: [0, 6] },
    { label: '城市', range: [10, 14] },
    { label: '街道', range: [12, 16] },
    { label: '细节', range: [15, 18] },
]

export function TileForm() {
    const navigate = useNavigate()
    const { success, error: errorToast, warning } = useToast()

    const [platforms, setPlatforms] = useState<PlatformInfo[]>([])
    const [apiKeys, setApiKeys] = useState<Record<string, ApiKey[]>>({})
    const [platform, setPlatform] = useState('osm')
    const [mapType, setMapType] = useState('street')
    const [taskName, setTaskName] = useState('未命名瓦片任务')
    const [bounds, setBounds] = useState<Bounds>({ north: 0, south: 0, east: 0, west: 0 })
    const [selectionMode, setSelectionMode] = useState<'draw' | 'region'>('draw')
    const [selectedRegionCode, setSelectedRegionCode] = useState<string | null>(null)
    // 缩放级用集合表示，支持任意（含不连续）多选
    const [zoomSet, setZoomSet] = useState<Set<number>>(() => new Set([10, 11, 12, 13, 14]))
    const [threadCount, setThreadCount] = useState(8)
    const [outputFormat, setOutputFormat] = useState<string>('folder')
    const [apiKeyInput, setApiKeyInput] = useState('')
    const [estimate, setEstimate] = useState<TileEstimate | null>(null)
    const [submitting, setSubmitting] = useState(false)

    useEffect(() => {
        const load = async () => {
            try {
                const [pInfos, keys] = await Promise.all([
                    invoke<PlatformInfo[]>('get_tile_platforms'),
                    invoke<Record<string, ApiKey[]>>('get_api_keys'),
                ])
                setPlatforms(pInfos.filter(p => p.enabled))
                setApiKeys(keys)
            } catch (e) {
                console.error(e)
            }
        }
        load()
    }, [])

    const currentPlatform = useMemo(
        () => platforms.find(p => p.id === platform),
        [platforms, platform]
    )

    // Adjust mapType / zoom range when platform changes
    useEffect(() => {
        if (!currentPlatform) return
        if (!currentPlatform.map_types.includes(mapType)) {
            setMapType(currentPlatform.map_types[0] ?? 'street')
        }
        // 平台切换后把超出该平台缩放范围的级别裁掉；若全被裁掉则回落到默认范围
        const lo = currentPlatform.min_zoom
        const hi = currentPlatform.max_zoom
        setZoomSet(prev => {
            const next = new Set([...prev].filter(z => z >= lo && z <= hi))
            if (next.size === 0) {
                for (let z = Math.max(lo, 10); z <= Math.min(hi, 14); z++) next.add(z)
                if (next.size === 0) next.add(lo)
            }
            return next
        })
        const keys = apiKeys[platform] ?? []
        if (currentPlatform.requires_key && keys.length > 0 && !apiKeyInput) {
            setApiKeyInput(keys[0].api_key)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [platform, currentPlatform, apiKeys])

    const zoomLevels = useMemo(() => Array.from(zoomSet).sort((a, b) => a - b), [zoomSet])
    const zMin = zoomLevels[0] ?? 0
    const zMax = zoomLevels[zoomLevels.length - 1] ?? 0

    const availableLevels = useMemo(() => {
        const lo = currentPlatform?.min_zoom ?? 0
        const hi = currentPlatform?.max_zoom ?? 18
        const out: number[] = []
        for (let z = lo; z <= hi; z++) out.push(z)
        return out
    }, [currentPlatform])

    const toggleLevel = (z: number) => setZoomSet(prev => {
        const n = new Set(prev)
        if (n.has(z)) n.delete(z); else n.add(z)
        return n
    })

    const presetRangeLevels = (range: [number, number]) => {
        const lo = Math.max(range[0], currentPlatform?.min_zoom ?? 0)
        const hi = Math.min(range[1], currentPlatform?.max_zoom ?? 18)
        const out: number[] = []
        for (let z = lo; z <= hi; z++) out.push(z)
        return out
    }
    const presetActive = (range: [number, number]) => {
        const lv = presetRangeLevels(range)
        return lv.length > 0 && lv.every(z => zoomSet.has(z))
    }
    const togglePreset = (range: [number, number]) => setZoomSet(prev => {
        const lv = presetRangeLevels(range)
        if (lv.length === 0) return prev
        const allIn = lv.every(z => prev.has(z))
        const n = new Set(prev)
        if (allIn) lv.forEach(z => n.delete(z))
        else lv.forEach(z => n.add(z))
        return n
    })

    // Estimate
    useEffect(() => {
        const valid = bounds.north > bounds.south && bounds.east > bounds.west && zoomLevels.length > 0
        if (!valid) {
            setEstimate(null)
            return
        }
        invoke<TileEstimate>('calculate_tiles_count', { bounds, zoomLevels, platform })
            .then(setEstimate)
            .catch(() => setEstimate(null))
    }, [bounds, zoomLevels, platform])

    const submit = async () => {
        if (!taskName.trim()) {
            warning('请填写任务名称', '')
            return
        }
        if (!(bounds.north > bounds.south && bounds.east > bounds.west)) {
            warning('未选择下载区域', '请在右侧地图上画矩形或选择行政区域')
            return
        }
        if (currentPlatform?.requires_key && !apiKeyInput.trim()) {
            warning('需要 API Key', `${currentPlatform.name} 平台需要 API Key`)
            return
        }

        setSubmitting(true)
        try {
            const ext = OUTPUT_FORMATS.find(f => f.id === outputFormat)?.ext ?? ''
            const outputPath = outputFormat === 'folder'
                ? await save({ title: '选择保存位置', defaultPath: taskName })
                : await save({
                    title: '选择保存位置',
                    defaultPath: `${taskName}.${ext}`,
                    filters: [{ name: '瓦片文件', extensions: [ext] }],
                })
            if (!outputPath) { setSubmitting(false); return }

            const taskId = await invoke<string>('create_tile_task', {
                config: {
                    name: taskName,
                    platform,
                    map_type: mapType,
                    bounds,
                    zoom_levels: zoomLevels,
                    output_path: outputPath,
                    output_format: outputFormat,
                    thread_count: threadCount,
                    retry_count: 3,
                    api_key: apiKeyInput.trim() || null,
                },
            })

            try {
                await invoke('start_tile_download', { taskId })
            } catch (e) { console.warn('自动启动失败', e) }

            success('任务已创建', `${taskName} 已加入下载队列`)
            navigate('/new?sub=active')
        } catch (e) {
            errorToast('创建失败', String(e))
        } finally {
            setSubmitting(false)
        }
    }

    const isWarn = (estimate?.total_tiles ?? 0) > 200_000
    const isCrit = (estimate?.total_tiles ?? 0) > 1_000_000

    return (
        <div className="nc-create-shell">
            <div className="td-layout">
                {/* Left: form */}
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
                    </div>

                    <div className="td-block">
                        <div className="td-block-title"><span className="step-no">2</span>平台与图层</div>
                        <div className="td-field-grid">
                            <div className="field-row">
                                <label className="field-label">地图平台</label>
                                <select
                                    className="select"
                                    value={platform}
                                    onChange={e => setPlatform(e.target.value)}
                                >
                                    {platforms.map(p => (
                                        <option key={p.id} value={p.id}>{p.name}</option>
                                    ))}
                                </select>
                            </div>
                            <div className="field-row">
                                <label className="field-label">图层类型</label>
                                <select
                                    className="select"
                                    value={mapType}
                                    onChange={e => setMapType(e.target.value)}
                                >
                                    {currentPlatform?.map_types.map(t => (
                                        <option key={t} value={t}>
                                            {MAP_TYPE_LABEL[t] ?? t}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>
                        {currentPlatform?.requires_key && (
                            <div className="field-row" style={{ marginTop: 8 }}>
                                <label className="field-label">API Key</label>
                                <input
                                    className="input mono"
                                    value={apiKeyInput}
                                    onChange={e => setApiKeyInput(e.target.value)}
                                    placeholder="粘贴 API Key 或从设置选择"
                                    style={{ fontSize: 11.5 }}
                                />
                                {(apiKeys[platform]?.length ?? 0) === 0 && (
                                    <div className="quota-warn" style={{ marginTop: 6 }}>
                                        <GcIcon name="alertTriangle" size={11} />
                                        <span>
                                            未在设置中保存该平台的 Key，可
                                            <a
                                                style={{
                                                    color: 'var(--accent)',
                                                    textDecoration: 'underline',
                                                    cursor: 'pointer',
                                                    marginLeft: 2,
                                                }}
                                                onClick={() => navigate('/settings?tab=keys')}
                                            >
                                                去添加
                                            </a>
                                        </span>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    <div className="td-block">
                        <div className="td-block-title"><span className="step-no">3</span>下载区域</div>
                        <div className="seg" style={{ width: '100%', marginBottom: 8 }}>
                            <button
                                type="button"
                                className={selectionMode === 'draw' ? 'active' : ''}
                                onClick={() => setSelectionMode('draw')}
                                style={{ flex: 1 }}
                            >
                                地图画框
                            </button>
                            <button
                                type="button"
                                className={selectionMode === 'region' ? 'active' : ''}
                                onClick={() => setSelectionMode('region')}
                                style={{ flex: 1 }}
                            >
                                按行政区
                            </button>
                        </div>
                        {bounds.north > bounds.south && bounds.east > bounds.west ? (
                            <div className="aton-coords mono">
                                <span>已选范围</span>
                                <span>
                                    SW {bounds.south.toFixed(4)}, {bounds.west.toFixed(4)}
                                    {' → '}
                                    NE {bounds.north.toFixed(4)}, {bounds.east.toFixed(4)}
                                </span>
                            </div>
                        ) : (
                            <div className="aton-coords mono">
                                <span>未选择</span>
                                <span>在右侧地图上拖动绘制矩形</span>
                            </div>
                        )}
                    </div>

                    <div className="td-block">
                        <div className="td-block-title">
                            <span className="step-no">4</span>缩放范围
                            <span
                                style={{
                                    marginLeft: 'auto',
                                    fontSize: 10.5,
                                    color: 'var(--text-3)',
                                    textTransform: 'none',
                                    letterSpacing: 0,
                                    fontWeight: 500,
                                }}
                                className="mono"
                            >
                                {zoomLevels.length > 0 ? `${zoomLevels.length} 级 · z${zMin}–z${zMax}` : '未选择'}
                            </span>
                        </div>
                        {/* 预设：可多选叠加（点击切换该区间所有级别） */}
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
                        {/* 单级多选：任意勾选，可不连续 */}
                        <div className="field-chips" style={{ marginTop: 8 }}>
                            {availableLevels.map(z => (
                                <button
                                    key={z}
                                    type="button"
                                    className={`field-chip${zoomSet.has(z) ? ' on' : ''}`}
                                    onClick={() => toggleLevel(z)}
                                >
                                    z{z}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="td-block">
                        <div className="td-block-title"><span className="step-no">5</span>输出与并发</div>
                        <div className="field-row">
                            <label className="field-label">输出格式</label>
                            <div className="seg" style={{ width: '100%' }}>
                                {OUTPUT_FORMATS.map(f => (
                                    <button
                                        key={f.id}
                                        type="button"
                                        className={outputFormat === f.id ? 'active' : ''}
                                        onClick={() => setOutputFormat(f.id)}
                                        style={{ flex: 1 }}
                                    >
                                        {f.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="field-row" style={{ marginTop: 8 }}>
                            <label className="field-label">
                                并发线程 <span className="hint">建议 4–12</span>
                            </label>
                            <input
                                className="input"
                                type="number"
                                min={1}
                                max={32}
                                value={threadCount}
                                onChange={e => setThreadCount(+e.target.value)}
                            />
                        </div>
                    </div>
                </div>

                {/* Right: map */}
                <div className="td-map-wrap">
                    <TileBoundsMap
                        platform={platform}
                        mapType={mapType}
                        apiKey={apiKeyInput || undefined}
                        bounds={bounds}
                        onBoundsChange={setBounds}
                        selectedRegionCode={selectedRegionCode}
                        onSelectedRegionCodeChange={setSelectedRegionCode}
                        selectionMode={selectionMode}
                        onSelectionModeChange={setSelectionMode}
                    />
                </div>
            </div>

            {/* Bottom: estimate + actions */}
            <div className="td-footer" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }}>
                <div className="td-estimate">
                    <div className={`td-estimate-cell${isCrit ? ' crit' : isWarn ? ' warn' : ''}`}>
                        <div className="lab">瓦片总数</div>
                        <div className="val">
                            {estimate ? estimate.total_tiles.toLocaleString() : '—'}
                        </div>
                        <div className="sub">
                            {zoomLevels.length} 级缩放
                        </div>
                    </div>
                    <div className={`td-estimate-cell${isCrit ? ' crit' : isWarn ? ' warn' : ''}`}>
                        <div className="lab">预估大小</div>
                        <div className="val">
                            {estimate ? `${estimate.estimated_size_mb.toFixed(1)} MB` : '—'}
                        </div>
                        <div className="sub">后端基于平台经验值估算</div>
                    </div>
                    <div className="td-estimate-cell">
                        <div className="lab">并发</div>
                        <div className="val">{threadCount}</div>
                        <div className="sub">线程</div>
                    </div>
                </div>

                {isCrit && (
                    <div className="quota-warn">
                        <GcIcon name="alertTriangle" size={11} />
                        <span>
                            瓦片数过大（&gt; 100 万），下载可能耗时数小时且占用磁盘较多。
                            建议缩小区域或降低最大缩放级。
                        </span>
                    </div>
                )}

                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <div style={{ flex: 1 }} />
                    <button
                        type="button"
                        className="btn primary"
                        onClick={submit}
                        disabled={submitting || !estimate || estimate.total_tiles === 0}
                    >
                        <GcIcon name="download" size={13} />
                        {submitting ? '创建中...' : '创建任务并开始'}
                    </button>
                </div>
            </div>
        </div>
    )
}
