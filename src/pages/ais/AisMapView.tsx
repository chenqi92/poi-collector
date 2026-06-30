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
import { aisListIndices, aisListShips, aisPullWindow, aisRoutePage, aisTestConnection } from '@/lib/ais/api'
import type { AisPoint, BaseCrs, DataMode, EsConnection, FieldMapping, IndexInfo, ShipSummary, TrajParams } from '@/lib/ais/types'
import { emptyMapping } from '@/lib/ais/types'
import { autoDetect, mappingSummary } from '@/lib/ais/autodetect'
import { IndexPickerDialog, indicesSummary } from './IndexPickerDialog'
import { cleanTrack, DEFAULT_TRAJ, haversineM, type Segment, segmentTrips, tripColor } from '@/lib/ais/trajectory'
import { geometryToPolygons, dissolveOutline, pointInWater, type WaterPolygon } from '@/lib/ais/geo'
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

/** 稳定的空数组引用，避免不必要的图层重渲染 */
const EMPTY_POINTS: AisPoint[] = []

function fmtDist(m: number): string {
    return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`
}

/** 同一天只显示「日 时:分~时:分」，跨天显示完整起讫，给航次行用 */
function fmtSpan(a?: number, b?: number): string {
    if (!a) return '-'
    const da = new Date(a)
    const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    const md = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`
    if (!b || a === b) return `${md(da)} ${hm(da)}`
    const db = new Date(b)
    if (da.toDateString() === db.toDateString()) return `${md(da)} ${hm(da)}~${hm(db)}`
    return `${md(da)} ${hm(da)} ~ ${md(db)} ${hm(db)}`
}

/** 索引「家族」：去掉日期后缀（aismessage_2023_04_06 → aismessage）。不同家族 schema 可能不同。 */
function familyOf(name: string): string {
    return name.replace(/[._-]?\d{4}.*$/, '') || name
}

interface Props {
    conn: EsConnection | null
    connections: EsConnection[]
    connId: string
    onConnId: (id: string) => void
    onGoConnections: () => void
}

export function AisMapView({ conn, connections, connId, onConnId, onGoConnections }: Props) {
    // 选择 / 搜索 / 时间
    const [selectedMmsi, setSelectedMmsi] = useState('')
    const [shipSearch, setShipSearch] = useState('')
    const [timeFrom, setTimeFrom] = useState('')
    const [timeTo, setTimeTo] = useState('')

    // 索引多选 + 字段映射（连接后选索引、自动识别、本地缓存）
    const [availIndices, setAvailIndices] = useState<IndexInfo[]>([])
    const [indicesLoading, setIndicesLoading] = useState(false)
    const [selectedIndices, setSelectedIndices] = useState<string[]>([])
    const [queryMapping, setQueryMapping] = useState<FieldMapping>(emptyMapping)
    const [queryDataMode, setQueryDataMode] = useState<DataMode>('fields')
    const [mappingReady, setMappingReady] = useState(false)
    const [mappingErr, setMappingErr] = useState('')
    const [showAdvMapping, setShowAdvMapping] = useState(false)
    const mode = queryDataMode

    // fields 模式：服务端列船 + 按船查询航迹
    const [fetchedShips, setFetchedShips] = useState<ShipSummary[]>([])
    const [shipsLoading, setShipsLoading] = useState(false)
    const [shipError, setShipError] = useState('')
    const [routePoints, setRoutePoints] = useState<AisPoint[]>([])
    const [routeLoading, setRouteLoading] = useState(false)
    const [routeError, setRouteError] = useState('')
    const [routeTotal, setRouteTotal] = useState(0)
    const [routeTruncated, setRouteTruncated] = useState(false)
    // fields 单船航迹最多加载点数（默认很大，尽量加载完整；脏数据/超大可调小）
    const [routeMax, setRouteMax] = useState(500000)
    // 航次显隐：被隐藏的航次序号集合 + 列表展开
    const [hiddenTrips, setHiddenTrips] = useState<Set<number>>(new Set())
    const [tripsOpen, setTripsOpen] = useState(true)

    // raw 模式：拉取并解码一个时间窗
    const [pulled, setPulled] = useState<AisPoint[]>([])
    const [pulling, setPulling] = useState(false)
    const [pullError, setPullError] = useState('')
    const [pullStats, setPullStats] = useState<PullStats | null>(null)
    const [maxPoints, setMaxPoints] = useState(50000)
    // 跨索引拉单船完整航迹（扫描全部所选索引、只保留这艘船）
    const [shipPull, setShipPull] = useState<{ mmsi: string; points: AisPoint[]; scanned: number; truncated: boolean } | null>(null)
    const [shipPulling, setShipPulling] = useState(false)

    // 水域过滤
    const [waterLayer, setWaterLayer] = useState<WaterLayerKey>('none')
    const [waterPolys, setWaterPolys] = useState<WaterPolygon[]>([])
    const [waterLoading, setWaterLoading] = useState(false)
    const [filterOn, setFilterOn] = useState(false)
    const [onlyOutermost, setOnlyOutermost] = useState(true)
    const [panelOpen, setPanelOpen] = useState(true)
    const [indexPickerOpen, setIndexPickerOpen] = useState(false)
    const [waterTasks, setWaterTasks] = useState<ChartTaskLite[]>([])
    const [waterTaskId, setWaterTaskId] = useState('')

    // 底图 / 渲染
    const [baseCrs, setBaseCrs] = useState<BaseCrs>('wgs84')
    const [showRawAnchored, setShowRawAnchored] = useState(false)
    // 是否在地图上展示被清洗掉的跳点/重复点（默认隐藏，可点击切换以验证清洗确实生效）
    const [showDropped, setShowDropped] = useState(false)
    // 是否显示全部轨迹点（canvas 小点，点击地图弹出最近点详情）
    const [showPoints, setShowPoints] = useState(false)
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
        setShipPull(null)
        const tp = conn?.trajectoryParams
        setTraj({ ...DEFAULT_TRAJ, ...(tp && typeof tp === 'object' ? tp : {}) })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connId])

    // 当前所选索引的「家族」（去掉日期后缀）；不同家族字段映射各存一份缓存
    const indexFamily = useMemo(() => {
        const first = selectedIndices.find((s) => !s.includes('*')) ?? selectedIndices[0] ?? ''
        return familyOf(first)
    }, [selectedIndices])
    const mapKey = `ais-map-${connId}::${indexFamily}`

    // 连接变化：拉索引列表 + 恢复缓存的索引选择
    useEffect(() => {
        setSelectedIndices([])
        setAvailIndices([])
        setMappingReady(false)
        setMappingErr('')
        if (!conn) return
        setIndicesLoading(true)
        aisListIndices(conn)
            .then((list) => {
                // 倒叙：新索引在前（日索引即最新日期在最上）
                setAvailIndices([...list].sort((a, b) => b.name.localeCompare(a.name)))
                let restored: string[] = []
                try {
                    const raw = localStorage.getItem(`ais-idx-${connId}`)
                    if (raw) restored = JSON.parse(raw)
                } catch { /* ignore */ }
                const names = new Set(list.map((i) => i.name))
                setSelectedIndices(restored.filter((n) => names.has(n) || n.includes('*')))
            })
            .catch(() => setAvailIndices([]))
            .finally(() => setIndicesLoading(false))
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connId])

    // 索引家族变化：恢复该家族的映射缓存；没有则置 mappingReady=false 触发自动识别
    useEffect(() => {
        if (!conn || selectedIndices.length === 0 || !indexFamily) return
        try {
            const raw = localStorage.getItem(mapKey)
            if (raw) {
                const c = JSON.parse(raw)
                setQueryMapping({ ...emptyMapping(), ...c.mapping })
                setQueryDataMode(c.dataMode === 'raw' ? 'raw' : 'fields')
                setMappingReady(true)
                return
            }
        } catch { /* ignore */ }
        setMappingReady(false)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connId, indexFamily])

    // 没有映射时：采样首个索引自动识别字段，写入该家族的缓存
    useEffect(() => {
        if (!conn || selectedIndices.length === 0 || mappingReady) return
        let cancelled = false
        setMappingErr('')
        const sampleIdx = selectedIndices.find((s) => !s.includes('*')) ?? selectedIndices[0]
        aisTestConnection(conn, sampleIdx)
            .then((r) => {
                if (cancelled) return
                const det = autoDetect(r.sample)
                if (det) {
                    setQueryMapping(det.fieldMapping)
                    setQueryDataMode(det.dataMode)
                    setMappingReady(true)
                    try { localStorage.setItem(mapKey, JSON.stringify({ dataMode: det.dataMode, mapping: det.fieldMapping })) } catch { /* ignore */ }
                } else {
                    setMappingErr('未能自动识别字段，请展开「字段映射」手动设置')
                }
            })
            .catch((e) => { if (!cancelled) setMappingErr(String(e)) })
        return () => { cancelled = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [conn, connId, indexFamily, selectedIndices, mappingReady])

    const updateMapping = (patch: Partial<FieldMapping>) =>
        setQueryMapping((m) => {
            const next = { ...m, ...patch }
            setMappingReady(true)
            try { localStorage.setItem(mapKey, JSON.stringify({ dataMode: queryDataMode, mapping: next })) } catch { /* ignore */ }
            return next
        })

    // 用户显式改选索引时才写缓存（避免切连接时把旧选择写到新连接的键）
    const setSel = (next: string[]) => {
        setSelectedIndices(next)
        try { localStorage.setItem(`ais-idx-${connId}`, JSON.stringify(next)) } catch { /* ignore */ }
    }

    const indicesKey = selectedIndices.join(',')
    const anchoredValues = queryMapping.navStatusAnchored ?? []
    const sourceCrs = conn?.sourceCrs ?? 'wgs84'

    // —— fields 模式：列船 ——
    const loadShips = async () => {
        if (!connId || selectedIndices.length === 0 || !mappingReady) return
        setShipsLoading(true)
        setShipError('')
        try {
            const list = await aisListShips({
                connId,
                indices: selectedIndices,
                mapping: queryMapping,
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
    }, [mode, connId, indicesKey, mappingReady, timeFrom, timeTo])

    // —— fields 模式：按船查询航迹（scroll 渐进式分页，无 1 万上限，边拉边画）——
    useEffect(() => {
        if (mode !== 'fields' || !connId || !selectedMmsi || selectedIndices.length === 0 || !mappingReady) {
            setRoutePoints([])
            return
        }
        let cancelled = false
        setRouteLoading(true)
        setRouteError('')
        setRoutePoints([])
        setRouteTotal(0)
        setRouteTruncated(false)
        const cap = Math.max(1000, routeMax)
        const acc: AisPoint[] = []
        let lastFlush = 0
        const flush = () => setRoutePoints(acc.slice())
        const run = async () => {
            let scrollId: string | undefined
            try {
                for (; ;) {
                    if (cancelled) break
                    const pg = await aisRoutePage({
                        connId,
                        indices: selectedIndices,
                        mapping: queryMapping,
                        mmsi: selectedMmsi,
                        timeFrom: toMs(timeFrom),
                        timeTo: toMs(timeTo),
                        size: 10000,
                        scrollId,
                    })
                    if (cancelled) break
                    scrollId = pg.scrollId
                    if (pg.total) setRouteTotal(pg.total)
                    for (const p of pg.points) {
                        const [lon, lat] = normalizeToWgs84(sourceCrs, p.lon, p.lat)
                        acc.push({ ...p, lon, lat })
                    }
                    // 节流渲染：首批立即出图，之后每累计 ~5 万点刷新一次，边拉边画
                    if (lastFlush === 0 || acc.length - lastFlush >= 50000) { lastFlush = acc.length; flush() }
                    if (pg.done) break
                    if (acc.length >= cap) { setRouteTruncated(true); break }
                }
            } catch (e) {
                if (!cancelled) setRouteError(String(e))
            } finally {
                if (!cancelled) { flush(); setRouteLoading(false) }
            }
        }
        run()
        return () => { cancelled = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, connId, indicesKey, mappingReady, selectedMmsi, timeFrom, timeTo, sourceCrs, routeMax])

    // —— raw 模式：拉取并解码 ——
    const doPull = async () => {
        if (!connId || selectedIndices.length === 0 || !mappingReady) {
            setPullError('请先选择索引（连接后在上方勾选）')
            return
        }
        setPulling(true)
        setPullError('')
        setSelectedMmsi('')
        try {
            const r = await aisPullWindow({
                connId,
                indices: selectedIndices,
                mapping: queryMapping,
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

    // —— raw 模式：跨所选索引拉「当前所选船」的完整航迹 ——
    const doShipPull = async () => {
        if (!connId || !selectedMmsi || selectedIndices.length === 0 || !mappingReady) return
        setShipPulling(true)
        setPullError('')
        try {
            const r = await aisPullWindow({
                connId,
                indices: selectedIndices,
                mapping: queryMapping,
                mmsi: selectedMmsi,
                timeFrom: toMs(timeFrom),
                timeTo: toMs(timeTo),
                maxPoints: 200000,
            })
            setShipPull({ mmsi: selectedMmsi, points: r.points, scanned: r.scanned, truncated: r.truncated })
        } catch (e) {
            setPullError(String(e))
        } finally {
            setShipPulling(false)
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

    // raw 模式：所选船的点（归一化到 WGS-84）。若刚跨索引拉过这艘船的完整航迹，
    // 用完整结果，否则从窗口拉取里按 MMSI 过滤。
    const rawPoints: AisPoint[] = useMemo(() => {
        if (mode !== 'raw' || !selectedMmsi) return []
        const src = shipPull && shipPull.mmsi === selectedMmsi
            ? shipPull.points
            : pulled.filter((p) => p.mmsi === selectedMmsi)
        return src.map((p) => {
            const [lon, lat] = normalizeToWgs84(sourceCrs, p.lon, p.lat)
            return { ...p, lon, lat }
        })
    }, [mode, pulled, shipPull, selectedMmsi, sourceCrs])

    const ships = mode === 'raw' ? rawShips : fetchedShips
    const rawWgsPoints = mode === 'raw' ? rawPoints : routePoints

    // 数据清洗：去重复/跳点 + 按大跳变/长静默切航次（解决 GPS 跳点与 MMSI 串号拼接）
    const cleaned = useMemo(
        () =>
            cleanTrack(rawWgsPoints, {
                maxJumpKn: traj.maxJumpKn,
                maxJumpKm: traj.maxJumpKm,
                tripGapMinutes: traj.tripGapMinutes,
            }),
        [rawWgsPoints, traj.maxJumpKn, traj.maxJumpKm, traj.tripGapMinutes],
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

    // 合并为水域范围（扫描线并集，消掉嵌套内框、挖掉中间岛屿），用于范围判断与渲染；
    // 与数据中心同一套 dissolveOutline；原始 waterPolys 不变
    const effectiveWaterPolys = useMemo(
        () => (onlyOutermost ? dissolveOutline(waterPolys) : waterPolys),
        [onlyOutermost, waterPolys],
    )

    // 水域内外划分：用「原始水域面」做点在多边形判断（精确，不受合并外框的栅格化误差影响）。
    // effectiveWaterPolys 只用于地图显示；这里始终用 waterPolys 避免边缘点被误判为外点。
    const partition = useMemo(() => {
        if (!waterPolys.length) return { inside: wgsPoints, outside: [] as AisPoint[] }
        const inside: AisPoint[] = []
        const outside: AisPoint[] = []
        for (const p of wgsPoints) {
            if (pointInWater(p.lon, p.lat, waterPolys)) inside.push(p)
            else outside.push(p)
        }
        return { inside, outside }
    }, [wgsPoints, waterPolys])

    const anomalies = useMemo(() => (filterOn ? partition.outside : []), [filterOn, partition])

    // 水域过滤按航次逐个剔除外点，保持航次结构再分段（同样用原始水域面精确判断）
    const segTrips = useMemo(() => {
        if (!filterOn || !waterPolys.length) return cleaned.trips
        return cleaned.trips.map((t) => t.filter((p) => pointInWater(p.lon, p.lat, waterPolys)))
    }, [filterOn, waterPolys, cleaned.trips])

    const segments: Segment[] = useMemo(
        () => segmentTrips(segTrips, traj, anchoredValues),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [segTrips, traj, anchoredValues.join(',')],
    )

    const anchorCount = segments.filter((s) => s.kind === 'anchored').length
    const waterKind = WATER_OPTIONS.find((o) => o.key === waterLayer)?.kind ?? 'hydro'

    // 该船是否基本停泊未移动：清洗后的点集中在极小范围内（多为锚泊/系泊船，没有航线可言）
    const stationary = useMemo(() => {
        const pts = wgsPoints
        if (pts.length < 20) return null
        let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
        for (const p of pts) {
            if (p.lon < minLon) minLon = p.lon
            if (p.lon > maxLon) maxLon = p.lon
            if (p.lat < minLat) minLat = p.lat
            if (p.lat > maxLat) maxLat = p.lat
        }
        const latM = (maxLat - minLat) * 111_320
        const lonM = (maxLon - minLon) * 111_320 * Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180)
        const spanM = Math.hypot(latM, lonM)
        return spanM < 400 ? { spanM, count: pts.length } : null
    }, [wgsPoints])

    // 各航次概要（序号与 segTrips 下标一致，与地图分段着色对应），按航程降序展示，空航次跳过
    const tripSummaries = useMemo(() => {
        const out = segTrips.map((trip, i) => {
            let distM = 0
            for (let k = 1; k < trip.length; k++) {
                distM += haversineM(trip[k - 1].lon, trip[k - 1].lat, trip[k].lon, trip[k].lat)
            }
            return {
                i,
                count: trip.length,
                startTs: trip.length ? trip[0].ts : 0,
                endTs: trip.length ? trip[trip.length - 1].ts : 0,
                distM,
            }
        })
        return out.filter((t) => t.count > 0).sort((a, b) => b.distM - a.distM)
    }, [segTrips])

    // 切换船只时重置航次显隐
    useEffect(() => {
        setHiddenTrips(new Set())
    }, [selectedMmsi, connId])

    const visibleTripCount = tripSummaries.filter((t) => !hiddenTrips.has(t.i)).length
    const toggleTrip = (i: number) =>
        setHiddenTrips((prev) => {
            const next = new Set(prev)
            if (next.has(i)) next.delete(i)
            else next.add(i)
            return next
        })
    const soloTrip = (i: number) =>
        setHiddenTrips(new Set(tripSummaries.map((t) => t.i).filter((x) => x !== i)))
    const showAllTrips = () => setHiddenTrips(new Set())
    const invertTrips = () =>
        setHiddenTrips(new Set(tripSummaries.filter((t) => !hiddenTrips.has(t.i)).map((t) => t.i)))

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
        <div className={`ais-layout${panelOpen ? '' : ' panel-collapsed'}`}>
            {/* 左控制栏 */}
            <div className="ais-panel page-scroll">
                <div className="ais-field">
                    <label className="ais-label">ES 连接</label>
                    <select className="ais-select" value={connId} onChange={(e) => onConnId(e.target.value)}>
                        {connections.map((c) => (
                            <option key={c.id} value={c.id}>
                                {c.name || `${c.host}:${c.port}`}
                            </option>
                        ))}
                    </select>
                </div>

                <div className="ais-field">
                    <label className="ais-label">索引{selectedIndices.length ? ` · 选了 ${selectedIndices.length}` : ''}</label>
                    {indicesLoading ? (
                        <div className="ais-hint">载入索引…</div>
                    ) : availIndices.length === 0 ? (
                        <div className="ais-hint">未发现索引。到「ES 连接」页测试连接确认端点可达。</div>
                    ) : (
                        <>
                            <button type="button" className="btn" style={{ width: '100%', justifyContent: 'center' }} onClick={() => setIndexPickerOpen(true)}>
                                <GcIcon name="layers" size={13} /> 选择索引…（共 {availIndices.length}）
                            </button>
                            <div className="ais-hint" style={{ marginTop: 4 }}>{indicesSummary(selectedIndices)}</div>
                        </>
                    )}
                    {selectedIndices.length > 0 && (
                        <>
                            <div className="ais-row-between" style={{ marginTop: 6 }}>
                                {mappingReady ? (
                                    <span className="ais-hint" style={{ color: 'var(--st-green, #10b981)' }}>✓ {mappingSummary(queryDataMode, queryMapping)}</span>
                                ) : mappingErr ? (
                                    <span className="ais-hint err">{mappingErr}</span>
                                ) : (
                                    <span className="ais-hint">识别字段中…</span>
                                )}
                                <button type="button" className="ais-mini-btn" onClick={() => setShowAdvMapping((v) => !v)}>字段映射</button>
                            </div>
                            {mappingReady && !queryMapping.timestamp.trim() && (
                                <div className="ais-hint warn" style={{ marginTop: 4 }}>
                                    ⚠ 未识别到时间字段：航迹只能按报文顺序展示，停泊 / 航次 / 速度分析与时间筛选都不可用。
                                    该索引确无时间字段则正常；若有，可在「字段映射」里手填。
                                </div>
                            )}
                            {showAdvMapping && (
                                <div style={{ marginTop: 6 }}>
                                    <div className="seg ais-seg" style={{ marginBottom: 6 }}>
                                        <button type="button" className={queryDataMode === 'fields' ? 'active' : ''} onClick={() => { setQueryDataMode('fields'); setMappingReady(true) }}>结构化字段</button>
                                        <button type="button" className={queryDataMode === 'raw' ? 'active' : ''} onClick={() => { setQueryDataMode('raw'); setMappingReady(true) }}>原始 AIVDM</button>
                                    </div>
                                    {queryDataMode === 'raw' ? (
                                        <>
                                            <MapInput label="报文字段" value={queryMapping.message} onChange={(v) => updateMapping({ message: v })} />
                                            <MapInput label="时间字段" value={queryMapping.timestamp} onChange={(v) => updateMapping({ timestamp: v })} />
                                        </>
                                    ) : (
                                        <>
                                            <MapInput label="MMSI" value={queryMapping.mmsi} onChange={(v) => updateMapping({ mmsi: v })} />
                                            <MapInput label="聚合字段 (keyword)" value={queryMapping.aggField} onChange={(v) => updateMapping({ aggField: v })} />
                                            <MapInput label="纬度 lat" value={queryMapping.lat} onChange={(v) => updateMapping({ lat: v })} />
                                            <MapInput label="经度 lon" value={queryMapping.lon} onChange={(v) => updateMapping({ lon: v })} />
                                            <MapInput label="时间字段" value={queryMapping.timestamp} onChange={(v) => updateMapping({ timestamp: v })} />
                                        </>
                                    )}
                                </div>
                            )}
                        </>
                    )}
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

                {mode === 'fields' && (
                    <div className="ais-field">
                        <NumberRow
                            label="最多点数（单船航迹）"
                            value={routeMax}
                            step={100000}
                            onChange={(v) => setRouteMax(Math.min(2000000, Math.max(1000, Math.round(v))))}
                        />
                        <div className="ais-hint">点选船只后 scroll 渐进式加载（边拉边画），默认尽量加载完整。多数 AIS 点是停泊（sog≈0），航线要等移动段加载出来才显示。太大可调小，或缩小时间范围。</div>
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
                    {mode === 'raw' && selectedMmsi && (
                        <>
                            <button
                                type="button"
                                className="btn"
                                onClick={doShipPull}
                                disabled={shipPulling}
                                style={{ marginTop: 6, width: '100%' }}
                                title="扫描全部所选索引、只保留这艘船，取它跨索引的完整航迹（索引大时较慢）"
                            >
                                <GcIcon name="ship" size={13} /> {shipPulling ? '扫描中…' : '拉取该船全部点（跨索引）'}
                            </button>
                            {shipPull && shipPull.mmsi === selectedMmsi && (
                                <div className="ais-hint">
                                    完整航迹：扫描 {shipPull.scanned.toLocaleString()} 报文 · {shipPull.points.length.toLocaleString()} 点
                                    {shipPull.truncated ? ' · 已达 20 万上限' : ''}
                                </div>
                            )}
                        </>
                    )}
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
                            <span
                                className="ais-toggle-text"
                                title="只影响地图上水域面怎么画（合并外框 vs 全部多边形）；判定 AIS 在不在水域内始终用精确的原始水域面"
                            >
                                水域面只显示合并外框
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
                    <NumberRow label="跳点最大距离 (公里)" value={traj.maxJumpKm} step={1} onChange={(v) => setTraj((t) => ({ ...t, maxJumpKm: Math.max(0, v) }))} />
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
                    <div className="ais-row-between">
                        <span className="ais-toggle-text">显示全部轨迹点（点击看详情）</span>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={showPoints}
                            className={`ais-toggle${showPoints ? ' on' : ''}`}
                            onClick={() => setShowPoints((v) => !v)}
                        >
                            <span className="ais-toggle-knob" />
                        </button>
                    </div>
                    {showPoints && (
                        <div className="ais-hint">点击地图上任意轨迹点查看 MMSI / 经纬度 / 航速 / 航向 / 时间。点多时已用 canvas 渲染，仅在拖动地图时可能略有延迟。</div>
                    )}
                </div>
            </div>

            {/* 右地图 */}
            <div className="ais-map-wrap">
                <button
                    type="button"
                    className="ais-panel-toggle"
                    onClick={() => setPanelOpen((v) => !v)}
                    title={panelOpen ? '收起配置栏' : '展开配置栏'}
                >
                    {panelOpen ? '‹' : '›'}
                </button>
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
                        droppedPoints={showDropped ? cleaned.droppedPoints : EMPTY_POINTS}
                        showPoints={showPoints}
                        hiddenTrips={hiddenTrips}
                        fitKey={`${connId}|${selectedMmsi}|${baseCrs}|${[...hiddenTrips].sort((a, b) => a - b).join(',')}`}
                    />
                </MapContainer>

                {/* 顶部状态条 */}
                <div className="ais-map-status">
                    {selectedIndices.length > 0 && mappingReady && (
                        <span
                            className="ais-chip"
                            style={{ maxWidth: 460, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                            title={`索引（${selectedIndices.length}）：${selectedIndices.join(', ')}\n映射：${mappingSummary(queryDataMode, queryMapping)}`}
                        >
                            <GcIcon name="layers" size={11} /> {selectedIndices.length} 索引 · {mappingSummary(queryDataMode, queryMapping)}
                        </span>
                    )}
                    {routeError && <span className="ais-chip err">{routeError}</span>}
                    {selectedMmsi && (
                        <span className="ais-chip">
                            {selectedMmsi} · {wgsPoints.length.toLocaleString()}
                            {mode === 'fields' && routeTotal ? `/${routeTotal.toLocaleString()}` : ''} 点
                            {routeLoading ? ' · 加载中…' : ''}
                        </span>
                    )}
                    {selectedMmsi && !routeLoading && stationary && (
                        <span className="ais-chip warn">
                            该船基本停泊未移动 · 无航线（{stationary.count.toLocaleString()} 点集中在 ~
                            {Math.round(stationary.spanM)} m 内，换一艘船看航迹）
                        </span>
                    )}
                    {selectedMmsi && cleaned.noTime && (
                        <span className="ais-chip warn">无时间字段 · 按报文顺序展示（停泊/航次分析不可用）</span>
                    )}
                    {selectedMmsi && cleaned.dropped > 0 && (
                        <button
                            type="button"
                            className={`ais-chip ais-chip-btn${showDropped ? ' on' : ''}`}
                            onClick={() => setShowDropped((v) => !v)}
                            title={showDropped ? '点击隐藏被清洗掉的点' : '点击在地图上显示被清洗掉的跳点/重复点'}
                        >
                            清洗掉 {cleaned.dropped} 个跳点/重复 · {showDropped ? '隐藏' : '查看'}
                        </button>
                    )}
                    {selectedMmsi && cleaned.trips.length > 1 && (
                        <span className="ais-chip">{cleaned.trips.length} 个航次</span>
                    )}
                    {mode === 'fields' && routeTruncated && (
                        <span className="ais-chip warn">已达 {routeMax.toLocaleString()} 点上限 · 可调大「最多点数」或缩小时间范围</span>
                    )}
                    {mode === 'raw' && pullStats?.truncated && (
                        <span className="ais-chip warn">解码已达上限，请缩小时间范围</span>
                    )}
                    {filterOn && anomalies.length > 0 && (
                        <span className="ais-chip danger">过滤掉 {anomalies.length} 个水域外点</span>
                    )}
                </div>

                {/* 浮动航次面板（可收起/展开，按航次着色 + 勾选/单看显隐） */}
                {selectedMmsi && tripSummaries.length > 1 && (
                    <div className={`ais-trips-float${tripsOpen ? '' : ' collapsed'}`}>
                        <div className="ais-trips-float-head">
                            <button
                                type="button"
                                className="ais-trips-head"
                                onClick={() => setTripsOpen((v) => !v)}
                                title="展开/收起航次列表"
                            >
                                <span className="ais-tri">{tripsOpen ? '▾' : '▸'}</span>
                                航次 {visibleTripCount}/{tripSummaries.length}
                            </button>
                            {tripsOpen && (
                                <div className="ais-trips-actions">
                                    <button type="button" className="ais-mini-btn" onClick={showAllTrips}>全选</button>
                                    <button type="button" className="ais-mini-btn" onClick={invertTrips}>反选</button>
                                </div>
                            )}
                        </div>
                        {tripsOpen && (
                            <div className="ais-trip-list">
                                {tripSummaries.map((t, rank) => {
                                    const hidden = hiddenTrips.has(t.i)
                                    return (
                                        <div key={t.i} className={`ais-trip-row${hidden ? ' off' : ''}`}>
                                            <label className="ais-trip-pick" title="显示/隐藏该航次">
                                                <input
                                                    type="checkbox"
                                                    checked={!hidden}
                                                    onChange={() => toggleTrip(t.i)}
                                                />
                                                <span className="ais-trip-dot" style={{ background: tripColor(t.i) }} />
                                            </label>
                                            <div className="ais-trip-info">
                                                <div className="ais-trip-title">
                                                    航次 {rank + 1} · {t.count} 点 · {fmtDist(t.distM)}
                                                </div>
                                                <div className="ais-trip-time">{fmtSpan(t.startTs, t.endTs)}</div>
                                            </div>
                                            <button
                                                type="button"
                                                className="ais-mini-btn"
                                                onClick={() => soloTrip(t.i)}
                                                title="只看该航次（隐藏其它并定位过去）"
                                            >
                                                单看
                                            </button>
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                    </div>
                )}

                {/* 图例 */}
                <div className="ais-legend">
                    <div className="ais-legend-row"><i className="lg-line sail" /> 行驶航线</div>
                    <div className="ais-legend-row"><i className="lg-line conn" /> 停泊跨段</div>
                    <div className="ais-legend-row"><i className="lg-anchor"><GcIcon name="anchor" size={11} /></i> 停泊点 + 摆动圈</div>
                    {filterOn && <div className="ais-legend-row"><i className="lg-dot anomaly" /> 水域外异常点</div>}
                    {showDropped && <div className="ais-legend-row"><i className="lg-dot dropped" /> 清洗掉的跳点</div>}
                    {waterLayer !== 'none' && <div className="ais-legend-row"><i className={`lg-water ${waterKind}`} /> 水域面</div>}
                </div>
            </div>
            {indexPickerOpen && (
                <IndexPickerDialog
                    indices={availIndices}
                    selected={selectedIndices}
                    onApply={setSel}
                    onClose={() => setIndexPickerOpen(false)}
                />
            )}
        </div>
    )
}

function MapInput({
    label,
    value,
    onChange,
}: {
    label: string
    value: string
    onChange: (v: string) => void
}) {
    return (
        <div className="ais-num-row">
            <span>{label}</span>
            <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="字段路径，如 a.b.c" />
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
