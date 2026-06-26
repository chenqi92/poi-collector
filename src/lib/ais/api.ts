// AIS 后端命令的 invoke 包装。

import { invoke } from '@tauri-apps/api/core'
import type {
    EsConnection,
    EsTestResult,
    IndexInfo,
    PullResult,
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

export function aisTestConnection(conn: EsConnection): Promise<EsTestResult> {
    return invoke<EsTestResult>('ais_test_connection', { conn })
}

export function aisListIndices(conn: EsConnection): Promise<IndexInfo[]> {
    return invoke<IndexInfo[]>('ais_list_indices', { conn })
}

export function aisListShips(params: {
    connId: string
    timeFrom?: number
    timeTo?: number
    search?: string
    limit?: number
}): Promise<ShipSummary[]> {
    return invoke<ShipSummary[]>('ais_list_ships', params)
}

export function aisGetShipRoute(params: {
    connId: string
    mmsi: string
    timeFrom?: number
    timeTo?: number
    maxPoints?: number
}): Promise<RouteResponse> {
    return invoke<RouteResponse>('ais_get_ship_route', params)
}

export function aisPullWindow(params: {
    connId: string
    timeFrom?: number
    timeTo?: number
    maxPoints?: number
}): Promise<PullResult> {
    return invoke<PullResult>('ais_pull_window', params)
}
