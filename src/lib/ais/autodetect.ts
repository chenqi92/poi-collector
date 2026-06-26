// 从一条采样文档自动识别 AIS 数据模式与字段映射。
// 同时用于 ES 连接面板与航迹浏览页（选索引后自动映射）。

import { type DataMode, type FieldMapping, type TimestampFormat, emptyMapping } from './types'

type Leaf = { path: string; value: unknown }

function flattenLeaves(obj: Record<string, unknown>, prefix: string, out: Leaf[]) {
    for (const k of Object.keys(obj)) {
        const p = prefix ? `${prefix}.${k}` : k
        const v = obj[k]
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            flattenLeaves(v as Record<string, unknown>, p, out)
        } else {
            out.push({ path: p, value: v })
        }
    }
}

function detectTimestamp(leaves: Leaf[]): { path: string; fmt: TimestampFormat } | null {
    const pick = (cands: Leaf[]): { path: string; fmt: TimestampFormat } | null => {
        for (const l of cands) {
            if (typeof l.value === 'number') {
                const fmt: TimestampFormat = l.value > 1e12 ? 'epoch_ms' : l.value > 1e9 ? 'epoch_s' : 'epoch_ms'
                return { path: l.path, fmt }
            }
            if (typeof l.value === 'string' && /\d{4}.?\d{2}.?\d{2}/.test(l.value) && /[T:]/.test(l.value)) {
                return { path: l.path, fmt: 'iso' }
            }
        }
        return null
    }
    const named = leaves.filter((l) => /time|date|ts|epoch/i.test(l.path))
    return pick(named) ?? pick(leaves)
}

export function mappingIsEmpty(m: FieldMapping): boolean {
    return !m.message.trim() && !m.mmsi.trim() && !m.lat.trim() && !m.geoPoint.trim()
}

export function autoDetect(sample: unknown): { dataMode: DataMode; fieldMapping: FieldMapping } | null {
    if (!sample || typeof sample !== 'object') return null
    const leaves: Leaf[] = []
    flattenLeaves(sample as Record<string, unknown>, '', leaves)
    if (leaves.length === 0) return null
    const ts = detectTimestamp(leaves)

    // raw 模式：含 AIVDM 报文
    const msg = leaves.find((l) => typeof l.value === 'string' && l.value.includes('!AIV'))
    if (msg) {
        return {
            dataMode: 'raw',
            fieldMapping: {
                ...emptyMapping(),
                message: msg.path,
                timestamp: ts?.path ?? '',
                timestampFormat: ts?.fmt ?? 'epoch_ms',
                navStatusAnchored: ['1', '5'],
            },
        }
    }

    // 结构化模式
    const m = emptyMapping()
    if (ts) {
        m.timestamp = ts.path
        m.timestampFormat = ts.fmt
    }
    const num = (l: Leaf): number | null => {
        if (typeof l.value === 'number') return l.value
        if (typeof l.value === 'string' && l.value.trim() !== '' && !Number.isNaN(Number(l.value))) return Number(l.value)
        return null
    }
    const byName = (re: RegExp, valOk?: (n: number) => boolean): string => {
        for (const l of leaves) {
            if (!re.test(l.path)) continue
            if (valOk) {
                const n = num(l)
                if (n == null || !valOk(n)) continue
            }
            return l.path
        }
        return ''
    }
    m.lat = byName(/(^|[._])(lat|latitude)($|[._])/i, (n) => n >= -90 && n <= 90)
    m.lon = byName(/(^|[._])(lon|lng|long|longitude)($|[._])/i, (n) => n >= -180 && n <= 180)
    m.mmsi = byName(/mmsi|shipid|ship_id/i)
    if (m.mmsi) m.aggField = `${m.mmsi}.keyword`
    m.name = byName(/shipname|ship_name|vesselname|(^|[._])name($|[._])/i)
    m.sog = byName(/sog|speed/i)
    m.cog = byName(/cog|course/i)
    m.heading = byName(/heading|hdg/i)
    m.navStatus = byName(/nav.?status|status/i)
    return { dataMode: 'fields', fieldMapping: m }
}

/** 一行人类可读的映射摘要 */
export function mappingSummary(dataMode: DataMode, m: FieldMapping): string {
    if (dataMode === 'raw') {
        return `原始 AIVDM · 报文=${m.message || '?'} · 时间=${m.timestamp || '?'}`
    }
    const lonlat = m.geoPoint ? m.geoPoint : `${m.lat || '?'},${m.lon || '?'}`
    return `结构化 · MMSI=${m.aggField || m.mmsi || '?'} · 经纬=${lonlat} · 时间=${m.timestamp || '?'}`
}
