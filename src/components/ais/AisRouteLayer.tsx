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
    /** 被隐藏的航次序号集合（勾选/单看用） */
    hiddenTrips?: Set<number>
    /** 变化时自动定位到航迹范围（如切换船只） */
    fitKey: string
}

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
            group.remove()
            waterRenderer.remove()
            droppedRenderer.remove()
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
        hiddenTrips,
        fitKey,
    ])

    return null
}
