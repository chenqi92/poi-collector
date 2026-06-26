// AIS 航迹浏览：左控制栏（连接 / 时间 / 船只 / 水域过滤 / 底图 / 停泊参数）+ 右地图。
// 两种数据模式：
//  - fields：结构化字段，服务端聚合列船 + 按船查询航迹。
//  - raw：原始 AIVDM 报文，MMSI/经纬度藏在报文里无法服务端聚合 →
//         「拉取并解码」一个时间窗，前端按 MMSI 分组列船、按船过滤出航迹。
// 过滤在 WGS-84 下做点在多边形判断；渲染时按底图坐标系纠偏。

import { useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import { invoke } from '@tauri-apps/api/core'
import 'leaflet/dist/leaflet.css'
import { CachedOsmTileLayer } from '@/components/CachedOsmTileLayer'
import { GcIcon } from '@/components/shell'
import { AisRouteLayer } from '@/components/ais/AisRouteLayer'
import { aisGetShipRoute, aisListShips, aisPullWindow } from '@/lib/ais/api'
import type { AisPoint, BaseCrs, EsConnection, ShipSummary, TrajParams } from '@/lib/ais/types'
import { cleanTrack, DEFAULT_TRAJ, type Segment, segmentTrips } from '@/lib/ais/trajectory'
import { geometryToPolygons, outermostPolygons, pointInWater, type WaterPolygon } from '@/lib/ais/geo'
import { normalizeToWgs84 } from '@/lib/ais/coords'

const AMAP_STREET_URL =
    'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}'
const AMAP_SUBDOMAINS = ['1', '2', '3', '4']

type WaterLayerKey = 'none' | 'electronic_fence' | 'HYDRO_A'

const WATER_OPTIONS: { key: WaterLayerKey; label: string; kind: 'fence' | 'hydro' }[] = [
    { key: 'none', label: '不使用水域图', kind: 'hydro' },
    { key: 'HYDRO_A', label: '水域面 (HYDRO_A)', kind: 'hydro' },
    { key: 'electronic_fence', label: '电子围栏', kind: 'fence' },
]

interface ChartFeatureLite {
    geometry_json: string
}

interface ChartTaskLite {
    id: string
    name: string
    bounds_north: number
    bounds_south: number
    bounds_east: number
    bounds_west: number
}

interface PullStats {
    scanned: number
    decoded: number
    ships: number
    truncated: boolean
}

function MapAutosize() {
    const map = useMap()
    useEffect(() => {
        const el = map.getContainer()
        const ro = new ResizeObserver(() => map.invalidateSize())
        ro.observe(el)
        const t = setTimeout(() => map.invalidateSize(), 120)
        return () => {
            ro.disconnect()
            clearTimeout(t)
        }
    }, [map])
    return null
}

function fmtTs(ms?: number): string {
    if (!ms) return '-'
    try {
        return new Date(ms).toLocaleString('zh-CN', { hour12: false })
    } catch {
        return String(ms)
    }
}

function toMs(local: string): number | undefined {
    if (!local) return undefined
    const t = new Date(local).getTime()
    return Number.isFinite(t) ? t : undefined
}

interface Props {
    conn: EsConnection | null
    connections: EsConnection[]
    connId: string
    onConnId: (id: string) => void
    onGoConnections: () => void
}

export function AisMapView({ conn, connections, connId, onConnId, onGoConnections }: Props) {
    const mode = conn?.dataMode ?? 'fields'

    // 选择 / 搜索 / 时间
    const [selectedMmsi, setSelectedMmsi] = useState('')
    const [shipSearch, setShipSearch] = useState('')
    const [timeFrom, setTimeFrom] = useState('')
    const [timeTo, setTimeTo] = useState('')

    // fields 模式：服务端列船 + 按船查询航迹
    const [fetchedShips, setFetchedShips] = useState<ShipSummary[]>([])
    const [shipsLoading, setShipsLoading] = useState(false)
    const [shipError, setShipError] = useState('')
    const [routePoints, setRoutePoints] = useState<AisPoint[]>([])
    const [routeLoading, setRouteLoading] = useState(false)
    const [routeError, setRouteError] = useState('')
    const [routeTotal, setRouteTotal] = useState(0)
    const [routeTruncated, setRouteTruncated] = useState(false)

    // raw 模式：拉取并解码一个时间窗
    const [pulled, setPulled] = useState<AisPoint[]>([])
    const [pulling, setPulling] = useState(false)
    const [pullError, setPullError] = useState('')
    const [pullStats, setPullStats] = useState<PullStats | null>(null)
    const [maxPoints, setMaxPoints] = useState(50000)

    // 水域过滤
    const [waterLayer, setWaterLayer] = useState<WaterLayerKey>('none')
    const [waterPolys, setWaterPolys] = useState<WaterPolygon[]>([])
    const [waterLoading, setWaterLoading] = useState(false)
    const [filterOn, setFilterOn] = useState(false)
    const [onlyOutermost, setOnlyOutermost] = useState(true)
    const [waterTasks, setWaterTasks] = useState<ChartTaskLite[]>([])
    const [waterTaskId, setWaterTaskId] = useState('')

    // 底图 / 渲染
    const [baseCrs, setBaseCrs] = useState<BaseCrs>('wgs84')
    const [showRawAnchored, setShowRawAnchored] = useState(false)
    const [traj, setTraj] = useState<TrajParams>(DEFAULT_TRAJ)

    // 连接切换时重置
    useEffect(() => {
        setFetchedShips([])
        setSelectedMmsi('')
        setRoutePoints([])
        setRouteTotal(0)
        setRouteTruncated(false)
        setPulled([])
        setPullStats(null)
        setPullError('')
        const tp = conn?.trajectoryParams
        setTraj({ ...DEFAULT_TRAJ, ...(tp && typeof tp === 'object' ? tp : {}) })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connId])

    const anchoredValues = conn?.fieldMapping.navStatusAnchored ?? []
    const sourceCrs = conn?.sourceCrs ?? 'wgs84'

    // —— fields 模式：列船 ——
    const loadShips = async () => {
        if (!connId) return
        setShipsLoading(true)
        setShipError('')
        try {
            const list = await aisListShips({
                connId,
                timeFrom: toMs(timeFrom),
                timeTo: toMs(timeTo),
                limit: 500,
            })
            setFetchedShips(list)
        } catch (e) {
            setShipError(String(e))
            setFetchedShips([])
        } finally {
            setShipsLoading(false)
        }
    }

    useEffect(() => {
        if (mode === 'fields' && connId) loadShips()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, connId, timeFrom, timeTo])

    // —— fields 模式：按船查询航迹 ——
    useEffect(() => {
        if (mode !== 'fields' || !connId || !selectedMmsi) {
            setRoutePoints([])
            return
        }
        let cancelled = false
        setRouteLoading(true)
        setRouteError('')
        aisGetShipRoute({
            connId,
            mmsi: selectedMmsi,
            timeFrom: toMs(timeFrom),
            timeTo: toMs(timeTo),
        })
            .then((resp) => {
                if (cancelled) return
                const pts = resp.points.map((p) => {
                    const [lon, lat] = normalizeToWgs84(sourceCrs, p.lon, p.lat)
                    return { ...p, lon, lat }
                })
                setRoutePoints(pts)
                setRouteTotal(resp.total)
                setRouteTruncated(resp.truncated)
            })
            .catch((e) => {
                if (cancelled) return
                setRouteError(String(e))
                setRoutePoints([])
            })
            .finally(() => {
                if (!cancelled) setRouteLoading(false)
            })
        return () => {
            cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, connId, selectedMmsi, timeFrom, timeTo, sourceCrs])

    // —— raw 模式：拉取并解码 ——
    const doPull = async () => {
        if (!connId) return
        setPulling(true)
        setPullError('')
        setSelectedMmsi('')
        try {
            const r = await aisPullWindow({
                connId,
                timeFrom: toMs(timeFrom),
                timeTo: toMs(timeTo),
                maxPoints,
            })
            setPulled(r.points)
            setPullStats({
                scanned: r.scanned,
                decoded: r.decoded,
                ships: r.ships,
                truncated: r.truncated,
            })
        } catch (e) {
            setPullError(String(e))
            setPulled([])
            setPullStats(null)
        } finally {
            setPulling(false)
        }
    }

    // raw 模式：按 MMSI 分组成船列表
    const rawShips: ShipSummary[] = useMemo(() => {
        if (mode !== 'raw') return []
        const map = new Map<string, { name?: string; count: number; first: number; last: number }>()
        for (const p of pulled) {
            const e = map.get(p.mmsi)
            if (!e) {
                map.set(p.mmsi, { name: p.name, count: 1, first: p.ts, last: p.ts })
            } else {
                e.count++
                if (p.name && !e.name) e.name = p.name
                if (p.ts < e.first) e.first = p.ts
                if (p.ts > e.last) e.last = p.ts
            }
        }
        const arr: ShipSummary[] = []
        for (const [mmsi, e] of map) {
            arr.push({ mmsi, name: e.name, count: e.count, firstTs: e.first, lastTs: e.last })
        }
        arr.sort((a, b) => b.count - a.count)
        return arr
    }, [mode, pulled])

    // raw 模式：所选船的点（归一化到 WGS-84）
    const rawPoints: AisPoint[] = useMemo(() => {
        if (mode !== 'raw' || !selectedMmsi) return []
        return pulled
            .filter((p) => p.mmsi === selectedMmsi)
            .map((p) => {
                const [lon, lat] = normalizeToWgs84(sourceCrs, p.lon, p.lat)
                return { ...p, lon, lat }
            })
    }, [mode, pulled, selectedMmsi, sourceCrs])

    const ships = mode === 'raw' ? rawShips : fetchedShips
    const rawWgsPoints = mode === 'raw' ? rawPoints : routePoints

    // 数据清洗：去重复/跳点 + 按大跳变/长静默切航次（解决 GPS 跳点与 MMSI 串号拼接）
    const cleaned = useMemo(
        () => cleanTrack(rawWgsPoints, { maxJumpKn: traj.maxJumpKn, tripGapMinutes: traj.tripGapMinutes }),
        [rawWgsPoints, traj.maxJumpKn, traj.tripGapMinutes],
    )
    const wgsPoints = cleaned.points

    // 航道任务（用于把水域面限定到某任务区域）
    useEffect(() => {
        invoke<ChartTaskLite[]>('chart_get_display_tasks')
            .then((ts) =>
                setWaterTasks(
                    ts.filter((t) => t.bounds_north > t.bounds_south && t.bounds_east > t.bounds_west),
                ),
            )
            .catch(() => setWaterTasks([]))
    }, [])

    // 加载水域面
    useEffect(() => {
        if (waterLayer === 'none') {
            setWaterPolys([])
            return
        }
        let cancelled = false
        setWaterLoading(true)
        const task = waterTaskId ? waterTasks.find((t) => t.id === waterTaskId) : undefined
        const job = task
            ? invoke<ChartFeatureLite[]>('chart_get_features_by_layer_in_bounds', {
                  sourceLayer: waterLayer,
                  west: task.bounds_west,
                  south: task.bounds_south,
                  east: task.bounds_east,
                  north: task.bounds_north,
              })
            : invoke<ChartFeatureLite[]>('chart_get_features_by_layer', { sourceLayer: waterLayer })
        job
            .then((features) => {
                if (cancelled) return
                const polys: WaterPolygon[] = []
                for (const f of features) {
                    try {
                        const geom = JSON.parse(f.geometry_json)
                        polys.push(...geometryToPolygons(geom))
                    } catch {
                        /* 跳过坏几何 */
                    }
                }
                setWaterPolys(polys)
            })
            .catch(() => {
                if (!cancelled) setWaterPolys([])
            })
            .finally(() => {
                if (!cancelled) setWaterLoading(false)
            })
        return () => {
            cancelled = true
        }
    }, [waterLayer, waterTaskId, waterTasks])

    // 只取最外层水域面（去掉大大小小嵌套的内层，做范围粗判）；原始 waterPolys 不变
    const effectiveWaterPolys = useMemo(
        () => (onlyOutermost ? outermostPolygons(waterPolys) : waterPolys),
        [onlyOutermost, waterPolys],
    )

    // 水域内外划分
    const partition = useMemo(() => {
        if (!effectiveWaterPolys.length) return { inside: wgsPoints, outside: [] as AisPoint[] }
        const inside: AisPoint[] = []
        const outside: AisPoint[] = []
        for (const p of wgsPoints) {
            if (pointInWater(p.lon, p.lat, effectiveWaterPolys)) inside.push(p)
            else outside.push(p)
        }
        return { inside, outside }
    }, [wgsPoints, effectiveWaterPolys])

    const anomalies = useMemo(() => (filterOn ? partition.outside : []), [filterOn, partition])

    // 水域过滤按航次逐个剔除外点，保持航次结构再分段
    const segTrips = useMemo(() => {
        if (!filterOn || !effectiveWaterPolys.length) return cleaned.trips
        return cleaned.trips.map((t) => t.filter((p) => pointInWater(p.lon, p.lat, effectiveWaterPolys)))
    }, [filterOn, effectiveWaterPolys, cleaned.trips])

    const segments: Segment[] = useMemo(
        () => segmentTrips(segTrips, traj, anchoredValues),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [segTrips, traj, anchoredValues.join(',')],
    )

    const anchorCount = segments.filter((s) => s.kind === 'anchored').length
    const waterKind = WATER_OPTIONS.find((o) => o.key === waterLayer)?.kind ?? 'hydro'

    const filteredShips = useMemo(() => {
        const q = shipSearch.trim().toLowerCase()
        if (!q) return ships
        return ships.filter(
            (s) => s.mmsi.toLowerCase().includes(q) || (s.name ?? '').toLowerCase().includes(q),
        )
    }, [ships, shipSearch])

    const setPreset = (days: number | null) => {
        if (days == null) {
            setTimeFrom('')
            setTimeTo('')
            return
        }
        const to = new Date()
        const from = new Date(to.getTime() - days * 86400000)
        const fmt = (d: Date) => {
            const pad = (n: number) => String(n).padStart(2, '0')
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
        }
        setTimeFrom(fmt(from))
        setTimeTo(fmt(to))
    }

    if (!conn) {
        return (
            <div className="ais-empty">
                <GcIcon name="ship" size={40} />
                <div className="ais-empty-title">还没有 ES 连接</div>
                <div className="ais-empty-sub">先到「ES 连接」里新建一个连接并完成字段映射。</div>
                <button type="button" className="btn" onClick={onGoConnections}>
                    去新建连接
                </button>
            </div>
        )
    }

    const shipsBusy = mode === 'raw' ? pulling : shipsLoading
    const shipsErr = mode === 'raw' ? pullError : shipError
    const emptyShipsMsg =
        mode === 'raw'
            ? pullStats
                ? '该时间窗未解码出船位点。'
                : '先选时间范围并点「拉取并解码」。'
            : '无船只。检查映射的 MMSI / 聚合字段是否可聚合。'

    return (
        <div className="ais-layout">
            {/* 左控制栏 */}
            <div className="ais-panel page-scroll">
                <div className="ais-field">
                    <label className="ais-label">ES 连接</label>
                    <select className="ais-select" value={connId} onChange={(e) => onConnId(e.target.value)}>
                        {connections.map((c) => (
                            <option key={c.id} value={c.id}>
                                {c.name || `${c.host}:${c.port}`}
                                {c.dataMode === 'raw' ? ' · 报文' : ''}
                            </option>
                        ))}
                    </select>
                </div>

                <div className="ais-field">
                    <label className="ais-label">时间范围</label>
                    <div className="ais-presets">
                        <button type="button" onClick={() => setPreset(null)}>全部</button>
                        <button type="button" onClick={() => setPreset(1)}>近 1 天</button>
                        <button type="button" onClick={() => setPreset(7)}>近 7 天</button>
                        <button type="button" onClick={() => setPreset(30)}>近 30 天</button>
                    </div>
                    <input type="datetime-local" className="ais-select" value={timeFrom} onChange={(e) => setTimeFrom(e.target.value)} />
                    <input type="datetime-local" className="ais-select" value={timeTo} onChange={(e) => setTimeTo(e.target.value)} />
                </div>

                {mode === 'raw' && (
                    <div className="ais-field">
                        <label className="ais-label">拉取并解码</label>
                        <div className="ais-hint">
                            原始 AIVDM 报文需解码后才能按船浏览。建议先选较窄的时间范围再拉取。
                        </div>
                        <NumberRow
                            label="最多解码点数"
                            value={maxPoints}
                            step={10000}
                            onChange={(v) => setMaxPoints(Math.min(300000, Math.max(1000, Math.round(v))))}
                        />
                        <button type="button" className="btn primary" onClick={doPull} disabled={pulling}>
                            <GcIcon name="zap" size={13} /> {pulling ? '解码中…' : '拉取并解码'}
                        </button>
                        {pullStats && (
                            <div className="ais-hint">
                                扫描 {pullStats.scanned} 报文 · 解码 {pullStats.decoded} 点 · {pullStats.ships} 艘船
                                {pullStats.truncated ? ' · 已达上限，建议缩小时间范围' : ''}
                            </div>
                        )}
                    </div>
                )}

                <div className="ais-field">
                    <div className="ais-row-between">
                        <label className="ais-label">船只 {ships.length ? `(${ships.length})` : ''}</label>
                        {mode === 'fields' && (
                            <button type="button" className="ais-mini-btn" onClick={loadShips} disabled={shipsLoading}>
                                <GcIcon name="refresh" size={12} /> 刷新
                            </button>
                        )}
                    </div>
                    <input
                        className="ais-select"
                        placeholder="搜索 MMSI / 船名"
                        value={shipSearch}
                        onChange={(e) => setShipSearch(e.target.value)}
                    />
                    <div className="ais-ship-list">
                        {shipsBusy && <div className="ais-hint">{mode === 'raw' ? '解码中…' : '加载中…'}</div>}
                        {shipsErr && <div className="ais-hint err">{shipsErr}</div>}
                        {!shipsBusy && !shipsErr && filteredShips.length === 0 && (
                            <div className="ais-hint">{emptyShipsMsg}</div>
                        )}
                        {filteredShips.slice(0, 500).map((s) => (
                            <button
                                key={s.mmsi}
                                type="button"
                                className={`ais-ship-row${selectedMmsi === s.mmsi ? ' active' : ''}`}
                                onClick={() => setSelectedMmsi(s.mmsi)}
                            >
                                <div className="ais-ship-name">{s.name || s.mmsi}</div>
                                <div className="ais-ship-meta">
                                    <span>{s.mmsi}</span>
                                    <span>{s.count} 点</span>
                                </div>
                                <div className="ais-ship-time">{fmtTs(s.firstTs)} ~ {fmtTs(s.lastTs)}</div>
                            </button>
                        ))}
                        {filteredShips.length > 500 && (
                            <div className="ais-hint">仅显示前 500 艘，请用搜索缩小。</div>
                        )}
                    </div>
                </div>

                <div className="ais-field">
                    <label className="ais-label">水域图过滤</label>
                    <select
                        className="ais-select"
                        value={waterLayer}
                        onChange={(e) => setWaterLayer(e.target.value as WaterLayerKey)}
                    >
                        {WATER_OPTIONS.map((o) => (
                            <option key={o.key} value={o.key}>{o.label}</option>
                        ))}
                    </select>
                    {waterLayer !== 'none' && waterTasks.length > 0 && (
                        <select
                            className="ais-select"
                            value={waterTaskId}
                            onChange={(e) => setWaterTaskId(e.target.value)}
                            title="把水域面限定到某个航道任务下载的区域"
                        >
                            <option value="">不限定区域（全部水域面）</option>
                            {waterTasks.map((t) => (
                                <option key={t.id} value={t.id}>
                                    限定：{t.name || t.id}
                                </option>
                            ))}
                        </select>
                    )}
                    {waterLayer !== 'none' && (
                        <div className="ais-row-between">
                            <span className="ais-toggle-text">
                                只取最外层水域面（范围粗判）
                                {waterLoading
                                    ? ' · 载入中'
                                    : onlyOutermost && waterPolys.length
                                      ? ` · ${waterPolys.length} → ${effectiveWaterPolys.length} 面`
                                      : waterPolys.length
                                        ? ` · ${waterPolys.length} 面`
                                        : ''}
                            </span>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={onlyOutermost}
                                className={`ais-toggle${onlyOutermost ? ' on' : ''}`}
                                onClick={() => setOnlyOutermost((v) => !v)}
                            >
                                <span className="ais-toggle-knob" />
                            </button>
                        </div>
                    )}
                    <div className="ais-row-between">
                        <span className="ais-toggle-text">过滤水域外异常点</span>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={filterOn}
                            className={`ais-toggle${filterOn ? ' on' : ''}`}
                            disabled={waterLayer === 'none'}
                            onClick={() => setFilterOn((v) => !v)}
                        >
                            <span className="ais-toggle-knob" />
                        </button>
                    </div>
                    {waterLayer !== 'none' && (
                        <div className="ais-hint">
                            水域内 {partition.inside.length} · 水域外 {partition.outside.length}
                        </div>
                    )}
                </div>

                <div className="ais-field">
                    <label className="ais-label">底图坐标系</label>
                    <div className="seg ais-seg">
                        <button type="button" className={baseCrs === 'wgs84' ? 'active' : ''} onClick={() => setBaseCrs('wgs84')}>
                            OSM · WGS-84
                        </button>
                        <button type="button" className={baseCrs === 'gcj02' ? 'active' : ''} onClick={() => setBaseCrs('gcj02')}>
                            高德 · GCJ-02
                        </button>
                    </div>
                </div>

                <div className="ais-field">
                    <div className="ais-row-between">
                        <label className="ais-label">数据清洗 / 航次切分</label>
                        <span className="ais-badge">{cleaned.trips.length} 航次</span>
                    </div>
                    <NumberRow label="跳点速度阈值 (节)" value={traj.maxJumpKn} step={5} onChange={(v) => setTraj((t) => ({ ...t, maxJumpKn: Math.max(5, v) }))} />
                    <NumberRow label="航次切分静默 (分钟)" value={traj.tripGapMinutes} step={5} onChange={(v) => setTraj((t) => ({ ...t, tripGapMinutes: Math.max(1, v) }))} />
                    {selectedMmsi && (
                        <div className="ais-hint">
                            原始 {rawWgsPoints.length} 点 · 清洗后 {wgsPoints.length} 点 · {cleaned.trips.length} 航次
                            {cleaned.dropped ? ` · 去噪 ${cleaned.dropped}` : ''}
                        </div>
                    )}
                </div>

                <div className="ais-field">
                    <div className="ais-row-between">
                        <label className="ais-label">停泊聚合参数</label>
                        <span className="ais-badge">{anchorCount} 处停泊</span>
                    </div>
                    <NumberRow label="静止速度阈值 (节)" value={traj.speedAnchorKn} step={0.1} onChange={(v) => setTraj((t) => ({ ...t, speedAnchorKn: v }))} />
                    <NumberRow label="摆动半径 (米)" value={traj.anchorRadiusM} step={5} onChange={(v) => setTraj((t) => ({ ...t, anchorRadiusM: v }))} />
                    <NumberRow label="最短停泊时长 (秒)" value={traj.anchorMinDurationS} step={30} onChange={(v) => setTraj((t) => ({ ...t, anchorMinDurationS: v }))} />
                    <NumberRow label="顶流净进展上限 (节)" value={traj.anchorMaxDriftKn} step={0.05} onChange={(v) => setTraj((t) => ({ ...t, anchorMaxDriftKn: v }))} />
                    <NumberRow label="航线抽稀容差 (米)" value={traj.simplifyToleranceM} step={1} onChange={(v) => setTraj((t) => ({ ...t, simplifyToleranceM: v }))} />
                    <div className="ais-row-between">
                        <span className="ais-toggle-text">显示停泊原始点</span>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={showRawAnchored}
                            className={`ais-toggle${showRawAnchored ? ' on' : ''}`}
                            onClick={() => setShowRawAnchored((v) => !v)}
                        >
                            <span className="ais-toggle-knob" />
                        </button>
                    </div>
                </div>
            </div>

            {/* 右地图 */}
            <div className="ais-map-wrap">
                <MapContainer
                    center={[31.23, 121.47]}
                    zoom={9}
                    zoomControl={false}
                    attributionControl={false}
                    style={{ position: 'absolute', inset: 0 }}
                >
                    {baseCrs === 'gcj02' ? (
                        <TileLayer key="amap" url={AMAP_STREET_URL} subdomains={AMAP_SUBDOMAINS} maxNativeZoom={18} maxZoom={20} />
                    ) : (
                        <CachedOsmTileLayer key="osm" />
                    )}
                    <MapAutosize />
                    <AisRouteLayer
                        segments={segments}
                        anomalies={anomalies}
                        waterPolygons={effectiveWaterPolys}
                        waterKind={waterKind}
                        baseCrs={baseCrs}
                        showRawAnchored={showRawAnchored}
                        simplifyToleranceM={traj.simplifyToleranceM}
                        fitKey={`${connId}|${selectedMmsi}|${baseCrs}`}
                    />
                </MapContainer>

                {/* 顶部状态条 */}
                <div className="ais-map-status">
                    {routeLoading && <span className="ais-chip">航迹加载中…</span>}
                    {routeError && <span className="ais-chip err">{routeError}</span>}
                    {!routeLoading && selectedMmsi && (
                        <span className="ais-chip">
                            {selectedMmsi} · {wgsPoints.length}
                            {mode === 'fields' ? `/${routeTotal}` : ''} 点
                        </span>
                    )}
                    {selectedMmsi && cleaned.dropped > 0 && (
                        <span className="ais-chip">清洗掉 {cleaned.dropped} 个跳点/重复</span>
                    )}
                    {selectedMmsi && cleaned.trips.length > 1 && (
                        <span className="ais-chip">{cleaned.trips.length} 个航次</span>
                    )}
                    {mode === 'fields' && routeTruncated && (
                        <span className="ais-chip warn">已截断，请缩小时间范围</span>
                    )}
                    {mode === 'raw' && pullStats?.truncated && (
                        <span className="ais-chip warn">解码已达上限，请缩小时间范围</span>
                    )}
                    {filterOn && anomalies.length > 0 && (
                        <span className="ais-chip danger">过滤掉 {anomalies.length} 个水域外点</span>
                    )}
                </div>

                {/* 图例 */}
                <div className="ais-legend">
                    <div className="ais-legend-row"><i className="lg-line sail" /> 行驶航线</div>
                    <div className="ais-legend-row"><i className="lg-line conn" /> 停泊跨段</div>
                    <div className="ais-legend-row"><i className="lg-anchor"><GcIcon name="anchor" size={11} /></i> 停泊点 + 摆动圈</div>
                    {filterOn && <div className="ais-legend-row"><i className="lg-dot anomaly" /> 水域外异常点</div>}
                    {waterLayer !== 'none' && <div className="ais-legend-row"><i className={`lg-water ${waterKind}`} /> 水域面</div>}
                </div>
            </div>
        </div>
    )
}

function NumberRow({
    label,
    value,
    step,
    onChange,
}: {
    label: string
    value: number
    step: number
    onChange: (v: number) => void
}) {
    return (
        <div className="ais-num-row">
            <span>{label}</span>
            <input
                type="number"
                step={step}
                value={value}
                onChange={(e) => {
                    const v = parseFloat(e.target.value)
                    if (Number.isFinite(v)) onChange(v)
                }}
            />
        </div>
    )
}
