// 点在多边形内判断（射线法 even-odd，支持 Polygon / MultiPolygon），带 bbox 预判。
// 坐标统一为 WGS-84 的 [lon, lat]，与水域面一致。

export type Coord = [number, number] // [lon, lat]
export type Ring = Coord[]

export interface Bbox {
    minLon: number
    minLat: number
    maxLon: number
    maxLat: number
}

export interface WaterPolygon {
    rings: Ring[] // rings[0] 外环，其余为洞
    bbox: Bbox
}

function ringsBbox(rings: Ring[]): Bbox {
    let minLon = Infinity
    let minLat = Infinity
    let maxLon = -Infinity
    let maxLat = -Infinity
    for (const ring of rings) {
        for (const c of ring) {
            const lon = c[0]
            const lat = c[1]
            if (lon < minLon) minLon = lon
            if (lon > maxLon) maxLon = lon
            if (lat < minLat) minLat = lat
            if (lat > maxLat) maxLat = lat
        }
    }
    return { minLon, minLat, maxLon, maxLat }
}

function makePoly(coords: Ring[]): WaterPolygon {
    return { rings: coords, bbox: ringsBbox(coords) }
}

/** 把一个 GeoJSON geometry 解析成 WaterPolygon 列表 */
export function geometryToPolygons(geometry: any): WaterPolygon[] {
    if (!geometry || !geometry.type) return []
    if (geometry.type === 'Polygon') {
        return [makePoly(geometry.coordinates as Ring[])]
    }
    if (geometry.type === 'MultiPolygon') {
        return (geometry.coordinates as Ring[][]).map(makePoly)
    }
    if (geometry.type === 'GeometryCollection' && Array.isArray(geometry.geometries)) {
        return geometry.geometries.flatMap((g: any) => geometryToPolygons(g))
    }
    return []
}

function pointInRing(lon: number, lat: number, ring: Ring): boolean {
    let inside = false
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0]
        const yi = ring[i][1]
        const xj = ring[j][0]
        const yj = ring[j][1]
        const intersect =
            yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
        if (intersect) inside = !inside
    }
    return inside
}

/** 单个多边形（even-odd 跨所有环，自动扣掉洞） */
export function pointInPolygon(lon: number, lat: number, poly: WaterPolygon): boolean {
    const b = poly.bbox
    if (lon < b.minLon || lon > b.maxLon || lat < b.minLat || lat > b.maxLat) return false
    let inside = false
    for (const ring of poly.rings) {
        if (pointInRing(lon, lat, ring)) inside = !inside
    }
    return inside
}

/** 落在任一水域面内即视为"在水域内" */
export function pointInWater(lon: number, lat: number, polys: WaterPolygon[]): boolean {
    for (const p of polys) {
        if (pointInPolygon(lon, lat, p)) return true
    }
    return false
}

/** 外环近似面积（平面投影，仅用于按大小排序，取绝对值） */
function ringArea(ring: Ring): number {
    let a = 0
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1])
    }
    return Math.abs(a) / 2
}

function bboxInside(inner: Bbox, outer: Bbox): boolean {
    return (
        inner.minLon >= outer.minLon &&
        inner.maxLon <= outer.maxLon &&
        inner.minLat >= outer.minLat &&
        inner.maxLat <= outer.maxLat
    )
}

/** inner 的外环是否基本落在 outer 的外环内：bbox 包含 + 抽样顶点多数在内 */
function polyContains(outer: WaterPolygon, inner: WaterPolygon): boolean {
    if (!bboxInside(inner.bbox, outer.bbox)) return false
    const outerRing = outer.rings[0]
    const innerRing = inner.rings[0]
    if (!outerRing || !innerRing || innerRing.length === 0) return false
    const stride = Math.max(1, Math.floor(innerRing.length / 40)) // 大环抽样降成本
    let tested = 0
    let inside = 0
    for (let i = 0; i < innerRing.length; i += stride) {
        tested++
        if (pointInRing(innerRing[i][0], innerRing[i][1], outerRing)) inside++
    }
    return tested > 0 && inside / tested >= 0.9
}

/**
 * 只保留"最外层"水域面：去掉外环被另一个更大多边形包含的多边形，
 * 把大大小小嵌套的水域面收敛成外层范围，用于 AIS 是否在范围内的粗判。
 * 纯函数，不修改入参（原始水域面数据保留）。
 */
export function outermostPolygons(polys: WaterPolygon[]): WaterPolygon[] {
    if (polys.length <= 1) return polys.slice()
    const indexed = polys.map((p) => ({ p, area: ringArea(p.rings[0] ?? []) }))
    indexed.sort((a, b) => b.area - a.area) // 大 → 小
    const kept: WaterPolygon[] = []
    for (const { p } of indexed) {
        // 只需与已保留的更大多边形比较：任一容器一定先于它入选
        if (!kept.some((q) => polyContains(q, p))) kept.push(p)
    }
    return kept
}
