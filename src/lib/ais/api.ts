// AIS 后端命令的 invoke 包装。

import { invoke } from '@tauri-apps/api/core'
import type {
    EsConnection,
    EsTestResult,
    FieldMapping,
    IndexInfo,
    PullResult,
    RoutePage,
    RouteResponse,
    ShipSummary,
} from './types'

export function aisListConnections(): Promise<EsConnection[]> {
    return invoke<EsConnection[]>('ais_list_connections')
}

export function aisSaveConnection(conn: EsConnection): Promise<EsConnection> {
    return invoke<EsConnection>('ais_save_connection', { conn })
}

export function aisDeleteConnection(id: string): Promise<void> {
    return invoke<void>('ais_delete_connection', { id })
}

export function aisTestConnection(conn: EsConnection, index?: string): Promise<EsTestResult> {
    return invoke<EsTestResult>('ais_test_connection', { conn, index })
}

export function aisListIndices(conn: EsConnection): Promise<IndexInfo[]> {
    return invoke<IndexInfo[]>('ais_list_indices', { conn })
}

export function aisListShips(params: {
    connId: string
    indices: string[]
    mapping: FieldMapping
    timeFrom?: number
    timeTo?: number
    search?: string
    limit?: number
}): Promise<ShipSummary[]> {
    return invoke<ShipSummary[]>('ais_list_ships', params)
}

export function aisGetShipRoute(params: {
    connId: string
    indices: string[]
    mapping: FieldMapping
    mmsi: string
    timeFrom?: number
    timeTo?: number
    maxPoints?: number
}): Promise<RouteResponse> {
    return invoke<RouteResponse>('ais_get_ship_route', params)
}

/** 渐进式单船航迹分页：首页不传 scrollId，续页传上一页返回的 scrollId，直到 done。 */
export function aisRoutePage(params: {
    connId: string
    indices: string[]
    mapping: FieldMapping
    mmsi: string
    timeFrom?: number
    timeTo?: number
    size?: number
    scrollId?: string
}): Promise<RoutePage> {
    return invoke<RoutePage>('ais_route_page', params)
}

export function aisPullWindow(params: {
    connId: string
    indices: string[]
    mapping: FieldMapping
    timeFrom?: number
    timeTo?: number
    maxPoints?: number
    /** 指定后只拉这艘船的点（扫描全部所选索引），用于跨索引取一艘船完整航迹 */
    mmsi?: string
}): Promise<PullResult> {
    return invoke<PullResult>('ais_pull_window', params)
}
