// 命令式 Leaflet 图层：渲染单船航迹。
// - 水域面：低层半透明填充
// - 行驶段：亮蓝 polyline（可 DP 抽稀）
// - 停泊段：锚点 marker + 摆动半径圈，航线用虚线跨过（不画抖动碎线）
// - 异常点（水域外）：红色点
// 坐标：传入为 WGS-84，按 baseCrs 转到底图坐标系后再画。

import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import type { AisPoint, BaseCrs } from '@/lib/ais/types'
import type { WaterPolygon } from '@/lib/ais/geo'
import { type Segment, douglasPeucker, segmentsBounds, tripColor } from '@/lib/ais/trajectory'
import { toBase } from '@/lib/ais/coords'

interface Props {
    segments: Segment[]
    anomalies: AisPoint[]
    waterPolygons: WaterPolygon[]
    waterKind: 'fence' | 'hydro'
    baseCrs: BaseCrs
    showRawAnchored: boolean
    simplifyToleranceM: number
    /** 被清洗掉的跳点/重复点（开启「查看」时传入，灰色叉号展示，不参与连线） */
    droppedPoints?: AisPoint[]
    /** 显示全部轨迹点（canvas 小点），点击地图弹出最近点的经纬度/航速/航向等 */
    showPoints?: boolean
    /** 被隐藏的航次序号集合（勾选/单看用） */
    hiddenTrips?: Set<number>
    /** 变化时自动定位到航迹范围（如切换船只） */
    fitKey: string
}

function pointPopupHtml(p: AisPoint): string {
    const t = p.ts ? new Date(p.ts).toLocaleString('zh-CN', { hour12: false }) : '-'
    const rows: Array<[string, string] | null> = [
        ['MMSI', p.mmsi],
        p.name ? ['船名', p.name] : null,
        ['时间', t],
        ['经度', p.lon.toFixed(6)],
        ['纬度', p.lat.toFixed(6)],
        p.sog != null ? ['航速 SOG', `${p.sog} kn`] : null,
        p.cog != null ? ['航向 COG', `${p.cog}°`] : null,
        p.heading != null ? ['船首向', `${p.heading}°`] : null,
        p.navStatus != null && String(p.navStatus) !== '' ? ['导航状态', String(p.navStatus)] : null,
    ]
    const body = (rows.filter(Boolean) as Array<[string, string]>)
        .map(([k, v]) => `<div class="ais-pt-row"><span>${k}</span><b>${v}</b></div>`)
        .join('')
    return `<div class="ais-pt-popup">${body}</div>`
}

interface DispPoint {
    lat: number
    lng: number
    color: string
    p: AisPoint
}

/**
 * 自定义点云图层：所有轨迹点画在「一张」canvas 上，只在 moveend/zoomend 重绘，
 * 不为每个点建图层、不绑交互——几万点也不卡。点击查询交给地图 click 就近查找。
 */
const PointCloudLayer = L.Layer.extend({
    initialize(this: any, pts: DispPoint[]) {
        this._pts = pts
    },
    onAdd(this: any, map: L.Map) {
        this._map = map
        const pane = map.getPane('aisRoutePane') ?? map.getPanes().overlayPane
        const canvas: HTMLCanvasElement = L.DomUtil.create('canvas', 'ais-points-canvas')
        canvas.style.position = 'absolute'
        canvas.style.pointerEvents = 'none'
        this._canvas = canvas
        pane.appendChild(canvas)
        map.on('moveend zoomend resize viewreset', this._reset, this)
        this._reset()
        return this
    },
    onRemove(this: any, map: L.Map) {
        map.off('moveend zoomend resize viewreset', this._reset, this)
        if (this._canvas?.parentNode) this._canvas.parentNode.removeChild(this._canvas)
        this._canvas = null
        return this
    },
    _reset(this: any) {
        const map: L.Map = this._map
        const canvas: HTMLCanvasElement = this._canvas
        if (!canvas) return
        const size = map.getSize()
        if (canvas.width !== size.x) canvas.width = size.x
        if (canvas.height !== size.y) canvas.height = size.y
        L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]))
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.clearRect(0, 0, size.x, size.y)
        for (const pt of this._pts as DispPoint[]) {
            const cp = map.latLngToContainerPoint([pt.lat, pt.lng])
            if (cp.x < -4 || cp.y < -4 || cp.x > size.x + 4 || cp.y > size.y + 4) continue
            ctx.beginPath()
            ctx.arc(cp.x, cp.y, 2, 0, 6.283185)
            ctx.fillStyle = pt.color
            ctx.fill()
        }
    },
})

function fmtDuration(ms: number): string {
    const m = Math.round(ms / 60000)
    if (m < 60) return `${m} 分钟`
    const h = Math.floor(m / 60)
    const mm = m % 60
    return mm ? `${h} 小时 ${mm} 分` : `${h} 小时`
}

const ANCHOR_SVG =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2.6"/><line x1="12" y1="22" x2="12" y2="7.6"/><path d="M5 12H2a10 10 0 0 0 20 0h-3"/></svg>'

export function AisRouteLayer({
    segments,
    anomalies,
    waterPolygons,
    waterKind,
    baseCrs,
    showRawAnchored,
    simplifyToleranceM,
    droppedPoints,
    showPoints,
    hiddenTrips,
    fitKey,
}: Props) {
    const map = useMap()
    const lastFitKey = useRef<string>('')

    useEffect(() => {
        const waterPane = map.getPane('aisWaterPane') ?? map.createPane('aisWaterPane')
        waterPane.style.zIndex = '410'
        const routePane = map.getPane('aisRoutePane') ?? map.createPane('aisRoutePane')
        routePane.style.zIndex = '460'
        const waterRenderer = L.canvas({ padding: 0.5, pane: 'aisWaterPane' })
        // 清洗点可能成百上千，用 canvas 渲染避免卡顿
        const droppedRenderer = L.canvas({ padding: 0.5, pane: 'aisRoutePane' })

        const group = L.layerGroup().addTo(map)

        const disp = (lon: number, lat: number): [number, number] => {
            const [x, y] = toBase(baseCrs, lon, lat)
            return [y, x] // Leaflet [lat, lng]
        }

        // 1) 水域面
        const fenceColor = waterKind === 'fence' ? '#f59e0b' : '#0891b2'
        const fenceFill = waterKind === 'fence' ? '#fbbf24' : '#22d3ee'
        for (const poly of waterPolygons) {
            const latlngs = poly.rings.map((ring) => ring.map((c) => disp(c[0], c[1])))
            L.polygon(latlngs as L.LatLngExpression[][], {
                renderer: waterRenderer,
                color: fenceColor,
                weight: 1.1,
                opacity: 0.7,
                fillColor: fenceFill,
                fillOpacity: 0.1,
                interactive: false,
            }).addTo(group)
        }

        // 2) 航迹分段
        let prevEnd: [number, number] | null = null
        let firstDisp: [number, number] | null = null
        for (const seg of segments) {
            // 新航次：断开与上一航次的连线
            if (seg.newTrip) prevEnd = null
            // 隐藏的航次：整段跳过（prevEnd 不前进，下一可见航次会以 newTrip 重置）
            if (hiddenTrips && seg.tripIndex != null && hiddenTrips.has(seg.tripIndex)) continue
            const color = tripColor(seg.tripIndex ?? 0)
            if (seg.kind === 'sailing') {
                const pts =
                    simplifyToleranceM > 0 ? douglasPeucker(seg.points, simplifyToleranceM) : seg.points
                const latlngs = pts.map((p) => disp(p.lon, p.lat))
                if (!firstDisp && latlngs.length) firstDisp = latlngs[0]
                if (prevEnd && latlngs.length) {
                    L.polyline([prevEnd, latlngs[0]], {
                        pane: 'aisRoutePane',
                        color,
                        weight: 1.5,
                        opacity: 0.55,
                        dashArray: '4 4',
                    }).addTo(group)
                }
                if (latlngs.length >= 2) {
                    L.polyline(latlngs, {
                        pane: 'aisRoutePane',
                        color,
                        weight: 2.6,
                        opacity: 0.95,
                        lineCap: 'round',
                        lineJoin: 'round',
                    }).addTo(group)
                } else if (latlngs.length === 1) {
                    L.circleMarker(latlngs[0], {
                        pane: 'aisRoutePane',
                        radius: 4,
                        color,
                        weight: 1.5,
                        fillColor: color,
                        fillOpacity: 1,
                        className: 'ais-pulse-point',
                    }).addTo(group)
                }
                if (latlngs.length) prevEnd = latlngs[latlngs.length - 1]
            } else {
                const c = disp(seg.centroid[0], seg.centroid[1])
                if (!firstDisp) firstDisp = c
                if (prevEnd) {
                    L.polyline([prevEnd, c], {
                        pane: 'aisRoutePane',
                        color,
                        weight: 1.5,
                        opacity: 0.55,
                        dashArray: '4 4',
                    }).addTo(group)
                }
                // 摆动半径圈
                L.circle(c, {
                    pane: 'aisRoutePane',
                    radius: seg.radiusM,
                    color: '#f97316',
                    weight: 1,
                    dashArray: '3 3',
                    fillColor: '#fb923c',
                    fillOpacity: 0.12,
                    interactive: false,
                }).addTo(group)
                if (showRawAnchored) {
                    for (const p of seg.points) {
                        L.circleMarker(disp(p.lon, p.lat), {
                            pane: 'aisRoutePane',
                            radius: 1.5,
                            weight: 0,
                            fillColor: '#fdba74',
                            fillOpacity: 0.55,
                            interactive: false,
                        }).addTo(group)
                    }
                }
                const icon = L.divIcon({
                    className: '',
                    html: `<div class="ais-anchor-marker">${ANCHOR_SVG}</div>`,
                    iconSize: [22, 22],
                    iconAnchor: [11, 11],
                })
                L.marker(c, { icon, zIndexOffset: 600 })
                    .bindTooltip(`停泊 ${fmtDuration(seg.endTs - seg.startTs)} · ${seg.points.length} 点`, {
                        direction: 'top',
                        offset: [0, -10],
                    })
                    .addTo(group)
                prevEnd = c
            }
        }

        // 起点（绿）/终点（红）脉冲环，方便在地图上定位航迹
        const ringMarker = (latlng: [number, number], color: string) =>
            L.marker(latlng, {
                interactive: false,
                zIndexOffset: 500,
                icon: L.divIcon({
                    className: '',
                    html: `<span class="ais-pulse-ring" style="--ring:${color}"></span>`,
                    iconSize: [16, 16],
                    iconAnchor: [8, 8],
                }),
            }).addTo(group)
        if (firstDisp) ringMarker(firstDisp, '#16a34a')
        if (prevEnd && (!firstDisp || prevEnd[0] !== firstDisp[0] || prevEnd[1] !== firstDisp[1])) {
            ringMarker(prevEnd, '#dc2626')
        }

        // 清洗掉的跳点/重复点（灰色，证明清洗确实生效；不连线）
        if (droppedPoints && droppedPoints.length) {
            for (const p of droppedPoints) {
                L.circleMarker(disp(p.lon, p.lat), {
                    renderer: droppedRenderer,
                    radius: 2.6,
                    color: '#64748b',
                    weight: 1,
                    fillColor: '#cbd5e1',
                    fillOpacity: 0.5,
                    interactive: false,
                }).addTo(group)
            }
        }

        // 3) 异常点（水域外）
        for (const p of anomalies) {
            L.circleMarker(disp(p.lon, p.lat), {
                pane: 'aisRoutePane',
                radius: 4,
                color: '#ef4444',
                weight: 2,
                fillColor: '#fca5a5',
                fillOpacity: 0.9,
                className: 'ais-anomaly-point ais-pulse-point',
            })
                .bindTooltip('水域外异常点', { direction: 'top' })
                .addTo(group)
        }

        // 4) 显示全部轨迹点（单张 canvas 点云）+ 地图点击就近弹出详情
        // 用「画点 + 单个地图点击就近查找」而非给每个点绑交互，几万点也不卡。
        let onPointClick: ((e: L.LeafletMouseEvent) => void) | null = null
        let pointLayer: L.Layer | null = null
        if (showPoints) {
            const disps: DispPoint[] = []
            for (const seg of segments) {
                if (hiddenTrips && seg.tripIndex != null && hiddenTrips.has(seg.tripIndex)) continue
                const color = tripColor(seg.tripIndex ?? 0)
                for (const p of seg.points) {
                    const d = disp(p.lon, p.lat)
                    disps.push({ lat: d[0], lng: d[1], color, p })
                }
            }
            pointLayer = new (PointCloudLayer as any)(disps) as L.Layer
            pointLayer.addTo(map)
            onPointClick = (e: L.LeafletMouseEvent) => {
                if (!disps.length) return
                const clat = e.latlng.lat
                const clng = e.latlng.lng
                let best = -1
                let bestD = Infinity
                for (let k = 0; k < disps.length; k++) {
                    const dl = disps[k].lat - clat
                    const dn = disps[k].lng - clng
                    const d = dl * dl + dn * dn
                    if (d < bestD) {
                        bestD = d
                        best = k
                    }
                }
                if (best < 0) return
                const cp = map.latLngToContainerPoint(e.latlng)
                const q = map.latLngToContainerPoint([disps[best].lat, disps[best].lng])
                if ((q.x - cp.x) ** 2 + (q.y - cp.y) ** 2 <= 14 * 14) {
                    L.popup({ offset: [0, -2], className: 'ais-pt-popup-wrap' })
                        .setLatLng([disps[best].lat, disps[best].lng])
                        .setContent(pointPopupHtml(disps[best].p))
                        .openOn(map)
                }
            }
            map.on('click', onPointClick)
        }

        // 自动定位（仅当 fitKey 变化时）：按可见航次取范围（单看某航次时直接定位过去）
        if (fitKey !== lastFitKey.current) {
            const visible =
                hiddenTrips && hiddenTrips.size
                    ? segments.filter((s) => s.tripIndex == null || !hiddenTrips.has(s.tripIndex))
                    : segments
            const wb = segmentsBounds(visible.length ? visible : segments)
            if (wb) {
                const [w, s, e, n] = wb
                const sw = toBase(baseCrs, w, s)
                const ne = toBase(baseCrs, e, n)
                map.fitBounds(
                    [
                        [sw[1], sw[0]],
                        [ne[1], ne[0]],
                    ],
                    { padding: [40, 40], maxZoom: 15 },
                )
            }
            lastFitKey.current = fitKey
        }

        return () => {
            if (onPointClick) map.off('click', onPointClick)
            group.remove()
            waterRenderer.remove()
            droppedRenderer.remove()
            if (pointLayer) pointLayer.remove()
        }
    }, [
        map,
        segments,
        anomalies,
        waterPolygons,
        waterKind,
        baseCrs,
        showRawAnchored,
        simplifyToleranceM,
        droppedPoints,
        showPoints,
        hiddenTrips,
        fitKey,
    ])

    return null
}
