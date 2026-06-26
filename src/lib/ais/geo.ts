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

// —— 水域面并集（dissolve）成岸线围栏 ——
// outermostPolygons 只能去掉「嵌套包含」的内层多边形；相邻/铺砌的水域面瓦片
// 互不包含，几乎删不掉，于是地图上还是一堆重叠内框。下面做真正的并集，只保留
// 合并后的外环（共享内边被消掉），就是一圈干净的岸边围栏。

/** 外环有符号面积（lon=x, lat=y；CCW 为正） */
function signedRingArea(ring: Ring): number {
    const n = ring.length
    if (n < 3) return 0
    let a = 0
    for (let i = 0, j = n - 1; i < n; j = i++) {
        a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
    }
    return a / 2
}

/** Douglas–Peucker 抽稀（水域跨度小，直接用经纬度平面近似） */
function douglasPeucker(ring: Ring, eps: number): Ring {
    if (ring.length <= 3 || eps <= 0) return ring
    const keep = new Uint8Array(ring.length)
    keep[0] = 1
    keep[ring.length - 1] = 1
    const stack: Array<[number, number]> = [[0, ring.length - 1]]
    while (stack.length) {
        const [s, e] = stack.pop()!
        const [ax, ay] = ring[s]
        const [bx, by] = ring[e]
        const dx = bx - ax
        const dy = by - ay
        const len = Math.hypot(dx, dy) || 1
        let maxD = -1
        let idx = -1
        for (let i = s + 1; i < e; i++) {
            const [px, py] = ring[i]
            const d = Math.abs((px - ax) * dy - (py - ay) * dx) / len
            if (d > maxD) { maxD = d; idx = i }
        }
        if (maxD > eps && idx > 0) {
            keep[idx] = 1
            stack.push([s, idx], [idx, e])
        }
    }
    const out: Ring = []
    for (let i = 0; i < ring.length; i++) if (keep[i]) out.push(ring[i])
    return out
}

/**
 * 闭合环的 DP 简化：闭合环首尾同点，直接套用开线 DP 会因「基线长度为 0」把所有
 * 中间点判定为 0 距离而误删光。这里在离起点最远的顶点处把环切成两段开线分别简化，
 * 再拼回闭合环，避免退化。
 */
function simplifyClosedRing(ring: Ring, eps: number): Ring {
    const n = ring.length
    if (n <= 5) return ring // 太短（含闭合重复点）不简化
    const pts = ring.slice(0, n - 1) // 去掉闭合重复的末点 → 开放顶点
    const m = pts.length
    let far = 0
    let farD = -1
    for (let i = 1; i < m; i++) {
        const dx = pts[i][0] - pts[0][0]
        const dy = pts[i][1] - pts[0][1]
        const d = dx * dx + dy * dy
        if (d > farD) { farD = d; far = i }
    }
    const arc1 = pts.slice(0, far + 1)           // pts[0..far]
    const arc2 = pts.slice(far).concat([pts[0]]) // pts[far..m-1], pts[0]
    const s1 = douglasPeucker(arc1, eps)         // 端点 pts[0]、pts[far]
    const s2 = douglasPeucker(arc2, eps)         // 端点 pts[far]、pts[0]
    const merged = s1.concat(s2.slice(1))        // 共享 pts[far]，末尾回到 pts[0]
    return merged.length >= 4 ? merged : ring
}

/**
 * 扫描线栅格化 + 单元边界追踪求并集外环（岸线围栏），零依赖、对脏数据稳健。
 * 把所有水域面用扫描线填进占据网格（相互覆盖即得并集），再沿占据边界串出外环，
 * 面积过滤掉小噪点环，最后 DP 抽稀变顺滑。targetCells 控制长轴方向的栅格数（越大
 * 越精细）。扫描线 O(边数) 远快于逐格点测，可上很细的网格。纯函数，不修改入参。
 * 与后端 chart_collector/commands.rs 的 dissolve_water_outlines 同一套算法。
 */
export function dissolveOutlineGrid(
    polys: WaterPolygon[],
    targetCells = 4096,
): WaterPolygon[] {
    if (polys.length === 0) return []
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity
    for (const p of polys) {
        const b = p.bbox
        if (b.minLon < minLon) minLon = b.minLon
        if (b.minLat < minLat) minLat = b.minLat
        if (b.maxLon > maxLon) maxLon = b.maxLon
        if (b.maxLat > maxLat) maxLat = b.maxLat
    }
    const lonSpan = maxLon - minLon
    const latSpan = maxLat - minLat
    if (!(lonSpan > 0) || !(latSpan > 0)) return []

    const cell = Math.max(lonSpan, latSpan) / Math.max(16, targetCells)
    const originLon = minLon - cell
    const originLat = minLat - cell
    const cols = Math.ceil(lonSpan / cell) + 2 // 四周各留 1 格空白，保证边界闭合
    const rows = Math.ceil(latSpan / cell) + 2

    // 1) 扫描线栅格化：把每个水域面（各环 even-odd）填进占据网格 occ，多边形相互
    //    覆盖即自然得到并集占据。采样取每格中心；水平边按半开区间规则跳过。
    const occ = new Uint8Array(cols * rows)
    const xs: number[] = []
    for (const poly of polys) {
        const b = poly.bbox
        let j0 = Math.floor((b.minLat - originLat) / cell - 0.5)
        let j1 = Math.ceil((b.maxLat - originLat) / cell - 0.5)
        if (j0 < 0) j0 = 0
        if (j1 > rows - 1) j1 = rows - 1
        for (let j = j0; j <= j1; j++) {
            const lat = originLat + (j + 0.5) * cell
            xs.length = 0
            for (const ring of poly.rings) {
                for (let k = 0, l = ring.length - 1; k < ring.length; l = k++) {
                    const ay = ring[l][1]
                    const by = ring[k][1]
                    if ((ay <= lat && by > lat) || (by <= lat && ay > lat)) {
                        const ax = ring[l][0]
                        const bx = ring[k][0]
                        xs.push(ax + ((lat - ay) / (by - ay)) * (bx - ax))
                    }
                }
            }
            if (xs.length < 2) continue
            xs.sort((a, b) => a - b)
            for (let k = 0; k + 1 < xs.length; k += 2) {
                let i0 = Math.ceil((xs[k] - originLon) / cell - 0.5)
                let i1 = Math.floor((xs[k + 1] - originLon) / cell - 0.5)
                if (i0 < 0) i0 = 0
                if (i1 > cols - 1) i1 = cols - 1
                const base = j * cols
                for (let i = i0; i <= i1; i++) occ[base + i] = 1
            }
        }
    }
    const filled = (i: number, j: number) =>
        i >= 0 && j >= 0 && i < cols && j < rows && occ[j * cols + i] === 1

    // 2) 边界有向边：让水域单元始终在边的左侧 → 外环 CCW、洞 CW。
    //    角点编号 key = i*(rows+2)+j；存 start->[endKey...]。
    const rstride = rows + 2
    const next = new Map<number, number[]>()
    const push = (ax: number, ay: number, bx: number, by: number) => {
        const k = ax * rstride + ay
        const arr = next.get(k)
        if (arr) arr.push(bx * rstride + by)
        else next.set(k, [bx * rstride + by])
    }
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
            if (occ[j * cols + i] !== 1) continue
            if (!filled(i, j - 1)) push(i, j, i + 1, j)         // 下边 → +x
            if (!filled(i + 1, j)) push(i + 1, j, i + 1, j + 1) // 右边 → +y
            if (!filled(i, j + 1)) push(i + 1, j + 1, i, j + 1) // 上边 → -x
            if (!filled(i - 1, j)) push(i, j + 1, i, j)         // 左边 → -y
        }
    }

    // 3) 有向边串成闭环（每步消耗一条边，guard 防止极端情况死循环）
    const cornerLon = (i: number) => originLon + i * cell
    const cornerLat = (j: number) => originLat + j * cell
    const guardMax = cols * rows * 4 + 8
    const minArea = (4 * cell) * (4 * cell) // 丢掉小于约 4 格见方的噪点环（小水体 / 小岛）
    const outers: { ring: Ring; area: number; bbox: Bbox }[] = []
    const holes: Ring[] = []
    for (const start of Array.from(next.keys())) {
        // 同一起点可能开出多条环
        for (; ;) {
            const head = next.get(start)
            if (!head || head.length === 0) break
            const ring: Ring = []
            let cur = start
            let guard = guardMax
            while (guard-- > 0) {
                const outs = next.get(cur)
                if (!outs || outs.length === 0) break
                const nk = outs.pop()!
                ring.push([cornerLon(Math.floor(cur / rstride)), cornerLat(cur % rstride)])
                cur = nk
                if (cur === start) {
                    ring.push([cornerLon(Math.floor(cur / rstride)), cornerLat(cur % rstride)])
                    break
                }
            }
            if (ring.length < 4) continue
            const f = ring[0]
            const l = ring[ring.length - 1]
            if (f[0] !== l[0] || f[1] !== l[1]) ring.push([f[0], f[1]])
            const area = signedRingArea(ring)
            if (Math.abs(area) <= minArea) continue // 太小的水体 / 小岛，丢掉
            const simplified = simplifyClosedRing(ring, cell * 0.7)
            if (simplified.length < 4) continue
            if (area > 0) outers.push({ ring: simplified, area, bbox: ringsBbox([simplified]) })
            else holes.push(simplified) // CW 环 = 中间的陆地/岛，作为洞挖掉
        }
    }
    // 把每个洞（岛）分配给包含它的最小外环 → 中间陆地被挖空，输出带洞多边形
    outers.sort((a, b) => a.area - b.area) // 小 → 大：第一个包含它的就是最小外环
    const holeLists: Ring[][] = outers.map(() => [])
    for (const h of holes) {
        const px = h[0][0]
        const py = h[0][1]
        for (let oi = 0; oi < outers.length; oi++) {
            const b = outers[oi].bbox
            if (px < b.minLon || px > b.maxLon || py < b.minLat || py > b.maxLat) continue
            if (pointInRing(px, py, outers[oi].ring)) { holeLists[oi].push(h); break }
        }
    }
    return outers.map((o, i) => makePoly([o.ring, ...holeLists[i]]))
}

/**
 * 把一组水域面并成岸线围栏，只返回合并后的外环（每个 WaterPolygon 仅 rings[0]，
 * 无洞），可与现有外环渲染方式一致。纯函数，不修改入参。
 */
export function dissolveOutline(polys: WaterPolygon[]): WaterPolygon[] {
    return dissolveOutlineGrid(polys)
}
