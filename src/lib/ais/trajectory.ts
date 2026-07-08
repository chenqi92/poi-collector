// 航迹分段：把单船按时间排序的点分成「行驶段」与「停泊段」。
// 停泊段把连续静止点聚成一个锚点（质心 + 摆动半径），渲染时航线跨过它连线，
// 避免停泊抖动产生一堆碎线。

import type { AisPoint, TrajParams } from './types'

export const DEFAULT_TRAJ: TrajParams = {
    speedAnchorKn: 0.5,
    anchorRadiusM: 60,
    anchorMinDurationS: 300,
    simplifyToleranceM: 8,
    anchorMaxDriftKn: 0.2,
    maxJumpKn: 30,
    maxJumpKm: 8,
    tripGapMinutes: 30,
    gapBridgeMinutes: 0, // 0 = 自动
}

// 「信号空档」自动判定参数（gapBridgeMinutes=0 时用）：
// 只有「间隔 > GAP_FACTOR × 该船常态间隔、下限 GAP_FLOOR_S」且「直线拉开 ≥ GAP_MIN_M」的
// 相邻两点才算缺口。距离下限专门滤掉密集/慢速的正常短跳，只把横穿水道的长直连线判成缺口。
const GAP_FACTOR = 3
const GAP_FLOOR_S = 240 // 再密集也不把 < 4 分钟的间隔当缺口
const GAP_MIN_M = 800 // 直线距离 < 800m 的间隔不桥接（视觉上可忽略，且多为正常慢速）

/** 相邻两点是否构成「信号空档」：时间间隔超阈值且拉开足够距离。 */
function isGap(a: AisPoint, b: AisPoint, gapS: number, minM: number): boolean {
    if (!Number.isFinite(gapS)) return false
    const dt = (b.ts - a.ts) / 1000
    if (dt <= gapS) return false
    return haversineM(a.lon, a.lat, b.lon, b.lat) >= minM
}

/** 该航迹的自动空档阈值(秒)：常态采样间隔中位数 × 倍数，带下限。点太少返回 Infinity（不判定）。 */
function autoGapSeconds(pts: AisPoint[]): number {
    if (pts.length < 4) return Infinity
    const dts: number[] = []
    for (let k = 1; k < pts.length; k++) {
        const dt = (pts[k].ts - pts[k - 1].ts) / 1000
        if (dt > 0) dts.push(dt)
    }
    if (dts.length < 3) return Infinity
    dts.sort((a, b) => a - b)
    const median = dts[Math.floor(dts.length / 2)]
    return Math.max(GAP_FLOOR_S, GAP_FACTOR * median)
}

export interface SailingSegment {
    kind: 'sailing'
    points: AisPoint[]
    /** 为某航次的首段时为真，渲染时不与上一航次连线 */
    newTrip?: boolean
    /** 所属航次序号（与 trips 下标一致），用于按航次着色/显隐 */
    tripIndex?: number
    /** 本段紧接一个「信号空档」：与上一段之间是接收缺口，渲染时用虚线/补全路径而非实线 */
    afterGap?: boolean
    /** 缺口的「沿水域补全」折线（WGS [lon,lat]），由 mapmatch 事后填充；无则渲染直线 */
    gapFill?: [number, number][]
}

export interface AnchorSegment {
    kind: 'anchored'
    centroid: [number, number] // [lon, lat] WGS-84
    radiusM: number
    startTs: number
    endTs: number
    points: AisPoint[]
    newTrip?: boolean
    tripIndex?: number
}

export type Segment = SailingSegment | AnchorSegment

/** 航次配色（与航次列表的色块一致）。 */
export const TRIP_PALETTE = [
    '#2563eb', '#dc2626', '#16a34a', '#d97706', '#9333ea',
    '#0891b2', '#db2777', '#65a30d', '#e11d48', '#7c3aed',
    '#0d9488', '#c2410c', '#4f46e5', '#ca8a04', '#be123c',
]

export function tripColor(i: number): string {
    const n = TRIP_PALETTE.length
    return TRIP_PALETTE[(((i ?? 0) % n) + n) % n]
}

const KN_PER_MS = 1 / 0.514444 // m/s -> 节

export function haversineM(aLon: number, aLat: number, bLon: number, bLat: number): number {
    const R = 6371000
    const dLat = ((bLat - aLat) * Math.PI) / 180
    const dLon = ((bLon - aLon) * Math.PI) / 180
    const la1 = (aLat * Math.PI) / 180
    const la2 = (bLat * Math.PI) / 180
    const h =
        Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

export interface CleanOpts {
    /** 相邻对地速度超过此值(节)视为跳点/串号边界 */
    maxJumpKn: number
    /** 相邻两点直线距离超过此值(公里)即断开（避免跨水道长直线） */
    maxJumpKm: number
    /** 静默超过此分钟数视为新航次 */
    tripGapMinutes: number
}

export const DEFAULT_CLEAN: CleanOpts = {
    maxJumpKn: DEFAULT_TRAJ.maxJumpKn,
    maxJumpKm: DEFAULT_TRAJ.maxJumpKm,
    tripGapMinutes: DEFAULT_TRAJ.tripGapMinutes,
}

export interface CleanResult {
    /** 保留的全部点（按航次顺序拼接） */
    points: AisPoint[]
    /** 切分出的连贯航次 */
    trips: AisPoint[][]
    /** 去掉的重复/孤立跳点/碎片点数 */
    dropped: number
    /** 被清洗掉的点（坐标有效、可在地图上展示的那些：重复时间戳点 + 孤立跳点碎片） */
    droppedPoints: AisPoint[]
    /** 数据无可用时间戳（所有点时间相同/缺失）：未做时间清洗，按报文顺序展示 */
    noTime: boolean
}

/**
 * 单 MMSI 航迹清洗 + 多目标拆分（按位置把多船共号/多航次还原成各自的连贯航迹）：
 *  1) 按时间排序，去非法坐标与重复时间戳；
 *  2) 全局最近邻多目标跟踪：逐点选「对地速度最小、且速度 ≤ maxJumpKn 且单跳距离 ≤ maxJumpKm」
 *     的已有航迹接上，接不上的另起一条新航迹；静默超过 tripGapMinutes 的航迹关闭。
 *     —— 这样逐点交替的串号(多船共用一个 MMSI)会被分到各自航迹，
 *        孤立跳点会落入只有 1 个点的航迹被丢弃，长静默自然切成新航次，
 *        距离上限避免低速但单跳很远(稀疏/接收空档)被连成跨水道长直线。
 *  3) 丢掉只剩 1 个点的碎片航迹，按起始时间排序输出。
 * 解决内河 AIS 的 GPS 跳点与 MMSI 串号拼接问题。
 */
export function cleanTrack(points: AisPoint[], opts: CleanOpts = DEFAULT_CLEAN): CleanResult {
    const finite = points.filter((p) => Number.isFinite(p.lon) && Number.isFinite(p.lat))

    // 无可用时间戳（所有点时间相同/缺失，如某些索引没有时间字段）：时间去重与
    // GNN 拆分全部失去意义，会把整条航迹当成「重复时间戳」清空。这里直接按报文
    // 原始顺序整条返回，至少能把船的点连成线展示。
    let tsMin = Infinity
    let tsMax = -Infinity
    for (const p of finite) {
        if (p.ts < tsMin) tsMin = p.ts
        if (p.ts > tsMax) tsMax = p.ts
    }
    if (finite.length >= 2 && tsMax === tsMin) {
        // 无时间戳无法算速度，改按「相邻点距离」切分：单船相邻报文一般只差几百米，
        // 超过阈值视为跳变 / 串号 / 坏点边界，断开成新段，避免拉出跨图的长直连线
        // （例如纬度被冻结、经度乱跳的坏数据）。
        const maxGapM = 3000
        const trips: AisPoint[][] = []
        let cur: AisPoint[] = [finite[0]]
        for (let k = 1; k < finite.length; k++) {
            if (haversineM(finite[k - 1].lon, finite[k - 1].lat, finite[k].lon, finite[k].lat) > maxGapM) {
                trips.push(cur)
                cur = [finite[k]]
            } else {
                cur.push(finite[k])
            }
        }
        trips.push(cur)
        return { points: finite, trips, dropped: points.length - finite.length, droppedPoints: [], noTime: true }
    }

    const sorted = finite.sort((a, b) => a.ts - b.ts)
    let dropped = points.length - sorted.length
    const droppedPoints: AisPoint[] = []

    // 1) 去重复时间戳
    const dedup: AisPoint[] = []
    for (const p of sorted) {
        const prev = dedup[dedup.length - 1]
        if (prev && p.ts - prev.ts <= 0) {
            dropped++
            droppedPoints.push(p)
            continue
        }
        dedup.push(p)
    }

    // 2) 全局最近邻多目标跟踪
    const gapS = opts.tripGapMinutes * 60
    const maxJumpM = Math.max(0, opts.maxJumpKm) * 1000
    const open: { points: AisPoint[]; last: AisPoint }[] = []
    const finished: AisPoint[][] = []
    for (const p of dedup) {
        // 关闭静默过久的航迹
        for (let k = open.length - 1; k >= 0; k--) {
            if ((p.ts - open[k].last.ts) / 1000 > gapS) {
                finished.push(open[k].points)
                open.splice(k, 1)
            }
        }
        // 选对地速度最小、且速度与单跳距离都在阈值内的航迹接上
        // 距离上限避免：低速但单跳很远(稀疏/串号/接收空档)被连成跨水道长直线
        let best = -1
        let bestKn = Infinity
        for (let k = 0; k < open.length; k++) {
            const last = open[k].last
            const distM = haversineM(last.lon, last.lat, p.lon, p.lat)
            if (maxJumpM > 0 && distM > maxJumpM) continue
            const dt = (p.ts - last.ts) / 1000
            const kn = dt <= 0 ? Infinity : (distM / dt) * KN_PER_MS
            if (kn <= opts.maxJumpKn && kn < bestKn) {
                bestKn = kn
                best = k
            }
        }
        if (best >= 0) {
            open[best].points.push(p)
            open[best].last = p
        } else {
            open.push({ points: [p], last: p })
        }
    }
    for (const t of open) finished.push(t.points)

    // 3) 丢碎片（只有 1 个点的孤立航迹 = 接不上任何航迹的跳点），按起始时间排序
    const trips: AisPoint[][] = []
    for (const t of finished) {
        if (t.length >= 2) trips.push(t)
        else {
            dropped += t.length
            for (const p of t) droppedPoints.push(p)
        }
    }
    trips.sort((a, b) => a[0].ts - b[0].ts)

    return { points: trips.flat(), trips, dropped, droppedPoints, noTime: false }
}

/** 逐点判定是否静止：导航状态优先，其次 SOG，再次相邻点推算速度兜底。 */
function classify(pts: AisPoint[], params: TrajParams, anchoredSet: Set<string>): boolean[] {
    const n = pts.length
    const flags = new Array<boolean>(n).fill(false)
    for (let i = 0; i < n; i++) {
        const p = pts[i]
        if (p.navStatus != null && anchoredSet.has(String(p.navStatus))) {
            flags[i] = true
            continue
        }
        if (p.sog != null && Number.isFinite(p.sog)) {
            flags[i] = p.sog <= params.speedAnchorKn
            continue
        }
        let minKn = Infinity
        for (const k of [i - 1, i + 1]) {
            if (k < 0 || k >= n) continue
            const dt = Math.abs(pts[k].ts - p.ts) / 1000
            if (dt <= 0) continue
            const d = haversineM(p.lon, p.lat, pts[k].lon, pts[k].lat)
            minKn = Math.min(minKn, (d / dt) * KN_PER_MS)
        }
        flags[i] = Number.isFinite(minKn) ? minKn <= params.speedAnchorKn * 2 : false
    }
    return flags
}

export function segmentTrack(
    points: AisPoint[],
    params: TrajParams,
    anchoredValues: string[] = [],
): Segment[] {
    if (points.length === 0) return []
    const pts = [...points].sort((a, b) => a.ts - b.ts)
    const anchoredSet = new Set(anchoredValues.map(String))
    const flags = classify(pts, params, anchoredSet)

    // 信号空档阈值：显式设了 gapBridgeMinutes 用绝对值，否则按常态间隔自适应
    const gapS =
        params.gapBridgeMinutes && params.gapBridgeMinutes > 0
            ? params.gapBridgeMinutes * 60
            : autoGapSeconds(pts)

    const segs: Segment[] = []
    let sailing: AisPoint[] = []
    let lastSail: AisPoint | null = null
    let pendingGap = false // 下一个 flush 出的行驶段是否紧接一个信号空档
    const flush = () => {
        if (sailing.length) {
            segs.push({ kind: 'sailing', points: sailing, afterGap: pendingGap || undefined })
            sailing = []
            pendingGap = false
        }
    }
    // 往行驶段追加一个点；若与上一点构成信号空档，先断段（渲染层会在断点画虚线桥/补全路径）
    const pushSail = (p: AisPoint) => {
        if (lastSail && isGap(lastSail, p, gapS, GAP_MIN_M)) {
            flush() // 收尾缺口前的一段
            pendingGap = true // 缺口后新起的一段标记 afterGap
        }
        sailing.push(p)
        lastSail = p
    }

    let i = 0
    while (i < pts.length) {
        if (!flags[i]) {
            pushSail(pts[i])
            i++
            continue
        }
        // 收集一段连续静止点
        let j = i
        while (j < pts.length && flags[j]) j++
        const cluster = pts.slice(i, j)
        const durS = (cluster[cluster.length - 1].ts - cluster[0].ts) / 1000
        let lo = 0
        let la = 0
        for (const p of cluster) {
            lo += p.lon
            la += p.lat
        }
        lo /= cluster.length
        la /= cluster.length
        let radius = 0
        for (const p of cluster) radius = Math.max(radius, haversineM(lo, la, p.lon, p.lat))

        // 净进展速度：低速但净位移仍在推进(顶流)不算停泊，避免把缓慢顶流航行误判为锚泊
        const first = cluster[0]
        const lastP = cluster[cluster.length - 1]
        const netM = haversineM(first.lon, first.lat, lastP.lon, lastP.lat)
        const progressKn = durS > 0 ? (netM / durS) * KN_PER_MS : 0
        const maxDriftKn = params.anchorMaxDriftKn ?? DEFAULT_TRAJ.anchorMaxDriftKn
        const isAnchor =
            cluster.length >= 3 && durS >= params.anchorMinDurationS && progressKn <= maxDriftKn
        if (isAnchor) {
            flush()
            segs.push({
                kind: 'anchored',
                centroid: [lo, la],
                radiusM: Math.min(Math.max(radius, 8), params.anchorRadiusM * 6),
                startTs: cluster[0].ts,
                endTs: cluster[cluster.length - 1].ts,
                points: cluster,
            })
            // 停泊段本身已用虚线桥跨过，前后行驶段不再互相做空档判定
            lastSail = null
        } else {
            // 不够停泊条件，并回行驶段（同样做空档判定）
            for (const p of cluster) pushSail(p)
        }
        i = j
    }
    flush()
    return coalesceAnchors(segs, params)
}

/**
 * 合并「同一处停泊」被短暂漂移切碎的多个锚点：相邻锚点（中间至多夹一段短行驶）
 * 若连同中间点合到一起后仍落在一个合理摆动圈内（≤ anchorRadiusM×6），视为一次停泊，
 * 重算质心/半径/时间。解决 GPS 在原地飘导致的一处停泊被切成一堆重叠锚点。
 */
export function coalesceAnchors(segs: Segment[], params: TrajParams): Segment[] {
    const cap = (params.anchorRadiusM || DEFAULT_TRAJ.anchorRadiusM) * 6
    const mk = (pts: AisPoint[]): AnchorSegment => {
        pts.sort((a, b) => a.ts - b.ts)
        let lo = 0
        let la = 0
        for (const p of pts) {
            lo += p.lon
            la += p.lat
        }
        lo /= pts.length
        la /= pts.length
        let rad = 0
        for (const p of pts) rad = Math.max(rad, haversineM(lo, la, p.lon, p.lat))
        return {
            kind: 'anchored',
            centroid: [lo, la],
            radiusM: Math.min(Math.max(rad, 8), cap),
            startTs: pts[0].ts,
            endTs: pts[pts.length - 1].ts,
            points: pts,
        }
    }
    const out: Segment[] = []
    let i = 0
    while (i < segs.length) {
        const s = segs[i]
        if (s.kind !== 'anchored') {
            out.push(s)
            i++
            continue
        }
        let pts: AisPoint[] = [...s.points]
        let j = i + 1
        for (;;) {
            let k = j
            let bridge: AisPoint[] = []
            if (k < segs.length && segs[k].kind === 'sailing') {
                bridge = (segs[k] as SailingSegment).points
                k++
            }
            if (k >= segs.length || segs[k].kind !== 'anchored') break
            const cand = [...pts, ...bridge, ...(segs[k] as AnchorSegment).points]
            let lo = 0
            let la = 0
            for (const p of cand) {
                lo += p.lon
                la += p.lat
            }
            lo /= cand.length
            la /= cand.length
            let rad = 0
            for (const p of cand) rad = Math.max(rad, haversineM(lo, la, p.lon, p.lat))
            if (rad > cap) break // 合并后超出摆动圈 = 不是同一处停泊（真实往返），停止
            pts = cand
            j = k + 1
        }
        out.push(mk(pts))
        i = j
    }
    return out
}

/**
 * 对多个航次分别分段，并把每个航次（除第一个）的首段标记 newTrip，
 * 渲染时不与上一航次连线（避免跨航次/跨静默拉出假航线）。
 */
export function segmentTrips(
    trips: AisPoint[][],
    params: TrajParams,
    anchoredValues: string[] = [],
): Segment[] {
    const out: Segment[] = []
    trips.forEach((trip, ti) => {
        const segs = segmentTrack(trip, params, anchoredValues)
        segs.forEach((s, si) => {
            s.tripIndex = ti
            if (ti > 0 && si === 0) s.newTrip = true
        })
        for (const s of segs) out.push(s)
    })
    return out
}

/** Douglas-Peucker 抽稀（容差为米），用等距投影近似垂距。 */
export function douglasPeucker(points: AisPoint[], toleranceM: number): AisPoint[] {
    if (points.length <= 2 || toleranceM <= 0) return points
    const lat0 = (points[0].lat * Math.PI) / 180
    const mPerDegLat = 111320
    const mPerDegLon = 111320 * Math.cos(lat0)
    const X = (p: AisPoint) => p.lon * mPerDegLon
    const Y = (p: AisPoint) => p.lat * mPerDegLat

    const keep = new Array<boolean>(points.length).fill(false)
    keep[0] = true
    keep[points.length - 1] = true
    const stack: Array<[number, number]> = [[0, points.length - 1]]
    while (stack.length) {
        const seg = stack.pop()!
        const s = seg[0]
        const e = seg[1]
        const ax = X(points[s])
        const ay = Y(points[s])
        const bx = X(points[e])
        const by = Y(points[e])
        const dx = bx - ax
        const dy = by - ay
        const len2 = dx * dx + dy * dy || 1e-9
        let maxD = -1
        let idx = -1
        for (let k = s + 1; k < e; k++) {
            const px = X(points[k])
            const py = Y(points[k])
            const t = ((px - ax) * dx + (py - ay) * dy) / len2
            const cx = ax + t * dx
            const cy = ay + t * dy
            const d = Math.hypot(px - cx, py - cy)
            if (d > maxD) {
                maxD = d
                idx = k
            }
        }
        if (maxD > toleranceM && idx > 0) {
            keep[idx] = true
            stack.push([s, idx], [idx, e])
        }
    }
    return points.filter((_, k) => keep[k])
}

/** 取分段轨迹的整体 WGS-84 包围盒（用于自动定位），无数据返回 null。 */
export function segmentsBounds(segs: Segment[]): [number, number, number, number] | null {
    let minLon = Infinity
    let minLat = Infinity
    let maxLon = -Infinity
    let maxLat = -Infinity
    const acc = (lon: number, lat: number) => {
        if (lon < minLon) minLon = lon
        if (lon > maxLon) maxLon = lon
        if (lat < minLat) minLat = lat
        if (lat > maxLat) maxLat = lat
    }
    for (const s of segs) {
        if (s.kind === 'sailing') {
            for (const p of s.points) acc(p.lon, p.lat)
        } else {
            acc(s.centroid[0], s.centroid[1])
        }
    }
    if (!Number.isFinite(minLon)) return null
    return [minLon, minLat, maxLon, maxLat] // [west, south, east, north]
}
