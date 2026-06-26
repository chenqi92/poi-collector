// AIS 模块共享类型。后端经 serde rename_all=camelCase 暴露，这里与之对应。

export type AuthType = 'none' | 'basic' | 'apikey'
export type SourceCrs = 'wgs84' | 'gcj02' | 'bd09'
export type BaseCrs = 'wgs84' | 'gcj02'
export type TimestampFormat = 'epoch_ms' | 'epoch_s' | 'iso'
/** fields = 结构化字段映射；raw = 原始 AIVDM 报文（后端解码） */
export type DataMode = 'fields' | 'raw'

/** 航迹分段参数（前端解释，存在连接的 trajectoryParams 里） */
export interface TrajParams {
    speedAnchorKn: number
    anchorRadiusM: number
    anchorMinDurationS: number
    simplifyToleranceM: number
    /** 停泊判定的净进展速度上限(节)：低速但净位移仍在推进(顶流)不算停泊 */
    anchorMaxDriftKn: number
    /** 清洗：相邻对地速度超过此值(节)视为 GPS 跳点/串号边界（内河默认 30） */
    maxJumpKn: number
    /** 清洗：静默超过此分钟数视为新航次，切分多船共号/多航次拼接 */
    tripGapMinutes: number
}

/** ES 字段 → 统一 AIS 字段映射，字段值支持点路径（a.b.c） */
export interface FieldMapping {
    mmsi: string
    aggField: string
    /** raw 模式：原始 AIVDM 报文字段 */
    message: string
    name: string
    lat: string
    lon: string
    geoPoint: string
    timestamp: string
    timestampFormat: TimestampFormat
    sog: string
    cog: string
    heading: string
    navStatus: string
    navStatusAnchored: string[]
}

export interface EsConnection {
    id: string
    name: string
    scheme: 'http' | 'https'
    host: string
    port: number
    index: string
    authType: AuthType
    username: string
    password: string
    apiKey: string
    acceptInvalidCerts: boolean
    sourceCrs: SourceCrs
    dataMode: DataMode
    fieldMapping: FieldMapping
    trajectoryParams: Partial<TrajParams> | null
}

export interface PullResult {
    points: AisPoint[]
    scanned: number
    decoded: number
    ships: number
    truncated: boolean
}

export interface AisPoint {
    mmsi: string
    name?: string
    lat: number
    lon: number
    ts: number
    sog?: number
    cog?: number
    heading?: number
    navStatus?: string
}

export interface ShipSummary {
    mmsi: string
    name?: string
    count: number
    firstTs?: number
    lastTs?: number
}

export interface EsTestResult {
    ok: boolean
    version: string
    clusterName?: string
    docCount?: number
    fieldPaths: string[]
    sample: unknown
    message: string
}

export interface IndexInfo {
    name: string
    docsCount?: number
}

export interface RouteResponse {
    mmsi: string
    name?: string
    points: AisPoint[]
    total: number
    truncated: boolean
}

/** 渐进式单船航迹分页（scroll） */
export interface RoutePage {
    points: AisPoint[]
    scrollId?: string
    total: number
    done: boolean
}

export function emptyMapping(): FieldMapping {
    return {
        mmsi: '',
        aggField: '',
        message: '',
        name: '',
        lat: '',
        lon: '',
        geoPoint: '',
        timestamp: '',
        timestampFormat: 'epoch_ms',
        sog: '',
        cog: '',
        heading: '',
        navStatus: '',
        navStatusAnchored: [],
    }
}

export function emptyConnection(): EsConnection {
    return {
        id: '',
        name: '',
        scheme: 'http',
        host: '',
        port: 9200,
        index: '',
        authType: 'none',
        username: '',
        password: '',
        apiKey: '',
        acceptInvalidCerts: false,
        sourceCrs: 'wgs84',
        dataMode: 'fields',
        fieldMapping: emptyMapping(),
        trajectoryParams: null,
    }
}
