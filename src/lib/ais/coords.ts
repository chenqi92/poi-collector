// 中国坐标系转换（移植自 src-tauri/src/coords.rs，并补正向 WGS-84 → GCJ-02）。
// AIS 与水域面默认是 WGS-84；叠加到 GCJ-02 底图（高德/天地图）时需正向纠偏。

import type { BaseCrs, SourceCrs } from './types'

const PI = Math.PI
const X_PI = (PI * 3000) / 180
const A = 6378245.0
const EE = 0.006693421622965943

function outOfChina(lon: number, lat: number): boolean {
    return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271
}

function transformLat(x: number, y: number): number {
    let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
    ret += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3
    ret += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3
    ret += ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3
    return ret
}

function transformLon(x: number, y: number): number {
    let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
    ret += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3
    ret += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3
    ret += ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3
    return ret
}

/** 计算 GCJ-02 相对 WGS-84 的偏移量（度） */
function gcjDelta(lon: number, lat: number): [number, number] {
    let dLat = transformLat(lon - 105, lat - 35)
    let dLon = transformLon(lon - 105, lat - 35)
    const radLat = (lat / 180) * PI
    let magic = Math.sin(radLat)
    magic = 1 - EE * magic * magic
    const sqrtMagic = Math.sqrt(magic)
    dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI)
    dLon = (dLon * 180) / ((A / sqrtMagic) * Math.cos(radLat) * PI)
    return [dLon, dLat]
}

export function wgs84ToGcj02(lon: number, lat: number): [number, number] {
    if (outOfChina(lon, lat)) return [lon, lat]
    const [dLon, dLat] = gcjDelta(lon, lat)
    return [lon + dLon, lat + dLat]
}

export function gcj02ToWgs84(lon: number, lat: number): [number, number] {
    if (outOfChina(lon, lat)) return [lon, lat]
    const [dLon, dLat] = gcjDelta(lon, lat)
    return [lon - dLon, lat - dLat]
}

export function bd09ToGcj02(lon: number, lat: number): [number, number] {
    const x = lon - 0.0065
    const y = lat - 0.006
    const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI)
    const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI)
    return [z * Math.cos(theta), z * Math.sin(theta)]
}

export function bd09ToWgs84(lon: number, lat: number): [number, number] {
    const [gl, ga] = bd09ToGcj02(lon, lat)
    return gcj02ToWgs84(gl, ga)
}

/** 按源坐标系把入库点归一化到 WGS-84 */
export function normalizeToWgs84(crs: SourceCrs, lon: number, lat: number): [number, number] {
    if (crs === 'gcj02') return gcj02ToWgs84(lon, lat)
    if (crs === 'bd09') return bd09ToWgs84(lon, lat)
    return [lon, lat]
}

/** WGS-84 → 底图坐标系（用于渲染时对齐底图） */
export function toBase(base: BaseCrs, lon: number, lat: number): [number, number] {
    return base === 'gcj02' ? wgs84ToGcj02(lon, lat) : [lon, lat]
}
