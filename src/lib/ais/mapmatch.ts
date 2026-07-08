// 信号空档的「沿水域补全」：当一条直线弦横穿陆地时（AIS 缺点/漂移把绕弯的航迹连成了
// 穿过江心洲/岸线的假直线），在水域面内做栅格 A* 最短路，把两端点用一条贴着可航水道的
// 折线连起来，再用「视线拉直」去掉栅格锯齿。纯几何、零依赖，找不到路/无水域时返回 null，
// 调用方回退到直线。坐标统一 WGS-84 [lon,lat]，与水域面一致。

import type { WaterPolygon } from './geo'
import { pointInWater } from './geo'
import { haversineM, type Segment } from './trajectory'

export interface GapMatchOpts {
    /** 栅格总格数预算：决定格边长 = sqrt(面积/预算)，也是内存上限 */
    maxCells: number
    /** 格边长上限(米)：超过说明跨度过大、此分辨率下绕行不可靠，放弃回退直线 */
    maxCellM: number
    /** 包围盒在两端点外扩的比例（相对两点直线距离），给绕行留空间 */
    marginFrac: number
    /** 外扩的最小米数（近距离缺口也要有足够绕行余量） */
    minMarginM: number
    /** 判定直线是否穿陆、以及视线拉直的采样步长(米) */
    sampleM: number
    /** 栅格最小格边长(米)：再细也不会更准，且限制格数 */
    cellFloorM: number
}

export const DEFAULT_GAP_MATCH: GapMatchOpts = {
    maxCells: 40_000,
    maxCellM: 200,
    marginFrac: 0.6,
    minMarginM: 400,
    sampleM: 40,
    cellFloorM: 15,
}

function mPerDegLon(lat: number): number {
    return Math.max(1, 111320 * Math.cos((lat * Math.PI) / 180))
}
const M_PER_DEG_LAT = 111320

/** 直线 a→b 的中间采样点是否有落在水域外的（即这条弦穿陆）。 */
function straightCrossesLand(
    a: [number, number],
    b: [number, number],
    polys: WaterPolygon[],
    sampleM: number,
): boolean {
    const distM = haversineM(a[0], a[1], b[0], b[1])
    const n = Math.floor(distM / sampleM)
    for (let i = 1; i < n; i++) {
        const t = i / n
        const lon = a[0] + (b[0] - a[0]) * t
        const lat = a[1] + (b[1] - a[1]) * t
        if (!pointInWater(lon, lat, polys)) return true
    }
    return false
}

/** 视线拉直：贪心连到「仍全程在水里」的最远后继点，消掉栅格路径的锯齿台阶。 */
function stringPull(
    path: [number, number][],
    polys: WaterPolygon[],
    sampleM: number,
): [number, number][] {
    if (path.length <= 2) return path
    const out: [number, number][] = [path[0]]
    let i = 0
    while (i < path.length - 1) {
        let j = path.length - 1
        for (; j > i + 1; j--) {
            if (!straightCrossesLand(path[i], path[j], polys, sampleM)) break
        }
        out.push(path[j])
        i = j
    }
    return out
}

// 最小堆（f 值排序），A* 用；惰性删除，弹出时靠 closed 跳过陈旧项。
class MinHeap {
    private keys: number[] = []
    private vals: number[] = []
    size = 0
    push(k: number, v: number): void {
        const { keys, vals } = this
        keys.push(k)
        vals.push(v)
        this.size++
        let i = this.size - 1
        while (i > 0) {
            const p = (i - 1) >> 1
            if (keys[p] <= keys[i]) break
            ;[keys[p], keys[i]] = [keys[i], keys[p]]
            ;[vals[p], vals[i]] = [vals[i], vals[p]]
            i = p
        }
    }
    pop(): number {
        const { keys, vals } = this
        const topV = vals[0]
        this.size--
        const lastK = keys.pop() as number
        const lastV = vals.pop() as number
        if (this.size > 0) {
            keys[0] = lastK
            vals[0] = lastV
            let i = 0
            for (;;) {
                const l = 2 * i + 1
                const r = 2 * i + 2
                let m = i
                if (l < this.size && keys[l] < keys[m]) m = l
                if (r < this.size && keys[r] < keys[m]) m = r
                if (m === i) break
                ;[keys[m], keys[i]] = [keys[i], keys[m]]
                ;[vals[m], vals[i]] = [vals[i], vals[m]]
                i = m
            }
        }
        return topV
    }
}

/**
 * 扫描线栅格化：把 local 里的水域面填进 cols×rows 占据网格（水=1）。每个多边形按各环
 * even-odd 求交、填水平跨段（自动扣掉岛洞），多个多边形 OR 叠加即得并集。格中心落在
 * 某跨段内即置 1，与「格中心在水里」等价，但成本 O(行数 × 边数) 而非 O(格数 × 顶点数)。
 */
function rasterizeWater(
    local: WaterPolygon[],
    minLon: number,
    minLat: number,
    cellLon: number,
    cellLat: number,
    cols: number,
    rows: number,
): Uint8Array {
    const occ = new Uint8Array(cols * rows)
    const xs: number[] = []
    for (const poly of local) {
        const jb0 = Math.max(0, Math.floor((poly.bbox.minLat - minLat) / cellLat - 0.5))
        const jb1 = Math.min(rows - 1, Math.ceil((poly.bbox.maxLat - minLat) / cellLat - 0.5))
        for (let j = jb0; j <= jb1; j++) {
            const lat = minLat + (j + 0.5) * cellLat
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
            xs.sort((p, q) => p - q)
            const base = j * cols
            for (let s = 0; s + 1 < xs.length; s += 2) {
                let i0 = Math.ceil((xs[s] - minLon) / cellLon - 0.5)
                let i1 = Math.floor((xs[s + 1] - minLon) / cellLon - 0.5)
                if (i0 < 0) i0 = 0
                if (i1 > cols - 1) i1 = cols - 1
                for (let i = i0; i <= i1; i++) occ[base + i] = 1
            }
        }
    }
    return occ
}

/**
 * 在水域面内求 a→b 的贴岸最短路。返回 WGS [lon,lat] 折线（含精确端点），
 * 若直线本就全程在水里、或水域为空、或跨度过大/无通路则返回 null（回退直线）。
 */
export function matchGapPath(
    a: [number, number],
    b: [number, number],
    polys: WaterPolygon[],
    opts: GapMatchOpts = DEFAULT_GAP_MATCH,
): [number, number][] | null {
    if (!polys.length) return null

    const midLat = (a[1] + b[1]) / 2
    const mLon = mPerDegLon(midLat)
    const distM = haversineM(a[0], a[1], b[0], b[1])
    const marginM = Math.max(opts.minMarginM, distM * opts.marginFrac)
    const dLon = marginM / mLon
    const dLat = marginM / M_PER_DEG_LAT
    const minLon = Math.min(a[0], b[0]) - dLon
    const maxLon = Math.max(a[0], b[0]) + dLon
    const minLat = Math.min(a[1], b[1]) - dLat
    const maxLat = Math.max(a[1], b[1]) + dLat

    // 只保留与包围盒相交的水域面：既降低栅格化成本，也让穿陆判定/拉直只看局部
    const local = polys.filter(
        (p) =>
            !(
                p.bbox.maxLon < minLon ||
                p.bbox.minLon > maxLon ||
                p.bbox.maxLat < minLat ||
                p.bbox.minLat > maxLat
            ),
    )
    if (!local.length) return null
    // 直线没穿陆 → 船本可直行，无需绕（调用方仍以虚线表示这是缺口）
    if (!straightCrossesLand(a, b, local, opts.sampleM)) return null

    const wM = (maxLon - minLon) * mLon
    const hM = (maxLat - minLat) * M_PER_DEG_LAT
    const cellM = Math.max(opts.cellFloorM, Math.sqrt((wM * hM) / opts.maxCells))
    if (cellM > opts.maxCellM) return null // 跨度太大：此分辨率下绕行不可靠，回退直线
    const cols = Math.max(2, Math.ceil(wM / cellM))
    const rows = Math.max(2, Math.ceil(hM / cellM))
    const cellLon = (maxLon - minLon) / cols
    const cellLat = (maxLat - minLat) / rows
    const cellWm = cellLon * mLon
    const cellHm = cellLat * M_PER_DEG_LAT

    // 占据网格（水=1）：扫描线栅格化，O(行数 × 边数)，远快于逐格点测；
    // 每个水域面各环 even-odd（自动扣掉岛洞），多面 OR 叠加即取并集。
    const N = cols * rows
    const occ = rasterizeWater(local, minLon, minLat, cellLon, cellLat, cols, rows)

    const gx = (lon: number) =>
        Math.min(cols - 1, Math.max(0, Math.floor((lon - minLon) / cellLon)))
    const gy = (lat: number) =>
        Math.min(rows - 1, Math.max(0, Math.floor((lat - minLat) / cellLat)))
    const sa = gy(a[1]) * cols + gx(a[0])
    const sb = gy(b[1]) * cols + gx(b[0])
    occ[sa] = 1 // 端点强制可走：船确实在此处
    occ[sb] = 1
    if (sa === sb) return null

    const goalX = sb % cols
    const goalY = (sb / cols) | 0
    const h = (idx: number): number => {
        const dx = ((idx % cols) - goalX) * cellWm
        const dy = (((idx / cols) | 0) - goalY) * cellHm
        return Math.hypot(dx, dy)
    }

    const gScore = new Float64Array(N).fill(Infinity)
    const came = new Int32Array(N).fill(-1)
    const closed = new Uint8Array(N)
    gScore[sa] = 0
    const heap = new MinHeap()
    heap.push(h(sa), sa)
    let found = false
    while (heap.size > 0) {
        const cur = heap.pop()
        if (closed[cur]) continue
        closed[cur] = 1
        if (cur === sb) {
            found = true
            break
        }
        const cx = cur % cols
        const cy = (cur / cols) | 0
        for (let dj = -1; dj <= 1; dj++) {
            for (let di = -1; di <= 1; di++) {
                if (!di && !dj) continue
                const nx = cx + di
                const ny = cy + dj
                if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue
                const ni = ny * cols + nx
                if (!occ[ni] || closed[ni]) continue
                // 不允许贴着陆地对角穿缝
                if (di && dj && !occ[cy * cols + nx] && !occ[ny * cols + cx]) continue
                const step = Math.hypot(di * cellWm, dj * cellHm)
                const ng = gScore[cur] + step
                if (ng < gScore[ni]) {
                    gScore[ni] = ng
                    came[ni] = cur
                    heap.push(ng + h(ni), ni)
                }
            }
        }
    }
    if (!found) return null

    // 回溯栅格路径 → 格中心经纬度
    const cells: number[] = []
    let c = sb
    let guard = N + 1
    while (c !== -1 && guard-- > 0) {
        cells.push(c)
        if (c === sa) break
        c = came[c]
    }
    cells.reverse()
    let path: [number, number][] = cells.map((idx) => {
        const ix = idx % cols
        const iy = (idx / cols) | 0
        return [minLon + (ix + 0.5) * cellLon, minLat + (iy + 0.5) * cellLat]
    })
    if (path.length < 2) return null
    path[0] = [a[0], a[1]]
    path[path.length - 1] = [b[0], b[1]]
    return stringPull(path, local, opts.sampleM)
}

/** 段的终点 WGS 坐标（行驶段取末点，停泊段取质心）。 */
function segEnd(s: Segment): [number, number] {
    if (s.kind === 'sailing') {
        const p = s.points[s.points.length - 1]
        return [p.lon, p.lat]
    }
    return [s.centroid[0], s.centroid[1]]
}

/**
 * 给所有 afterGap 行驶段补上 gapFill（前一段终点 → 本段起点的沿水域路径）。
 * 只处理跨陆的缺口；无水域面或直线不跨陆时不改动。返回浅拷贝的新数组
 * （不修改入参，便于 memo 依赖比较）。
 */
export function annotateGapFills(
    segments: Segment[],
    polys: WaterPolygon[],
    opts: GapMatchOpts = DEFAULT_GAP_MATCH,
): Segment[] {
    if (!polys.length || segments.length < 2) return segments
    let touched = false
    const out = segments.map((s) => ({ ...s }) as Segment)
    for (let i = 1; i < out.length; i++) {
        const s = out[i]
        if (s.kind !== 'sailing' || !s.afterGap || !s.points.length) continue
        const a = segEnd(out[i - 1])
        const b: [number, number] = [s.points[0].lon, s.points[0].lat]
        const path = matchGapPath(a, b, polys, opts)
        if (path && path.length >= 2) {
            s.gapFill = path
            touched = true
        }
    }
    return touched ? out : segments
}
