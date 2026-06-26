import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { MapContainer, TileLayer, useMap, useMapEvents } from 'react-leaflet'
import { CachedOsmTileLayer } from '@/components/CachedOsmTileLayer'
import { GcIcon, PlatformBadge } from '@/components/shell'
import type { PlatformKey } from '@/lib/shellData'
import {
    useSearchPois,
    useAllBuoys,
    fetchPoiExtent,
    fetchBuoyExtent,
    type POI,
    type FullBuoy as BuoyInfo,
    type BoundsArg as Bounds,
} from '@/lib/searchHooks'
import { ClusteredMarkers, type ClusterPoint } from './ClusteredMarkers'
import {
    ChartOverlayLayer,
    ChartFeatureOverlay,
    FitChartBounds,
    ChartZoomIndicator,
    fetchCjhyTasks,
    type CjhyTask,
} from './ChartOverlay'
import 'leaflet/dist/leaflet.css'

type ViewMode = 'list' | 'split' | 'map'
type DataType = 'poi' | 'buoy' | 'chart'

const PLATFORMS: PlatformKey[] = ['tianditu', 'amap', 'baidu', 'osm']

const PAGE_SIZE = 50

// 水域面「仅边框 / 全部」偏好的持久化键
const HYDRO_OUTLINE_KEY = 'dh-hydro-outline-only'

function BoundsTracker({ onChange }: { onChange: (b: Bounds) => void }) {
    const map = useMap()
    useEffect(() => {
        let timer: number | null = null
        const emit = () => {
            const b = map.getBounds()
            onChange({
                south: b.getSouth(),
                west: b.getWest(),
                north: b.getNorth(),
                east: b.getEast(),
            })
        }
        const debouncedEmit = () => {
            if (timer != null) window.clearTimeout(timer)
            timer = window.setTimeout(emit, 120)
        }
        // First emit synchronous so the initial filter runs immediately.
        emit()
        map.on('moveend zoomend', debouncedEmit)
        return () => {
            map.off('moveend zoomend', debouncedEmit)
            if (timer != null) window.clearTimeout(timer)
        }
    }, [map, onChange])
    return null
}

function MapResizeOnView({ trigger }: { trigger: unknown }) {
    const map = useMap()
    useEffect(() => {
        // Run after the grid layout has applied the new column template.
        let frame = 0
        const resize = () => {
            if (frame) cancelAnimationFrame(frame)
            frame = requestAnimationFrame(() => {
                frame = 0
                map.invalidateSize({ pan: false })
            })
        }
        resize()
        const t1 = setTimeout(resize, 50)
        const t2 = setTimeout(resize, 250)
        const t3 = setTimeout(resize, 600)
        return () => {
            clearTimeout(t1)
            clearTimeout(t2)
            clearTimeout(t3)
            if (frame) cancelAnimationFrame(frame)
        }
    }, [map, trigger])

    useEffect(() => {
        const container = map.getContainer()
        let frame = 0
        const resize = () => {
            if (frame) cancelAnimationFrame(frame)
            frame = requestAnimationFrame(() => map.invalidateSize({ pan: false }))
        }
        const observer = new ResizeObserver(resize)
        observer.observe(container)
        return () => {
            if (frame) cancelAnimationFrame(frame)
            observer.disconnect()
        }
    }, [map])

    return null
}

function MapZoomBounds({ minZoom, maxZoom }: { minZoom: number; maxZoom: number }) {
    const map = useMap()
    useEffect(() => {
        map.setMinZoom(minZoom)
        map.setMaxZoom(maxZoom)
        const zoom = map.getZoom()
        if (zoom < minZoom) map.setZoom(minZoom)
        if (zoom > maxZoom) map.setZoom(maxZoom)
    }, [map, minZoom, maxZoom])
    return null
}

function FitToBounds({ bounds }: { bounds: Bounds | null }) {
    const map = useMap()
    useEffect(() => {
        if (!bounds) return
        map.fitBounds(
            [[bounds.south, bounds.west], [bounds.north, bounds.east]],
            { padding: [40, 40], maxZoom: 13 }
        )
    }, [map, bounds])
    return null
}

function PanToWhenActive({ point }: { point: [number, number] | null }) {
    const map = useMap()
    const lastRef = useRef<[number, number] | null>(null)
    useEffect(() => {
        if (!point) {
            lastRef.current = null
            return
        }
        const last = lastRef.current
        if (last && last[0] === point[0] && last[1] === point[1]) return
        lastRef.current = point
        map.panTo(point, { animate: true })
    }, [map, point])
    return null
}

function MapClickClearer({ onClickEmpty }: { onClickEmpty: () => void }) {
    useMapEvents({ click: () => onClickEmpty() })
    return null
}

const MAP_MARKER_CAP = 1500

const PLATFORM_LABEL_CN: Record<string, string> = {
    tianditu: '天地图',
    amap: '高德',
    baidu: '百度',
    osm: 'OSM',
    google: '谷歌',
    tencent: '腾讯',
    cjhd: '长江航道图',
}

const CHART_LAYER_LABEL: Record<string, string> = {
    yizhangtu: '航道图',
    cjshoudong: '水域',
    soundg: '水深',
    electronic_fence: '航道要素',
    HYDRO_A: '水域面',
}

const CHART_LAYER_ICON: Record<string, string> = {
    yizhangtu: 'map',
    cjshoudong: 'layers',
    soundg: 'layers',
    electronic_fence: 'polygon',
    HYDRO_A: 'layers',
}

const CHART_RASTER_LAYERS = new Set(['yizhangtu', 'cjshoudong', 'soundg'])
const AMAP_STREET_URL = 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}'
const AMAP_SUBDOMAINS = ['1', '2', '3', '4']

function esc(s: string | null | undefined): string {
    if (s == null) return ''
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}

function buildPoiPopup(p: POI): string {
    const pfLabel = PLATFORM_LABEL_CN[p.platform] ?? p.platform
    const rows: string[] = []
    if (p.address) rows.push(`<div class="pop-row"><span class="pop-k">地址</span><span class="pop-v">${esc(p.address)}</span></div>`)
    if (p.category) rows.push(`<div class="pop-row"><span class="pop-k">类别</span><span class="pop-v">${esc(p.category)}</span></div>`)
    if (p.phone) rows.push(`<div class="pop-row"><span class="pop-k">电话</span><span class="pop-v mono">${esc(p.phone)}</span></div>`)
    rows.push(`<div class="pop-row"><span class="pop-k">坐标</span><span class="pop-v mono">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}</span></div>`)
    rows.push(`<div class="pop-row"><span class="pop-k">来源</span><span class="pop-v">${esc(pfLabel)} · #${p.id}</span></div>`)
    return `<div class="poi-pop"><div class="pop-title">${esc(p.name) || '(未命名)'}</div>${rows.join('')}</div>`
}

function buildBuoyPopup(b: BuoyInfo): string {
    const rows: string[] = []
    if (b.waterway) rows.push(`<div class="pop-row"><span class="pop-k">航道</span><span class="pop-v">${esc(b.waterway)}</span></div>`)
    if (b.region) rows.push(`<div class="pop-row"><span class="pop-k">地区</span><span class="pop-v">${esc(b.region)}</span></div>`)
    if (b.shape) rows.push(`<div class="pop-row"><span class="pop-k">形状</span><span class="pop-v">${esc(b.shape)}</span></div>`)
    if (b.color) rows.push(`<div class="pop-row"><span class="pop-k">颜色</span><span class="pop-v">${esc(b.color)}</span></div>`)
    if (b.light_info) rows.push(`<div class="pop-row"><span class="pop-k">灯质</span><span class="pop-v">${esc(b.light_info)}</span></div>`)
    if (b.buoy_type) rows.push(`<div class="pop-row"><span class="pop-k">类型</span><span class="pop-v">${esc(b.buoy_type)}</span></div>`)
    if (b.lat_84 != null && b.lon_84 != null) {
        rows.push(`<div class="pop-row"><span class="pop-k">坐标</span><span class="pop-v mono">${b.lat_84.toFixed(5)}, ${b.lon_84.toFixed(5)}</span></div>`)
    }
    rows.push(`<div class="pop-row"><span class="pop-k">编号</span><span class="pop-v mono">${esc(b.id)}</span></div>`)
    return `<div class="poi-pop"><div class="pop-title">${esc(b.name) || b.id}</div>${rows.join('')}</div>`
}

interface PoiRowProps {
    poi: POI
    index: number
    active: boolean
    onSelect: (id: number) => void
}

const PoiListRow = memo(function PoiListRow({ poi: p, index, active, onSelect }: PoiRowProps) {
    return (
        <div
            data-poi-id={p.id}
            className={`poi-row pf-${p.platform}${active ? ' active' : ''}`}
            onClick={() => onSelect(p.id)}
        >
            <div className="poi-marker">{index}</div>
            <div className="poi-main">
                <div className="poi-name">{p.name}</div>
                {p.address && <div className="poi-addr">{p.address}</div>}
                <div className="poi-foot">
                    <PlatformBadge name={p.platform} />
                    {p.category && <><span>·</span><span>{p.category}</span></>}
                    <span>·</span>
                    <span>{p.lat.toFixed(4)}, {p.lon.toFixed(4)}</span>
                </div>
            </div>
        </div>
    )
})

interface BuoyRowProps {
    buoy: BuoyInfo
    index: number
    active: boolean
    onSelect: (id: string) => void
}

const BuoyListRow = memo(function BuoyListRow({ buoy: b, index, active, onSelect }: BuoyRowProps) {
    return (
        <div
            data-poi-id={b.id}
            className={`poi-row pf-osm${active ? ' active' : ''}`}
            onClick={() => onSelect(b.id)}
        >
            <div className="poi-marker">{index}</div>
            <div className="poi-main">
                <div className="poi-name">{b.name || b.id}</div>
                {(b.waterway || b.region) && (
                    <div className="poi-addr">
                        {[b.waterway, b.region].filter(Boolean).join(' · ')}
                    </div>
                )}
                <div className="poi-foot">
                    <span className="type-badge t-aton">航标</span>
                    {b.shape && <><span>·</span><span>{b.shape}</span></>}
                    {b.lat_84 != null && b.lon_84 != null && (
                        <><span>·</span><span>{b.lat_84.toFixed(4)}, {b.lon_84.toFixed(4)}</span></>
                    )}
                </div>
            </div>
        </div>
    )
})

export function BrowseView() {
    const [dataType, setDataType] = useState<DataType>('poi')
    const [view, setView] = useState<ViewMode>('split')
    const [query, setQuery] = useState('')
    const [debouncedQuery, setDebouncedQuery] = useState('')
    const deferredQuery = useDeferredValue(debouncedQuery)
    const [activePf, setActivePf] = useState<Set<PlatformKey>>(new Set(PLATFORMS))
    const [bounds, setBounds] = useState<Bounds | null>(null)
    const [activeId, setActiveId] = useState<string | number | null>(null)
    const [page, setPage] = useState(1)
    const fitOnceRef = useRef<string | null>(null)
    const [initialFit, setInitialFit] = useState<Bounds | null>(null)
    const [, startTransition] = useTransition()

    // 航道图（cjhy）相关状态
    const [chartTasks, setChartTasks] = useState<CjhyTask[]>([])
    const [chartTaskId, setChartTaskId] = useState<string>('')
    const [chartLoaded, setChartLoaded] = useState(false)
    const [visibleChartLayers, setVisibleChartLayers] = useState<Set<string>>(new Set())
    // 水域面默认只画最外层边框，可切到「全部」看完整嵌套；偏好持久化到 localStorage
    const [hydroOutlineOnly, setHydroOutlineOnly] = useState(
        () => localStorage.getItem(HYDRO_OUTLINE_KEY) !== '0',
    )
    useEffect(() => {
        localStorage.setItem(HYDRO_OUTLINE_KEY, hydroOutlineOnly ? '1' : '0')
    }, [hydroOutlineOnly])
    useEffect(() => {
        if (dataType !== 'chart' || chartLoaded) return
        fetchCjhyTasks().then(list => {
            setChartTasks(list)
            setChartLoaded(true)
            if (list.length > 0 && !chartTaskId) setChartTaskId(list[0].id)
        }).catch(() => { setChartLoaded(true) })
    }, [dataType, chartLoaded, chartTaskId])
    const selectedChartTask = useMemo(
        () => chartTasks.find(t => t.id === chartTaskId) ?? null,
        [chartTasks, chartTaskId]
    )
    useEffect(() => {
        if (!selectedChartTask) {
            setVisibleChartLayers(new Set())
            return
        }
        // 任务自带图层 + 默认开启矢量水域面/航道要素（这些要素全局存储、不一定记在任务的
        // layers 里，但库里若有就应在任务区域内显示，避免"采过却看不到"）。
        setVisibleChartLayers(
            new Set([...selectedChartTask.available_layers, 'HYDRO_A', 'electronic_fence']),
        )
    }, [selectedChartTask])
    const chartBounds: [number, number, number, number] | undefined = selectedChartTask
        ? [
            selectedChartTask.bounds_south,
            selectedChartTask.bounds_west,
            selectedChartTask.bounds_north,
            selectedChartTask.bounds_east,
        ]
        : undefined
    const chartQueryBounds = useMemo(
        () => selectedChartTask ? {
            west: selectedChartTask.bounds_west,
            south: selectedChartTask.bounds_south,
            east: selectedChartTask.bounds_east,
            north: selectedChartTask.bounds_north,
        } : undefined,
        [selectedChartTask]
    )
    const selectedRasterLayers = useMemo(
        () => selectedChartTask?.available_layers.filter(l => CHART_RASTER_LAYERS.has(l)) ?? [],
        [selectedChartTask]
    )
    // 工具栏图层：任务自带图层 + 始终可切换的矢量水域面/航道要素（即使任务未列出，
    // 库里若有这些要素也能在任务区域内显示）
    const toolbarLayers = useMemo(() => {
        const base = selectedChartTask?.available_layers ?? []
        const extra = ['HYDRO_A', 'electronic_fence'].filter(l => !base.includes(l))
        return [...base, ...extra]
    }, [selectedChartTask])
    const toggleChartLayer = (layer: string) => {
        setVisibleChartLayers(prev => {
            const next = new Set(prev)
            if (next.has(layer)) next.delete(layer)
            else next.add(layer)
            return next
        })
    }

    // Debounce search input — push into a transition so React can interrupt
    // the heavy filter / re-render if the user keeps typing.
    useEffect(() => {
        const t = setTimeout(() => {
            startTransition(() => setDebouncedQuery(query.trim().toLowerCase()))
        }, 180)
        return () => clearTimeout(t)
    }, [query])

    // One-shot fit map to overall data extent per dataType.
    useEffect(() => {
        const key = dataType
        if (fitOnceRef.current === key) return
        fitOnceRef.current = key
        setInitialFit(null)
        const job = dataType === 'poi' ? fetchPoiExtent() : fetchBuoyExtent()
        job.then((ext) => {
            if (ext && fitOnceRef.current === key) setInitialFit(ext)
        }).catch(() => { /* ignore */ })
    }, [dataType])

    const platformsArr = useMemo(
        () => activePf.size === PLATFORMS.length ? [] : Array.from(activePf),
        [activePf]
    )

    // List pane: paginated server search, no bounds.
    const listFilters = useMemo(
        () => dataType === 'poi'
            ? { query: deferredQuery || null, platforms: platformsArr, bounds: null }
            : null,
        [dataType, deferredQuery, platformsArr]
    )
    const listPagination = useMemo(
        () => ({ limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
        [page]
    )
    const listResult = useSearchPois(
        listFilters ?? { query: null, platforms: [], bounds: null },
        listPagination
    )
    const poiListLoading = dataType === 'poi' && listResult.loading
    const pagedPois = dataType === 'poi' ? listResult.items : []
    const poiTotal = dataType === 'poi' ? listResult.total : 0

    // Buoys: full dataset cached client-side, filter locally (small data).
    const buoyAll = useAllBuoys()
    const buoyListLoading = dataType === 'buoy' && buoyAll.loading
    const filteredBuoys = useMemo(() => {
        if (dataType !== 'buoy') return [] as BuoyInfo[]
        const q = deferredQuery
        if (!q) return buoyAll.items
        return buoyAll.items.filter(b => {
            const s = `${b.id ?? ''}|${b.name ?? ''}|${b.waterway ?? ''}|${b.region ?? ''}|${b.shape ?? ''}|${b.buoy_type ?? ''}`.toLowerCase()
            return s.includes(q)
        })
    }, [dataType, deferredQuery, buoyAll.items])
    const pagedBuoys = useMemo(
        () => filteredBuoys.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
        [filteredBuoys, page]
    )
    const buoyTotal = filteredBuoys.length

    // Map markers: same filter as list, but with current bounds and large limit.
    const mapFilters = useMemo(
        () => dataType === 'poi' && view !== 'list' && bounds
            ? { query: deferredQuery || null, platforms: platformsArr, bounds }
            : null,
        [dataType, view, deferredQuery, platformsArr, bounds]
    )
    const mapPagination = useMemo(
        () => ({ limit: MAP_MARKER_CAP, offset: 0 }),
        []
    )
    const mapResult = useSearchPois(
        mapFilters ?? { query: null, platforms: ['__none__'], bounds: null },
        mapPagination
    )
    const mapPois: POI[] = mapFilters ? mapResult.items : []

    const mapBuoys = useMemo(() => {
        if (dataType !== 'buoy' || view === 'list' || !bounds) return [] as BuoyInfo[]
        const { south, west, north, east } = bounds
        const out: BuoyInfo[] = []
        for (const b of filteredBuoys) {
            if (b.lat_84 == null || b.lon_84 == null) continue
            if (b.lat_84 >= south && b.lat_84 <= north && b.lon_84 >= west && b.lon_84 <= east) {
                out.push(b)
                if (out.length >= MAP_MARKER_CAP) break
            }
        }
        return out
    }, [filteredBuoys, bounds, view, dataType])

    const allLoading = poiListLoading || buoyListLoading

    const togglePf = (p: PlatformKey) => {
        startTransition(() => {
            setActivePf(s => {
                const n = new Set(s)
                if (n.has(p)) n.delete(p); else n.add(p)
                return n
            })
        })
    }

    const poiClusterPoints = useMemo<ClusterPoint[]>(
        () => mapPois.map((p, i) => ({
            key: p.id,
            lat: p.lat,
            lon: p.lon,
            platform: p.platform,
            label: i + 1,
            name: p.name || '(未命名)',
            popupHtml: buildPoiPopup(p),
        })),
        [mapPois]
    )
    const buoyClusterPoints = useMemo<ClusterPoint[]>(
        () => mapBuoys.map((b, i) => ({
            key: b.id,
            lat: b.lat_84!,
            lon: b.lon_84!,
            platform: 'osm',
            label: i + 1,
            name: b.name || String(b.id),
            popupHtml: buildBuoyPopup(b),
        })),
        [mapBuoys]
    )

    // Reset page when filters change.
    useEffect(() => { setPage(1) }, [deferredQuery, activePf, dataType])

    // Stable click handlers so memo rows don't re-render on every parent update.
    const selectPoi = useCallback((id: number) => setActiveId(id), [])
    const selectBuoy = useCallback((id: string) => setActiveId(id), [])

    const totalItems = dataType === 'poi' ? poiTotal : buoyTotal
    const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE))
    const currentPage = Math.min(page, totalPages)
    const pageStart = (currentPage - 1) * PAGE_SIZE

    const activePoint = useMemo<[number, number] | null>(() => {
        if (activeId == null) return null
        if (dataType === 'poi') {
            const p = pagedPois.find(x => x.id === activeId) ?? mapPois.find(x => x.id === activeId)
            return p ? [p.lat, p.lon] : null
        }
        const b = pagedBuoys.find(x => x.id === activeId) ?? mapBuoys.find(x => x.id === activeId)
        return b && b.lat_84 != null && b.lon_84 != null ? [b.lat_84, b.lon_84] : null
    }, [activeId, pagedPois, pagedBuoys, mapPois, mapBuoys, dataType])

    // Per-platform viewport count for the legend
    const viewportByPlatform = useMemo(() => {
        const out: Record<string, number> = {}
        for (const pf of PLATFORMS) out[pf] = 0
        for (const p of mapPois) {
            if (out[p.platform] != null) out[p.platform]!++
        }
        return out
    }, [mapPois])

    // 航道图模式只有地图视图（没有"行"语义可列）
    const showMap = dataType === 'chart' || view !== 'list'
    const showList = dataType !== 'chart' && view !== 'map'

    return (
        <div className="flex h-full min-h-0 flex-col">
            {/* Sub-toolbar */}
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
                    <button
                        type="button"
                        className={dataType === 'poi' ? 'active' : ''}
                        onClick={() => { setDataType('poi'); setActiveId(null) }}
                    >
                        <GcIcon name="mapPin" size={11} style={{ marginRight: 4, verticalAlign: '-1px' }} />
                        POI
                    </button>
                    <button
                        type="button"
                        className={dataType === 'buoy' ? 'active' : ''}
                        onClick={() => { setDataType('buoy'); setActiveId(null) }}
                    >
                        <GcIcon name="navigation" size={11} style={{ marginRight: 4, verticalAlign: '-1px' }} />
                        航标
                    </button>
                    <button
                        type="button"
                        className={dataType === 'chart' ? 'active' : ''}
                        onClick={() => { setDataType('chart'); setActiveId(null) }}
                    >
                        <GcIcon name="map" size={11} style={{ marginRight: 4, verticalAlign: '-1px' }} />
                        航道图
                    </button>
                </div>

                {dataType === 'poi' && (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 6 }}>
                        {PLATFORMS.map(pf => (
                            <label key={pf} className="checkbox" style={{ height: 24 }}>
                                <input
                                    type="checkbox"
                                    checked={activePf.has(pf)}
                                    onChange={() => togglePf(pf)}
                                />
                                <PlatformBadge name={pf} />
                            </label>
                        ))}
                    </div>
                )}

                {dataType === 'chart' && (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 6 }}>
                        {chartTasks.length === 0 ? (
                            <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                                {chartLoaded ? '尚无航道图专题任务，可在「新建采集」创建' : '正在加载...'}
                            </span>
                        ) : (
                            <select
                                className="select"
                                value={chartTaskId}
                                onChange={e => setChartTaskId(e.target.value)}
                                style={{ width: 240, height: 26 }}
                            >
                                {chartTasks.map(t => (
                                    <option key={t.id} value={t.id}>
                                        {t.name}（{t.available_layers.map(l => CHART_LAYER_LABEL[l] ?? l).join(' / ')}）
                                    </option>
                                ))}
                            </select>
                        )}
                        <span style={{ width: 1, height: 18, background: 'var(--hairline)', margin: '0 4px' }} />
                        {toolbarLayers.map(layer => (
                            <label
                                key={layer}
                                className="checkbox"
                                style={{ height: 24 }}
                                title={`显示或隐藏${CHART_LAYER_LABEL[layer] ?? layer}`}
                            >
                                <input
                                    type="checkbox"
                                    checked={visibleChartLayers.has(layer)}
                                    onChange={() => toggleChartLayer(layer)}
                                />
                                <GcIcon name={CHART_LAYER_ICON[layer] ?? 'layers'} size={11} />
                                {CHART_LAYER_LABEL[layer] ?? layer}
                            </label>
                        ))}
                        {visibleChartLayers.has('HYDRO_A') && (
                            <>
                                <span style={{ width: 1, height: 18, background: 'var(--hairline)', margin: '0 4px' }} />
                                <div
                                    className="seg"
                                    title="水域面常是大大小小嵌套的多边形。默认只画最外层边框；切到「全部」显示完整嵌套内容"
                                >
                                    <button
                                        type="button"
                                        className={hydroOutlineOnly ? 'active' : ''}
                                        onClick={() => setHydroOutlineOnly(true)}
                                    >
                                        <GcIcon name="polygon" size={11} style={{ marginRight: 4, verticalAlign: '-1px' }} />
                                        水域面仅边框
                                    </button>
                                    <button
                                        type="button"
                                        className={!hydroOutlineOnly ? 'active' : ''}
                                        onClick={() => setHydroOutlineOnly(false)}
                                    >
                                        全部
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                )}

                <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                    {allLoading && (
                        <span
                            style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 6,
                                fontSize: 11.5,
                                color: 'var(--text-3)',
                            }}
                        >
                            <GcIcon name="refresh" size={11} />
                            加载中
                        </span>
                    )}
                    {dataType !== 'chart' && (
                        <div className="seg">
                            <button
                                type="button"
                                className={view === 'list' ? 'active' : ''}
                                onClick={() => setView('list')}
                                title="列表"
                            >
                                <GcIcon name="list" size={12} />
                            </button>
                            <button
                                type="button"
                                className={view === 'split' ? 'active' : ''}
                                onClick={() => setView('split')}
                                title="分屏"
                            >
                                <GcIcon name="layout" size={12} />
                            </button>
                            <button
                                type="button"
                                className={view === 'map' ? 'active' : ''}
                                onClick={() => setView('map')}
                                title="地图"
                            >
                                <GcIcon name="map" size={12} />
                            </button>
                        </div>
                    )}
                </div>
            </div>

            {/* Layout */}
            <div
                className="dh-layout"
                style={{
                    gridTemplateColumns:
                        dataType === 'chart' ? '1fr 0px' :
                            view === 'list' ? '1fr 0px' :
                                view === 'map' ? '1fr 0px' :
                                    '1fr 380px',
                }}
            >
                <div
                    className="dh-map-wrap"
                    style={{ display: showMap ? 'block' : 'none' }}
                >
                    <MapContainer
                        center={[31.23, 121.47]}
                        zoom={11}
                        zoomControl={false}
                        attributionControl
                        style={{ position: 'absolute', inset: 0 }}
                    >
                        {dataType === 'chart' ? (
                            <TileLayer
                                url={AMAP_STREET_URL}
                                subdomains={AMAP_SUBDOMAINS}
                                attribution="© 高德地图"
                                maxNativeZoom={18}
                                maxZoom={21}
                            />
                        ) : (
                            <CachedOsmTileLayer />
                        )}
                        <MapZoomBounds
                            minZoom={dataType === 'chart' ? 1 : 0}
                            maxZoom={dataType === 'chart' ? 21 : 19}
                        />
                        <BoundsTracker onChange={setBounds} />
                        <MapClickClearer onClickEmpty={() => setActiveId(null)} />
                        <PanToWhenActive point={activePoint} />
                        <MapResizeOnView trigger={`${dataType}:${view}:${chartTaskId}:${showMap}:${Array.from(visibleChartLayers).join(',')}`} />
                        <FitToBounds bounds={dataType === 'chart' ? null : initialFit} />
                        {dataType !== 'chart' && (
                            <ClusteredMarkers
                                key={dataType}
                                points={dataType === 'poi' ? poiClusterPoints : buoyClusterPoints}
                                activeKey={activeId}
                                onSelect={setActiveId}
                            />
                        )}
                        {dataType === 'chart' && (
                            <>
                                {selectedChartTask && (
                                    <>
                                        {selectedChartTask.output_path && selectedRasterLayers.map(layer => (
                                            <ChartOverlayLayer
                                                key={layer}
                                                basePath={selectedChartTask.output_path!}
                                                layer={layer}
                                                tileMode={selectedChartTask.tile_mode}
                                                visible={visibleChartLayers.has(layer)}
                                            />
                                        ))}
                                        <FitChartBounds bounds={chartBounds} />
                                    </>
                                )}
                                <ChartFeatureOverlay
                                    visible={Boolean(selectedChartTask && visibleChartLayers.has('HYDRO_A'))}
                                    sourceLayer="HYDRO_A"
                                    label={hydroOutlineOnly ? '水域面边框' : '水域面'}
                                    kind="hydro"
                                    fitBounds={false}
                                    controlOffsetTop={visibleChartLayers.has('electronic_fence') ? 38 : 0}
                                    queryBounds={chartQueryBounds}
                                    viewportLoad
                                    outlineOnly={hydroOutlineOnly}
                                />
                                <ChartFeatureOverlay
                                    visible={Boolean(selectedChartTask && visibleChartLayers.has('electronic_fence'))}
                                    sourceLayer="electronic_fence"
                                    label="航道要素"
                                    kind="fence"
                                    fitBounds={false}
                                    queryBounds={chartQueryBounds}
                                />
                                <ChartZoomIndicator />
                            </>
                        )}
                    </MapContainer>

                    {/* Viewport platform legend */}
                    {dataType === 'poi' && mapPois.length > 0 && (
                        <div
                            style={{
                                position: 'absolute', bottom: 12, left: 12, zIndex: 800,
                                background: 'var(--panel)', border: '1px solid var(--border)',
                                borderRadius: 8, padding: '8px 12px', boxShadow: 'var(--shadow)',
                                display: 'flex', gap: 14, alignItems: 'center',
                                fontSize: 11, color: 'var(--text-2)',
                            }}
                        >
                            <span style={{ fontWeight: 600, color: 'var(--text)' }}>当前视野</span>
                            {PLATFORMS.map(pf => (
                                <span key={pf} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                    <i
                                        style={{
                                            width: 8, height: 8, borderRadius: '50%',
                                            background: `var(--pf-${pf})`,
                                        }}
                                    />
                                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                                        {viewportByPlatform[pf] ?? 0}
                                    </span>
                                </span>
                            ))}
                        </div>
                    )}
                </div>

                {/* List pane */}
                {showList && (
                    <div
                        className="dh-list-pane"
                        style={{
                            width: view === 'list' ? '100%' : 380,
                            borderLeft: view === 'list' ? 0 : '1px solid var(--hairline)',
                        }}
                    >
                        <div className="dh-search">
                            <GcIcon name="search" size={13} style={{ color: 'var(--text-3)' }} />
                            <input
                                className="input"
                                value={query}
                                placeholder={dataType === 'poi'
                                    ? '搜索 POI 名称 / 地址 / 类别...'
                                    : '搜索航标名称 / 航道 / 地区...'}
                                style={{ border: 0, padding: 0, height: 'auto', background: 'transparent' }}
                                onChange={e => setQuery(e.target.value)}
                            />
                            {query && (
                                <button type="button" className="iconbtn" onClick={() => setQuery('')}>
                                    <GcIcon name="xCircle" size={13} />
                                </button>
                            )}
                        </div>
                        <div className="dh-toolbar">
                            <span className="count">{totalItems.toLocaleString()}</span>
                            <span>条记录</span>
                            <span style={{ flex: 1 }} />
                        </div>
                        <div className="dh-list">
                            {totalItems === 0 && !allLoading && (
                                <div className="empty" style={{ padding: '36px 16px' }}>
                                    <div className="empty-icon"><GcIcon name="search" size={20} /></div>
                                    <h4>没有匹配的{dataType === 'poi' ? ' POI ' : '航标'}</h4>
                                    <p>{query.trim() ? '调整搜索关键词试试。' : '当前还没有采集到任何数据。'}</p>
                                </div>
                            )}

                            {dataType === 'poi' && pagedPois.map((p, i) => (
                                <PoiListRow
                                    key={p.id}
                                    poi={p}
                                    index={pageStart + i + 1}
                                    active={p.id === activeId}
                                    onSelect={selectPoi}
                                />
                            ))}

                            {dataType === 'buoy' && pagedBuoys.map((b, i) => (
                                <BuoyListRow
                                    key={b.id}
                                    buoy={b}
                                    index={pageStart + i + 1}
                                    active={b.id === activeId}
                                    onSelect={selectBuoy}
                                />
                            ))}
                        </div>
                        {totalItems > 0 && (
                            <div
                                style={{
                                    padding: '8px 12px',
                                    borderTop: '1px solid var(--hairline)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 8,
                                    fontSize: 11.5,
                                    color: 'var(--text-3)',
                                }}
                            >
                                <span>
                                    共 <b style={{ color: 'var(--text)' }} className="tnum">{totalItems}</b> 条
                                </span>
                                <span style={{ flex: 1 }} />
                                <button
                                    type="button"
                                    className="btn ghost sm"
                                    onClick={() => setPage(p => Math.max(1, p - 1))}
                                    disabled={currentPage <= 1}
                                >
                                    上一页
                                </button>
                                <span className="tnum">{currentPage} / {totalPages}</span>
                                <button
                                    type="button"
                                    className="btn ghost sm"
                                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                                    disabled={currentPage >= totalPages}
                                >
                                    下一页
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    )
}
