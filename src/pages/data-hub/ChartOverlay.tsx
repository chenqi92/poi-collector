import { useEffect, useRef, useState } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import { invoke } from '@tauri-apps/api/core'
import { geometryToPolygons, outermostPolygons, type WaterPolygon } from '@/lib/ais/geo'

/* 航道图（cjhy）使用 ArcGIS EPSG:4326 自定义切片方案：
   原点 (-400, 400)，每级分辨率减半。
   地图 zoom 与航道图 z 的关系：customZ = round(mapZoom) + 1 - 7。
*/
const CJ_RESOLUTIONS = [
    0.023794610058302794, 0.009517844023321119, 0.004758922011660559,
    0.0023794610058302797, 0.0011897305029151398, 0.0005948652514575699,
    0.00029743262572878496, 0.00014871631286439248, 0.00007435815643219624,
    0.00003717907821609812, 0.000018590728838551974, 0.000009294174688773071,
    0.000004647087344386536, 0.0000023794610058302796,
]
const CJ_ORIGIN = [-400, 400]
const TILE_SIZE = 256

export interface CjhyTask {
    id: string
    name: string
    source: string
    tile_mode?: 'legacy' | 'chart' | string | null
    output_path?: string | null
    available_layers: string[]
    total_tiles: number
    completed_tiles: number
    failed_tiles: number
    bounds_north: number
    bounds_south: number
    bounds_east: number
    bounds_west: number
    zoom_levels: number[]
    created_at?: string | null
    status: string
}

export function fetchCjhyTasks(): Promise<CjhyTask[]> {
    return invoke<CjhyTask[]>('chart_get_display_tasks')
}

export interface ChartFeature {
    id: string
    source: string
    source_layer: string
    source_feature_id?: string | null
    name?: string | null
    feature_type?: string | null
    geometry_type?: string | null
    geometry_json: string
    min_lon?: number | null
    min_lat?: number | null
    max_lon?: number | null
    max_lat?: number | null
    raw_json: string
}

export type ChartFeatureSourceLayer = 'electronic_fence' | 'HYDRO_A'
export type ChartFeatureOverlayKind = 'fence' | 'hydro'

interface ChartFeatureBounds {
    west: number
    south: number
    east: number
    north: number
}

export function fetchChartFeaturesByLayer(sourceLayer: ChartFeatureSourceLayer): Promise<ChartFeature[]> {
    return invoke<ChartFeature[]>('chart_get_features_by_layer', { sourceLayer })
}

export function fetchChartFeaturesByLayerInBounds(
    sourceLayer: ChartFeatureSourceLayer,
    bounds: ChartFeatureBounds,
): Promise<ChartFeature[]> {
    return invoke<ChartFeature[]>('chart_get_features_by_layer_in_bounds', {
        sourceLayer,
        west: bounds.west,
        south: bounds.south,
        east: bounds.east,
        north: bounds.north,
    })
}

const FEATURE_STYLES: Record<ChartFeatureOverlayKind, {
    pane: string
    zIndex: string
    stroke: string
    fill: string
    pointFill: string
    className: string
}> = {
    fence: {
        pane: 'chartFencePane',
        zIndex: '430',
        stroke: '#f59e0b',
        fill: '#fbbf24',
        pointFill: '#fde68a',
        className: 'chart-fence-shape',
    },
    hydro: {
        pane: 'chartHydroPane',
        zIndex: '420',
        stroke: '#0284c7',
        fill: '#38bdf8',
        pointFill: '#bae6fd',
        className: 'chart-hydro-shape',
    },
}

function esc(v: unknown): string {
    return String(v ?? '').replace(/[&<>"']/g, (s) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[s]!))
}

function popRow(k: string, v: unknown, mono = false): string {
    if (v === null || v === undefined || v === '') return ''
    return `<div class="pop-row"><span class="pop-k">${esc(k)}</span><span class="pop-v${mono ? ' mono' : ''}">${esc(v)}</span></div>`
}

function buildFeaturePopup(feature: ChartFeature, fallbackLabel: string): string {
    const extent = [feature.min_lon, feature.min_lat, feature.max_lon, feature.max_lat].every((v) => typeof v === 'number')
        ? `${feature.min_lon!.toFixed(6)}, ${feature.min_lat!.toFixed(6)} - ${feature.max_lon!.toFixed(6)}, ${feature.max_lat!.toFixed(6)}`
        : ''
    const rows = [
        popRow('类型', feature.feature_type || fallbackLabel),
        popRow('几何', feature.geometry_type),
        popRow('编号', feature.source_feature_id || feature.id, true),
        popRow('范围', extent, true),
    ].join('')
    const title = feature.name || feature.feature_type || fallbackLabel
    return `<div class="poi-pop chart-feature-pop"><div class="pop-title">${esc(title)}</div>${rows}</div>`
}

function getFeatureBounds(features: ChartFeature[]): L.LatLngBounds | null {
    const bounds = L.latLngBounds([])
    for (const f of features) {
        if (
            typeof f.min_lon === 'number' &&
            typeof f.min_lat === 'number' &&
            typeof f.max_lon === 'number' &&
            typeof f.max_lat === 'number'
        ) {
            bounds.extend([f.min_lat, f.min_lon])
            bounds.extend([f.max_lat, f.max_lon])
        }
    }
    return bounds.isValid() ? bounds : null
}

function getBufferedMapBounds(map: L.Map, ratio = 0.35): ChartFeatureBounds {
    const bounds = map.getBounds().pad(ratio)
    return {
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
    }
}

function intersectBounds(a: ChartFeatureBounds, b: ChartFeatureBounds): ChartFeatureBounds | null {
    const west = Math.max(a.west, b.west)
    const south = Math.max(a.south, b.south)
    const east = Math.min(a.east, b.east)
    const north = Math.min(a.north, b.north)
    if (east <= west || north <= south) return null
    return { west, south, east, north }
}

export function ChartFeatureOverlay({
    visible,
    sourceLayer,
    label,
    kind,
    fitBounds = false,
    controlOffsetTop = 0,
    viewportLoad = false,
    queryBounds,
    outlineOnly = false,
}: {
    visible: boolean
    sourceLayer: ChartFeatureSourceLayer
    label: string
    kind: ChartFeatureOverlayKind
    fitBounds?: boolean
    controlOffsetTop?: number
    viewportLoad?: boolean
    queryBounds?: ChartFeatureBounds
    /** 仅水域面有效：只画最外层外环边框（去洞、去嵌套内层） */
    outlineOnly?: boolean
}) {
    const map = useMap()
    const layerRef = useRef<L.GeoJSON | null>(null)
    const rendererRef = useRef<L.Renderer | null>(null)
    const requestSeqRef = useRef(0)
    const [count, setCount] = useState<number | null>(null)
    const [failed, setFailed] = useState(false)
    const styleConfig = FEATURE_STYLES[kind]

    useEffect(() => {
        let cancelled = false

        const clearLayer = () => {
            if (layerRef.current) {
                layerRef.current.remove()
                layerRef.current = null
            }
        }

        if (!visible) {
            clearLayer()
            setCount(null)
            setFailed(false)
            return clearLayer
        }

        const pane = map.getPane(styleConfig.pane) ?? map.createPane(styleConfig.pane)
        pane.style.zIndex = styleConfig.zIndex
        if (kind === 'hydro' && !rendererRef.current) {
            rendererRef.current = L.canvas({ padding: 0.5 })
        }

        setFailed(false)
        const isHydro = kind === 'hydro'
        const interactive = !isHydro
        let debounceTimer: number | null = null

        const loadFeatures = (bounds?: ChartFeatureBounds) => {
            const requestSeq = ++requestSeqRef.current
            const job = bounds
                ? fetchChartFeaturesByLayerInBounds(sourceLayer, bounds)
                : fetchChartFeaturesByLayer(sourceLayer)

            job.then((features) => {
                if (cancelled) return
                if (requestSeq !== requestSeqRef.current) return
                clearLayer()

                let geoFeatures: unknown[]
                if (isHydro && outlineOnly) {
                    // 水域面默认只画最外层边框：收敛掉大大小小嵌套的内层多边形，只留外环
                    const polys: WaterPolygon[] = []
                    for (const f of features) {
                        try {
                            polys.push(...geometryToPolygons(JSON.parse(f.geometry_json)))
                        } catch {
                            /* 跳过坏几何 */
                        }
                    }
                    const outer = outermostPolygons(polys)
                    geoFeatures = outer.map((p, i) => ({
                        type: 'Feature',
                        id: `outline-${i}`,
                        geometry: { type: 'Polygon', coordinates: [p.rings[0]] },
                        properties: {},
                    }))
                    setCount(outer.length)
                } else {
                    geoFeatures = features
                        .map((feature) => {
                            try {
                                const geometry = JSON.parse(feature.geometry_json)
                                if (!geometry?.type) return null
                                return {
                                    type: 'Feature',
                                    id: feature.id,
                                    geometry,
                                    properties: feature,
                                }
                            } catch {
                                return null
                            }
                        })
                        .filter(Boolean)
                    setCount(features.length)
                }

                if (geoFeatures.length === 0) return

                const layer = L.geoJSON({
                    type: 'FeatureCollection',
                    features: geoFeatures,
                } as any, {
                    pane: styleConfig.pane,
                    interactive,
                    renderer: isHydro ? rendererRef.current ?? undefined : undefined,
                    style: (feature?: GeoJSON.Feature) => {
                        const type = feature?.geometry?.type ?? ''
                        const isPolygon = type.includes('Polygon')
                        const hydroOutline = isHydro && outlineOnly
                        return {
                            color: styleConfig.stroke,
                            weight: isHydro ? (hydroOutline ? 1.6 : 0.8) : (isPolygon ? 3 : 4),
                            opacity: isHydro ? (hydroOutline ? 0.9 : 0.5) : 0.95,
                            dashArray: isHydro ? undefined : '8 5',
                            lineCap: 'round',
                            lineJoin: 'round',
                            fillColor: styleConfig.fill,
                            fillOpacity: isPolygon ? (isHydro ? (hydroOutline ? 0.08 : 0.16) : 0.14) : 0,
                            className: styleConfig.className,
                            smoothFactor: isHydro ? 2.5 : 1,
                        }
                    },
                    pointToLayer: (_feature: GeoJSON.Feature, latlng: L.LatLng) => L.circleMarker(latlng, {
                        pane: styleConfig.pane,
                        radius: 6,
                        color: styleConfig.stroke,
                        weight: 2,
                        opacity: 1,
                        fillColor: styleConfig.pointFill,
                        fillOpacity: 0.9,
                        className: kind === 'hydro' ? 'chart-hydro-point' : 'chart-fence-point',
                    }),
                    onEachFeature: (feature: GeoJSON.Feature, layer: L.Layer) => {
                        if (!interactive) return
                        layer.bindPopup(buildFeaturePopup(feature.properties as ChartFeature, label))
                        layer.on('add', () => {
                            if ('bringToFront' in layer && typeof layer.bringToFront === 'function') {
                                layer.bringToFront()
                            }
                        })
                    },
                } as any).addTo(map)

                layerRef.current = layer

                if (fitBounds) {
                    const bounds = getFeatureBounds(features)
                    if (bounds) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 14 })
                }
            })
            .catch(() => {
                if (cancelled) return
                if (requestSeq !== requestSeqRef.current) return
                clearLayer()
                setCount(0)
                setFailed(true)
            })
        }

        const scheduleViewportLoad = () => {
            if (debounceTimer != null) window.clearTimeout(debounceTimer)
            debounceTimer = window.setTimeout(() => {
                debounceTimer = null
                const viewportBounds = getBufferedMapBounds(map)
                const nextBounds = queryBounds
                    ? intersectBounds(viewportBounds, queryBounds)
                    : viewportBounds
                if (queryBounds && !nextBounds) {
                    clearLayer()
                    setCount(0)
                    return
                }
                loadFeatures(nextBounds ?? undefined)
            }, 120)
        }

        if (viewportLoad) {
            const viewportBounds = getBufferedMapBounds(map)
            const nextBounds = queryBounds
                ? intersectBounds(viewportBounds, queryBounds)
                : viewportBounds
            if (queryBounds && !nextBounds) {
                clearLayer()
                setCount(0)
            } else {
                loadFeatures(nextBounds ?? undefined)
            }
            map.on('moveend zoomend', scheduleViewportLoad)
        } else {
            loadFeatures(queryBounds)
        }

        return () => {
            cancelled = true
            requestSeqRef.current += 1
            if (debounceTimer != null) window.clearTimeout(debounceTimer)
            map.off('moveend zoomend', scheduleViewportLoad)
            clearLayer()
        }
    }, [fitBounds, kind, label, map, outlineOnly, queryBounds, sourceLayer, styleConfig, viewportLoad, visible])

    if (!visible || count === null) return null

    return (
        <div className="leaflet-top leaflet-right" style={{ pointerEvents: 'none', top: controlOffsetTop }}>
            <div className={`leaflet-control chart-feature-pill chart-${kind}-pill${failed ? ' is-error' : ''}`}>
                <span className="dot" />
                <span>{failed ? `${label}读取失败` : `${label} ${count}`}</span>
            </div>
        </div>
    )
}

export function ChartOverlayLayer({
    basePath,
    visible,
    layer,
    tileMode = 'legacy',
}: {
    basePath: string
    visible: boolean
    layer?: string
    tileMode?: 'legacy' | 'chart' | string | null
}) {
    const map = useMap()
    const tilesRef = useRef<Record<string, L.ImageOverlay>>({})
    const currentZRef = useRef(-1)
    const visibleRef = useRef(visible)

    // 切换显隐：只改 opacity，避免重新加载瓦片
    useEffect(() => {
        visibleRef.current = visible
        const tiles = tilesRef.current
        for (const key in tiles) {
            if (tiles[key]) tiles[key].setOpacity(visible ? 0.9 : 0)
        }
    }, [visible])

    useEffect(() => {
        const tiles = tilesRef.current

        const clearTiles = () => {
            for (const key in tiles) {
                if (tiles[key]) tiles[key].remove()
                delete tiles[key]
            }
            currentZRef.current = -1
        }

        const update = () => {
            const bounds = map.getBounds()
            const zoom = map.getZoom()
            const mapZoom = Math.round(zoom) + 1
            const customZ = mapZoom - 7

            if (customZ < 4 || customZ > 10) {
                clearTiles()
                return
            }

            const res = CJ_RESOLUTIONS[customZ]
            if (!res) { clearTiles(); return }

            if (currentZRef.current !== customZ) {
                clearTiles()
                currentZRef.current = customZ
            }

            const nw = bounds.getNorthWest()
            const se = bounds.getSouthEast()
            const startX = Math.floor((nw.lng - CJ_ORIGIN[0]) / (res * TILE_SIZE))
            const startY = Math.floor((CJ_ORIGIN[1] - nw.lat) / (res * TILE_SIZE))
            const endX = Math.floor((se.lng - CJ_ORIGIN[0]) / (res * TILE_SIZE))
            const endY = Math.floor((CJ_ORIGIN[1] - se.lat) / (res * TILE_SIZE))

            for (const key in tiles) {
                const [, tx, ty] = key.split(':').map(Number)
                if (tx < startX - 1 || tx > endX + 1 || ty < startY - 1 || ty > endY + 1) {
                    if (tiles[key]) tiles[key].remove()
                    delete tiles[key]
                }
            }

            for (let x = startX; x <= endX; x++) {
                for (let y = startY; y <= endY; y++) {
                    const tileKey = `${customZ}:${x}:${y}`
                    if (tiles[tileKey] !== undefined) continue
                    tiles[tileKey] = null as unknown as L.ImageOverlay

                    const nwLng = CJ_ORIGIN[0] + x * res * TILE_SIZE
                    const nwLat = CJ_ORIGIN[1] - y * res * TILE_SIZE
                    const seLng = nwLng + res * TILE_SIZE
                    const seLat = nwLat - res * TILE_SIZE
                    const tileBounds: L.LatLngBoundsExpression = [[seLat, nwLng], [nwLat, seLng]]

                    const job = tileMode === 'chart' && layer
                        ? invoke<string>('chart_serve_layer_tile', { basePath, layer, z: customZ, x, y })
                        : invoke<string>('serve_local_tile', { basePath, z: customZ, x, y })
                    job
                        .then((b64) => {
                            if (b64) {
                                const overlay = L.imageOverlay(
                                    `data:image/png;base64,${b64}`,
                                    tileBounds,
                                    {
                                        opacity: visibleRef.current ? 0.9 : 0,
                                        interactive: false,
                                        zIndex: 9,
                                    },
                                )
                                overlay.addTo(map)
                                tiles[tileKey] = overlay
                            } else {
                                delete tiles[tileKey]
                            }
                        })
                        .catch(() => { delete tiles[tileKey] })
                }
            }
        }

        map.on('moveend', update)
        map.on('zoomend', update)
        update()

        return () => {
            map.off('moveend', update)
            map.off('zoomend', update)
            clearTiles()
        }
    }, [map, basePath, layer, tileMode])

    return null
}

export function FitChartBounds({ bounds }: { bounds?: [number, number, number, number] }) {
    const map = useMap()
    const prevRef = useRef('')
    useEffect(() => {
        if (!bounds) return
        const key = bounds.join(',')
        if (key === prevRef.current) return
        prevRef.current = key
        const [south, west, north, east] = bounds
        map.fitBounds([[south, west], [north, east]], { padding: [30, 30], maxZoom: 14 })
    }, [bounds, map])
    return null
}

export function ChartZoomIndicator() {
    const map = useMap()
    const [zoom, setZoom] = useState(map.getZoom())
    useEffect(() => {
        const onZoom = () => setZoom(map.getZoom())
        map.on('zoomend', onZoom)
        return () => { map.off('zoomend', onZoom) }
    }, [map])

    const mapZoom = Math.round(zoom) + 1
    const chartZ = mapZoom - 7
    const inRange = chartZ >= 4 && chartZ <= 10

    return (
        <div className="leaflet-bottom leaflet-right" style={{ pointerEvents: 'none' }}>
            <div className="leaflet-control chart-zoom-pill mono">
                <span>地图 {Math.round(zoom)}</span>
                <span className="sep">·</span>
                <span>
                    航道{' '}
                    <b style={{ color: inRange ? 'var(--st-green, #10b981)' : 'var(--st-amber, #f59e0b)' }}>
                        {inRange ? chartZ : '超出'}
                    </b>
                </span>
            </div>
        </div>
    )
}
