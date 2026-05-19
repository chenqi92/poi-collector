import { useEffect, useRef, useState } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import { invoke } from '@tauri-apps/api/core'

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
    output_path: string
    total_tiles: number
    completed_tiles: number
    failed_tiles: number
    bounds_north: number
    bounds_south: number
    bounds_east: number
    bounds_west: number
    zoom_levels: number[]
}

export function fetchCjhyTasks(): Promise<CjhyTask[]> {
    return invoke<CjhyTask[]>('get_cjhy_tile_tasks')
}

export function ChartOverlayLayer({ basePath, visible }: { basePath: string; visible: boolean }) {
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

                    invoke<string>('serve_local_tile', { basePath, z: customZ, x, y })
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
    }, [map, basePath])

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
