import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer, useMap, useMapEvents } from 'react-leaflet'
import { GcIcon, PlatformBadge } from '@/components/shell'
import type { PlatformKey } from '@/lib/shellData'
import { usePoiData, type FullPOI, type FullBuoy } from '@/lib/poiDataContext'
import { ClusteredMarkers, type ClusterPoint } from './ClusteredMarkers'
import 'leaflet/dist/leaflet.css'

type ViewMode = 'list' | 'split' | 'map'
type DataType = 'poi' | 'buoy'

type POI = FullPOI
type BuoyInfo = FullBuoy

interface Bounds {
    south: number
    west: number
    north: number
    east: number
}

const PLATFORMS: PlatformKey[] = ['tianditu', 'amap', 'baidu', 'osm']

const PAGE_SIZE = 50

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
        const t1 = setTimeout(() => map.invalidateSize(), 50)
        const t2 = setTimeout(() => map.invalidateSize(), 250)
        return () => { clearTimeout(t1); clearTimeout(t2) }
    }, [map, trigger])
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
    useEffect(() => {
        if (point) map.panTo(point, { animate: true })
    }, [map, point])
    return null
}

function MapClickClearer({ onClickEmpty }: { onClickEmpty: () => void }) {
    useMapEvents({ click: () => onClickEmpty() })
    return null
}

const MAP_MARKER_CAP = 1500

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
    const { poi, buoy } = usePoiData()
    const [dataType, setDataType] = useState<DataType>('poi')
    const [view, setView] = useState<ViewMode>('split')
    const [query, setQuery] = useState('')
    const [debouncedQuery, setDebouncedQuery] = useState('')
    // useDeferredValue lets typing stay snappy: query updates UI immediately,
    // but the 23k filter only re-runs with this deferred value at React's leisure.
    const deferredQuery = useDeferredValue(debouncedQuery)
    const [activePf, setActivePf] = useState<Set<PlatformKey>>(new Set(PLATFORMS))
    const [bounds, setBounds] = useState<Bounds | null>(null)
    const [activeId, setActiveId] = useState<string | number | null>(null)
    const [page, setPage] = useState(1)
    const fitOnceRef = useRef(false)
    const [initialFit, setInitialFit] = useState<Bounds | null>(null)

    const allPois = poi.items
    const allBuoys = buoy.items
    const allLoading = (dataType === 'poi' ? poi.loading : buoy.loading)

    // Debounce search input so 23k filter doesn't run on every keystroke.
    useEffect(() => {
        const t = setTimeout(() => setDebouncedQuery(query.trim().toLowerCase()), 180)
        return () => clearTimeout(t)
    }, [query])

    // One-shot map fit once data has loaded (not on every batch update).
    useEffect(() => {
        if (fitOnceRef.current) return
        const src: [number, number][] = dataType === 'poi'
            ? allPois.map(p => [p.lat, p.lon])
            : allBuoys
                .filter(b => b.lat_84 != null && b.lon_84 != null)
                .map(b => [b.lat_84!, b.lon_84!])
        if (src.length < 50) return
        let s = 90, w = 180, n = -90, e = -180
        for (const [la, lo] of src) {
            if (la < s) s = la
            if (la > n) n = la
            if (lo < w) w = lo
            if (lo > e) e = lo
        }
        fitOnceRef.current = true
        setInitialFit({ south: s, west: w, north: n, east: e })
    }, [dataType, allPois, allBuoys])

    // Reset fit lock when dataType switches so the new dataset re-fits once.
    useEffect(() => {
        fitOnceRef.current = false
        setInitialFit(null)
    }, [dataType])

    const togglePf = (p: PlatformKey) => {
        setActivePf(s => {
            const n = new Set(s)
            if (n.has(p)) n.delete(p); else n.add(p)
            return n
        })
    }

    // List pane filtering — by query + platform, no bounds.
    // Uses the pre-lowercased `_search` field built once at stream time.
    const filteredPois = useMemo(() => {
        const q = deferredQuery
        const list = allPois.filter(p => activePf.has(p.platform as PlatformKey))
        if (!q) return list
        return list.filter(p => p._search.includes(q))
    }, [allPois, deferredQuery, activePf])

    const filteredBuoys = useMemo(() => {
        const q = deferredQuery
        if (!q) return allBuoys
        return allBuoys.filter(b => b._search.includes(q))
    }, [allBuoys, deferredQuery])

    // Map markers — filteredPois intersected with current viewport.
    // Capped so dense viewports stay smooth; cluster layer handles aggregation.
    const mapPois = useMemo(() => {
        if (!bounds || view === 'list') return [] as POI[]
        const { south, west, north, east } = bounds
        const out: POI[] = []
        for (const p of filteredPois) {
            if (p.lat >= south && p.lat <= north && p.lon >= west && p.lon <= east) {
                out.push(p)
                if (out.length >= MAP_MARKER_CAP) break
            }
        }
        return out
    }, [filteredPois, bounds, view])

    const mapBuoys = useMemo(() => {
        if (!bounds || view === 'list') return [] as BuoyInfo[]
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
    }, [filteredBuoys, bounds, view])

    const poiClusterPoints = useMemo<ClusterPoint[]>(
        () => mapPois.map((p, i) => ({
            key: p.id, lat: p.lat, lon: p.lon, platform: p.platform, label: i + 1,
        })),
        [mapPois]
    )
    const buoyClusterPoints = useMemo<ClusterPoint[]>(
        () => mapBuoys.map((b, i) => ({
            key: b.id, lat: b.lat_84!, lon: b.lon_84!, platform: 'osm', label: i + 1,
        })),
        [mapBuoys]
    )

    // Reset page when filters change.
    useEffect(() => { setPage(1) }, [deferredQuery, activePf, dataType])

    // Stable click handlers so memo rows don't re-render on every parent update.
    const selectPoi = useCallback((id: number) => setActiveId(id), [])
    const selectBuoy = useCallback((id: string) => setActiveId(id), [])

    const totalItems = dataType === 'poi' ? filteredPois.length : filteredBuoys.length
    const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE))
    const currentPage = Math.min(page, totalPages)
    const pageStart = (currentPage - 1) * PAGE_SIZE

    const pagedPois = useMemo(
        () => filteredPois.slice(pageStart, pageStart + PAGE_SIZE),
        [filteredPois, pageStart]
    )
    const pagedBuoys = useMemo(
        () => filteredBuoys.slice(pageStart, pageStart + PAGE_SIZE),
        [filteredBuoys, pageStart]
    )

    const activePoint = useMemo<[number, number] | null>(() => {
        if (activeId == null) return null
        if (dataType === 'poi') {
            const p = filteredPois.find(x => x.id === activeId)
            return p ? [p.lat, p.lon] : null
        }
        const b = filteredBuoys.find(x => x.id === activeId)
        return b && b.lat_84 != null && b.lon_84 != null ? [b.lat_84, b.lon_84] : null
    }, [activeId, filteredPois, filteredBuoys, dataType])

    // Per-platform viewport count for the legend
    const viewportByPlatform = useMemo(() => {
        const out: Record<string, number> = {}
        for (const pf of PLATFORMS) out[pf] = 0
        for (const p of mapPois) {
            if (out[p.platform] != null) out[p.platform]!++
        }
        return out
    }, [mapPois])

    const showMap = view !== 'list'
    const showList = view !== 'map'

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
                </div>
            </div>

            {/* Layout */}
            <div
                className="dh-layout"
                style={{
                    gridTemplateColumns:
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
                        <TileLayer
                            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                            maxZoom={19}
                            attribution="© OpenStreetMap"
                        />
                        <BoundsTracker onChange={setBounds} />
                        <MapClickClearer onClickEmpty={() => setActiveId(null)} />
                        <PanToWhenActive point={activePoint} />
                        <MapResizeOnView trigger={view} />
                        <FitToBounds bounds={initialFit} />
                        <ClusteredMarkers
                            points={dataType === 'poi' ? poiClusterPoints : buoyClusterPoints}
                            activeKey={activeId}
                            onSelect={setActiveId}
                        />
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
