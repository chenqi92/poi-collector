// 命令式 Leaflet 图层：渲染单船航迹。
// - 水域面：低层半透明填充
// - 行驶段：亮蓝 polyline（可 DP 抽稀）+ canvas 方向箭头
// - 停泊段：锚点 marker + 摆动半径圈，航线用虚线跨过（不画抖动碎线）
// - 异常点（水域外）：红色点
// - AIS 点：单张 canvas 按屏幕网格聚合，分散点单独显示
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
    tripIndex: number
}

interface DispPath {
    color: string
    tripIndex: number
    points: DispPoint[]
}

interface ArrowPoint {
    lat: number
    lng: number
}

interface ArrowPath {
    color: string
    points: ArrowPoint[]
}

interface DrawCluster {
    x: number
    y: number
    lat: number
    lng: number
    centerLon: number
    centerLat: number
    color: string
    count: number
    radius: number
    minTs: number
    maxTs: number
    sample: AisPoint
}

const TAU = Math.PI * 2

function fmtPointTime(ms?: number): string {
    if (!ms) return '-'
    try {
        return new Date(ms).toLocaleString('zh-CN', { hour12: false })
    } catch {
        return String(ms)
    }
}

function clusterPopupHtml(c: DrawCluster): string {
    const time =
        c.minTs === c.maxTs
            ? fmtPointTime(c.minTs)
            : `${fmtPointTime(c.minTs)} ~ ${fmtPointTime(c.maxTs)}`
    const rows: Array<[string, string] | null> = [
        ['聚合 AIS 点', `${c.count.toLocaleString()} 个`],
        ['MMSI', c.sample.mmsi],
        c.sample.name ? ['船名', c.sample.name] : null,
        ['时间', time],
        ['中心经度', c.centerLon.toFixed(6)],
        ['中心纬度', c.centerLat.toFixed(6)],
    ]
    const body = (rows.filter(Boolean) as Array<[string, string]>)
        .map(([k, v]) => `<div class="ais-pt-row"><span>${k}</span><b>${v}</b></div>`)
        .join('')
    return `<div class="ais-pt-popup">${body}</div>`
}

function clusterHoverHtml(c: DrawCluster): string {
    const time =
        c.count === 1
            ? fmtPointTime(c.sample.ts)
            : c.minTs === c.maxTs
              ? fmtPointTime(c.minTs)
              : `${fmtPointTime(c.minTs)} ~ ${fmtPointTime(c.maxTs)}`
    return `<div class="ais-pt-hover"><b>${c.count.toLocaleString()}</b> 个 AIS 点<span>${time}</span></div>`
}

/**
 * 自定义 AIS canvas 图层：
 * - 方向箭头按屏幕距离抽样绘制，避免给折线塞 marker。
 * - AIS 点按「航次 + 屏幕网格」聚合，密集点合成计数圆，分散点单独画。
 * - 点击只命中已绘制的聚合/单点，不为每个点建立 Leaflet 图层。
 */
const AisCanvasLayer = L.Layer.extend({
    initialize(this: any, pointPaths: DispPath[], arrowPaths: ArrowPath[], showPoints: boolean) {
        this._pointPaths = pointPaths
        this._arrowPaths = arrowPaths
        this._showPoints = showPoints
        this._clusters = []
        this._hovered = null
        this._tooltip = null
        this._raf = 0
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
        map.on('mousemove', this._onMouseMove, this)
        map.on('mouseout', this._clearHover, this)
        map.on('click', this._onClick, this)
        this._reset()
        return this
    },
    onRemove(this: any, map: L.Map) {
        map.off('moveend zoomend resize viewreset', this._reset, this)
        map.off('mousemove', this._onMouseMove, this)
        map.off('mouseout', this._clearHover, this)
        map.off('click', this._onClick, this)
        if (this._raf) cancelAnimationFrame(this._raf)
        this._clearHover()
        if (this._canvas?.parentNode) this._canvas.parentNode.removeChild(this._canvas)
        this._canvas = null
        this._clusters = []
        return this
    },
    _reset(this: any) {
        if (this._raf) cancelAnimationFrame(this._raf)
        this._raf = requestAnimationFrame(() => {
            this._raf = 0
            this._draw()
        })
    },
    _draw(this: any) {
        const map: L.Map = this._map
        const canvas: HTMLCanvasElement = this._canvas
        if (!canvas) return
        const size = map.getSize()
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        const width = Math.max(1, Math.round(size.x * dpr))
        const height = Math.max(1, Math.round(size.y * dpr))
        if (canvas.width !== width) canvas.width = width
        if (canvas.height !== height) canvas.height = height
        canvas.style.width = `${size.x}px`
        canvas.style.height = `${size.y}px`
        L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]))
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, size.x, size.y)
        this._drawPoints(ctx, map, size)
        this._drawArrows(ctx, map, size)
    },
    _drawPoints(this: any, ctx: CanvasRenderingContext2D, map: L.Map, size: L.Point) {
        this._clusters = []
        if (!this._showPoints) return

        const zoom = map.getZoom()
        const cell = zoom >= 16 ? 8 : zoom >= 14 ? 10 : zoom >= 12 ? 14 : 20
        const pad = cell + 8
        const clusters = new Map<string, {
            sx: number
            sy: number
            slat: number
            slng: number
            swLon: number
            swLat: number
            count: number
            color: string
            minTs: number
            maxTs: number
            sample: AisPoint
        }>()

        for (const path of this._pointPaths as DispPath[]) {
            for (const pt of path.points) {
                const cp = map.latLngToContainerPoint([pt.lat, pt.lng])
                if (cp.x < -pad || cp.y < -pad || cp.x > size.x + pad || cp.y > size.y + pad) continue
                const gx = Math.floor(cp.x / cell)
                const gy = Math.floor(cp.y / cell)
                const key = `${pt.tripIndex}:${gx}:${gy}`
                let c = clusters.get(key)
                if (!c) {
                    c = {
                        sx: 0,
                        sy: 0,
                        slat: 0,
                        slng: 0,
                        swLon: 0,
                        swLat: 0,
                        count: 0,
                        color: pt.color,
                        minTs: pt.p.ts || 0,
                        maxTs: pt.p.ts || 0,
                        sample: pt.p,
                    }
                    clusters.set(key, c)
                }
                c.sx += cp.x
                c.sy += cp.y
                c.slat += pt.lat
                c.slng += pt.lng
                c.swLon += pt.p.lon
                c.swLat += pt.p.lat
                c.count++
                if (pt.p.ts && (!c.minTs || pt.p.ts < c.minTs)) c.minTs = pt.p.ts
                if (pt.p.ts && pt.p.ts > c.maxTs) c.maxTs = pt.p.ts
            }
        }

        const list: DrawCluster[] = []
        for (const c of clusters.values()) {
            const radius = c.count === 1 ? 2.1 : c.count >= 100 ? 3.8 : 3.1
            list.push({
                x: c.sx / c.count,
                y: c.sy / c.count,
                lat: c.slat / c.count,
                lng: c.slng / c.count,
                centerLon: c.swLon / c.count,
                centerLat: c.swLat / c.count,
                color: c.color,
                count: c.count,
                radius,
                minTs: c.minTs,
                maxTs: c.maxTs,
                sample: c.sample,
            })
        }
        this._clusters = list

        ctx.save()
        for (const c of list) {
            if (c.count <= 1) continue
            ctx.beginPath()
            ctx.arc(c.x, c.y, c.radius, 0, TAU)
            ctx.fillStyle = c.color
            ctx.fill()
            ctx.lineWidth = 1.4
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)'
            ctx.stroke()
        }
        ctx.restore()

        ctx.save()
        for (const c of list) {
            if (c.count !== 1) continue
            ctx.beginPath()
            ctx.arc(c.x, c.y, c.radius, 0, TAU)
            ctx.fillStyle = c.color
            ctx.fill()
            ctx.lineWidth = 1
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
            ctx.stroke()
        }
        ctx.restore()
    },
    _drawArrows(this: any, ctx: CanvasRenderingContext2D, map: L.Map, size: L.Point) {
        const zoom = map.getZoom()
        const every = zoom >= 16 ? 104 : zoom >= 13 ? 86 : 70
        const pad = 18
        let drawn = 0
        const maxArrows = 900

        ctx.save()
        for (const path of this._arrowPaths as ArrowPath[]) {
            if (path.points.length < 2 || drawn >= maxArrows) continue
            let prev = map.latLngToContainerPoint([path.points[0].lat, path.points[0].lng])
            let acc = 0
            let nextAt = every * 0.65
            for (let i = 1; i < path.points.length && drawn < maxArrows; i++) {
                const cur = map.latLngToContainerPoint([path.points[i].lat, path.points[i].lng])
                const dx = cur.x - prev.x
                const dy = cur.y - prev.y
                const len = Math.hypot(dx, dy)
                if (len < 1) {
                    prev = cur
                    continue
                }
                while (acc + len >= nextAt && drawn < maxArrows) {
                    const r = (nextAt - acc) / len
                    const x = prev.x + dx * r
                    const y = prev.y + dy * r
                    if (x >= -pad && y >= -pad && x <= size.x + pad && y <= size.y + pad) {
                        drawDirectionArrow(ctx, x, y, Math.atan2(dy, dx), path.color)
                        drawn++
                    }
                    nextAt += every
                }
                acc += len
                prev = cur
            }
        }
        ctx.restore()
    },
    _hitCluster(this: any, e: L.LeafletMouseEvent): DrawCluster | null {
        if (!this._showPoints || !this._clusters?.length) return null
        const map: L.Map = this._map
        const cp = map.latLngToContainerPoint(e.latlng)
        let best: DrawCluster | null = null
        let bestD = Infinity
        for (const c of this._clusters as DrawCluster[]) {
            const dx = c.x - cp.x
            const dy = c.y - cp.y
            const d = dx * dx + dy * dy
            if (d < bestD) {
                bestD = d
                best = c
            }
        }
        if (!best) return null
        const hit = Math.max(9, best.radius + 5)
        if (bestD > hit * hit) return null
        return best
    },
    _onMouseMove(this: any, e: L.LeafletMouseEvent) {
        const map: L.Map = this._map
        const hit = this._hitCluster(e)
        if (!hit) {
            this._clearHover()
            return
        }
        const key = `${hit.x.toFixed(1)}:${hit.y.toFixed(1)}:${hit.count}:${hit.minTs}:${hit.maxTs}`
        if (this._hovered === key && this._tooltip) {
            this._tooltip.setLatLng([hit.lat, hit.lng])
            return
        }
        this._hovered = key
        if (!this._tooltip) {
            // 先 setLatLng 再 addTo：否则 Leaflet 在 onAdd 时投影 undefined latlng 报错，
            // 且带着空 latlng 卡在地图上，后续每次缩放动画都会重复抛错。
            this._tooltip = L.tooltip({
                className: 'ais-pt-hover-wrap',
                direction: 'top',
                offset: [0, -8],
                opacity: 0.96,
            })
                .setLatLng([hit.lat, hit.lng])
                .setContent(clusterHoverHtml(hit))
                .addTo(map)
        } else {
            this._tooltip
                .setLatLng([hit.lat, hit.lng])
                .setContent(clusterHoverHtml(hit))
        }
    },
    _clearHover(this: any) {
        if (this._tooltip) {
            this._tooltip.remove()
            this._tooltip = null
        }
        this._hovered = null
    },
    _onClick(this: any, e: L.LeafletMouseEvent) {
        const best = this._hitCluster(e)
        if (!best) return
        const map: L.Map = this._map
        L.popup({ offset: [0, -2], className: 'ais-pt-popup-wrap' })
            .setLatLng([best.lat, best.lng])
            .setContent(best.count === 1 ? pointPopupHtml(best.sample) : clusterPopupHtml(best))
            .openOn(map)
    },
})

function drawDirectionArrow(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    angle: number,
    color: string,
) {
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(angle)
    ctx.beginPath()
    ctx.moveTo(7, 0)
    ctx.lineTo(-5, -4.5)
    ctx.lineTo(-3, 0)
    ctx.lineTo(-5, 4.5)
    ctx.closePath()
    ctx.fillStyle = color
    ctx.globalAlpha = 0.96
    ctx.fill()
    ctx.lineWidth = 1.15
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)'
    ctx.stroke()
    ctx.restore()
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
        const pointPaths: DispPath[] = []
        const arrowPaths: ArrowPath[] = []
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
                if (showPoints && seg.points.length) {
                    const pointPath: DispPath = {
                        color,
                        tripIndex: seg.tripIndex ?? 0,
                        points: seg.points.map((p) => {
                            const d = disp(p.lon, p.lat)
                            return { lat: d[0], lng: d[1], color, p, tripIndex: seg.tripIndex ?? 0 }
                        }),
                    }
                    pointPaths.push(pointPath)
                }
                if (latlngs.length >= 2) {
                    arrowPaths.push({
                        color,
                        points: latlngs.map((d) => ({ lat: d[0], lng: d[1] })),
                    })
                }
                if (!firstDisp && latlngs.length) firstDisp = latlngs[0]
                if (prevEnd && latlngs.length) {
                    if (seg.afterGap) {
                        // 信号空档：能沿水域补全就画绕行折线（推断航路），否则画醒目直线（纯猜测）
                        if (seg.gapFill && seg.gapFill.length >= 2) {
                            L.polyline(seg.gapFill.map((c) => disp(c[0], c[1])), {
                                pane: 'aisRoutePane',
                                color,
                                weight: 2,
                                opacity: 0.85,
                                dashArray: '7 5',
                                lineCap: 'round',
                                lineJoin: 'round',
                            }).addTo(group)
                        } else {
                            L.polyline([prevEnd, latlngs[0]], {
                                pane: 'aisRoutePane',
                                color: '#64748b',
                                weight: 1.8,
                                opacity: 0.8,
                                dashArray: '2 6',
                            }).addTo(group)
                        }
                    } else {
                        // 停泊/其它跨段桥：细虚线，保持原样式
                        L.polyline([prevEnd, latlngs[0]], {
                            pane: 'aisRoutePane',
                            color,
                            weight: 1.5,
                            opacity: 0.55,
                            dashArray: '4 4',
                        }).addTo(group)
                    }
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
                if (showPoints && seg.points.length) {
                    const pointPath: DispPath = {
                        color,
                        tripIndex: seg.tripIndex ?? 0,
                        points: seg.points.map((p) => {
                            const d = disp(p.lon, p.lat)
                            return { lat: d[0], lng: d[1], color, p, tripIndex: seg.tripIndex ?? 0 }
                        }),
                    }
                    pointPaths.push(pointPath)
                }
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

        // 4) 方向箭头 + AIS 点聚合：同一张 canvas，避免为海量点/箭头创建 Leaflet marker。
        const canvasLayer = new (AisCanvasLayer as any)(pointPaths, arrowPaths, Boolean(showPoints)) as L.Layer
        canvasLayer.addTo(map)

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
            canvasLayer.remove()
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
