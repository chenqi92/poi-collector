import { useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { MapContainer, TileLayer, Marker, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import { GcIcon, PlatformBadge } from '@/components/shell'
import type { PlatformKey } from '@/lib/shellData'
import 'leaflet/dist/leaflet.css'

type ViewMode = 'list' | 'split' | 'map'
type DataType = 'poi' | 'buoy'

interface POI {
    id: number
    name: string
    lon: number
    lat: number
    address?: string
    category?: string
    platform: string
}

interface Bounds {
    south: number
    west: number
    north: number
    east: number
}

interface BuoyInfo {
    id: string
    name: string | null
    lon_84: number | null
    lat_84: number | null
    buoy_type: string | null
    color: string | null
    waterway: string | null
    shape: string | null
    light_info: string | null
    region: string | null
}

const PLATFORMS: PlatformKey[] = ['tianditu', 'amap', 'baidu', 'osm']

const PAGE_SIZE = 50

function makeMarker(idx: number, platform: string, active: boolean) {
    return L.divIcon({
        html: `<div class="gc-marker pf-${platform}${active ? ' active' : ''}">${idx + 1}</div>`,
        className: '',
        iconSize: [22, 22],
        iconAnchor: [11, 11],
    })
}

function BoundsTracker({ onChange }: { onChange: (b: Bounds) => void }) {
    const map = useMap()
    useEffect(() => {
        const emit = () => {
            const b = map.getBounds()
            onChange({
                south: b.getSouth(),
                west: b.getWest(),
                north: b.getNorth(),
                east: b.getEast(),
            })
        }
        emit()
        map.on('moveend zoomend', emit)
        return () => { map.off('moveend zoomend', emit) }
    }, [map, onChange])
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

export function BrowseView() {
    const [dataType, setDataType] = useState<DataType>('poi')
    const [view, setView] = useState<ViewMode>('split')
    const [query, setQuery] = useState('')
    const [activePf, setActivePf] = useState<Set<PlatformKey>>(new Set(PLATFORMS))
    const [bounds, setBounds] = useState<Bounds | null>(null)
    const [pois, setPois] = useState<POI[]>([])
    const [buoys, setBuoys] = useState<BuoyInfo[]>([])
    const [loading, setLoading] = useState(false)
    const [activeId, setActiveId] = useState<string | number | null>(null)
    const [page, setPage] = useState(1)
    const poiSeqRef = useRef(0)
    const buoySeqRef = useRef(0)

    // Debounced reload on bounds / type / query / platforms
    useEffect(() => {
        if (!bounds) return
        if (dataType === 'poi') {
            const seq = ++poiSeqRef.current
            const t = setTimeout(async () => {
                setLoading(true)
                try {
                    const data = await invoke<POI[]>('search_poi_by_bounds', {
                        south: bounds.south,
                        west: bounds.west,
                        north: bounds.north,
                        east: bounds.east,
                        query: query.trim() || null,
                        platform: activePf.size === PLATFORMS.length ? null : Array.from(activePf)[0] ?? null,
                    })
                    if (seq === poiSeqRef.current) {
                        setPois(data)
                        setPage(1)
                    }
                } catch (e) { console.error(e) }
                finally { if (seq === poiSeqRef.current) setLoading(false) }
            }, 400)
            return () => clearTimeout(t)
        } else {
            const seq = ++buoySeqRef.current
            ;(async () => {
                setLoading(true)
                try {
                    const data = await invoke<BuoyInfo[]>('search_buoys_by_bounds', {
                        south: bounds.south,
                        west: bounds.west,
                        north: bounds.north,
                        east: bounds.east,
                    })
                    if (seq === buoySeqRef.current) {
                        setBuoys(data)
                        setPage(1)
                    }
                } catch (e) { console.error(e) }
                finally { if (seq === buoySeqRef.current) setLoading(false) }
            })()
        }
    }, [bounds, query, activePf, dataType])

    const togglePf = (p: PlatformKey) => {
        setActivePf(s => {
            const n = new Set(s)
            if (n.has(p)) n.delete(p); else n.add(p)
            return n
        })
    }

    const filteredPois = useMemo(() => {
        const q = query.trim().toLowerCase()
        const list = pois.filter(p => activePf.has(p.platform as PlatformKey))
        if (!q) return list
        return list.filter(p =>
            p.name.toLowerCase().includes(q) ||
            (p.address?.toLowerCase().includes(q) ?? false) ||
            (p.category?.toLowerCase().includes(q) ?? false)
        )
    }, [pois, query, activePf])

    const filteredBuoys = useMemo(() => {
        const q = query.trim().toLowerCase()
        if (!q) return buoys
        return buoys.filter(b =>
            (b.name?.toLowerCase().includes(q) ?? false) ||
            (b.waterway?.toLowerCase().includes(q) ?? false) ||
            (b.region?.toLowerCase().includes(q) ?? false) ||
            (b.id?.toLowerCase().includes(q) ?? false) ||
            (b.shape?.toLowerCase().includes(q) ?? false) ||
            (b.buoy_type?.toLowerCase().includes(q) ?? false)
        )
    }, [buoys, query])

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
        for (const p of filteredPois) {
            if (out[p.platform] != null) out[p.platform]!++
        }
        return out
    }, [filteredPois])

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
                    {loading && (
                        <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                            <GcIcon name="refresh" size={11} /> 加载中...
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
                        {dataType === 'poi' && filteredPois.map((p, i) => (
                            <Marker
                                key={p.id}
                                position={[p.lat, p.lon]}
                                icon={makeMarker(i, p.platform, p.id === activeId)}
                                eventHandlers={{ click: () => setActiveId(p.id) }}
                            />
                        ))}
                        {dataType === 'buoy' && filteredBuoys.map((b, i) => {
                            if (b.lat_84 == null || b.lon_84 == null) return null
                            return (
                                <Marker
                                    key={b.id}
                                    position={[b.lat_84, b.lon_84]}
                                    icon={makeMarker(i, 'osm', b.id === activeId)}
                                    eventHandlers={{ click: () => setActiveId(b.id) }}
                                />
                            )
                        })}
                    </MapContainer>

                    {/* Viewport platform legend */}
                    {dataType === 'poi' && filteredPois.length > 0 && (
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
                            {loading && <span style={{ color: 'var(--text-4)' }}>loading...</span>}
                        </div>
                        <div className="dh-list">
                            {totalItems === 0 && !loading && (
                                <div className="empty" style={{ padding: '36px 16px' }}>
                                    <div className="empty-icon"><GcIcon name="search" size={20} /></div>
                                    <h4>没有匹配的{dataType === 'poi' ? ' POI ' : '航标'}</h4>
                                    <p>移动地图视野，或调整搜索条件。</p>
                                </div>
                            )}

                            {dataType === 'poi' && pagedPois.map((p, i) => (
                                <div
                                    key={p.id}
                                    data-poi-id={p.id}
                                    className={`poi-row pf-${p.platform}${p.id === activeId ? ' active' : ''}`}
                                    onClick={() => setActiveId(p.id)}
                                >
                                    <div className="poi-marker">{pageStart + i + 1}</div>
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
                            ))}

                            {dataType === 'buoy' && pagedBuoys.map((b, i) => (
                                <div
                                    key={b.id}
                                    data-poi-id={b.id}
                                    className={`poi-row pf-osm${b.id === activeId ? ' active' : ''}`}
                                    onClick={() => setActiveId(b.id)}
                                >
                                    <div className="poi-marker">{pageStart + i + 1}</div>
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
                                                <>
                                                    <span>·</span>
                                                    <span>{b.lat_84.toFixed(4)}, {b.lon_84.toFixed(4)}</span>
                                                </>
                                            )}
                                        </div>
                                    </div>
                                </div>
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
