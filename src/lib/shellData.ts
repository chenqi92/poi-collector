export type TaskStatus =
    | 'running'
    | 'downloading'
    | 'paused'
    | 'done'
    | 'failed'
    | 'error'
    | 'canceled'
    | 'interrupted'
    | 'queued'
    | 'idle'
    | 'retrying'

export type TaskType = 'poi' | 'aton' | 'tile'

export type PlatformKey =
    | 'tianditu'
    | 'amap'
    | 'baidu'
    | 'osm'
    | 'cjhd'
    | 'google'
    | 'tencent'

export interface ShellTask {
    id: string
    name: string
    type: TaskType
    status: TaskStatus
    platforms: PlatformKey[]
    progress: number // 0..1
    done: number
    total: number
    fail: number
    collected?: number // POI 任务实际采集条数（done/total 表示类别进度）
    speed: string
    eta: string
    started?: string
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
    running: '进行中',
    downloading: '下载中',
    paused: '已暂停',
    done: '已完成',
    failed: '失败',
    error: '出错',
    canceled: '已取消',
    interrupted: '已中断',
    queued: '等待中',
    idle: '空闲',
    retrying: '重试中',
}

export const PLATFORM_LABEL: Record<PlatformKey, string> = {
    tianditu: '天地图',
    amap: '高德',
    baidu: '百度',
    osm: 'OSM',
    cjhd: '长江航道图',
    google: '谷歌',
    tencent: '腾讯',
}

export const ACTIVE_STATUSES: TaskStatus[] = [
    'running',
    'downloading',
    'retrying',
    'paused',
    'queued',
]

export const RUNNING_STATUSES: TaskStatus[] = [
    'running',
    'downloading',
    'retrying',
]

export function isActive(t: ShellTask) {
    return ACTIVE_STATUSES.includes(t.status)
}

export function isRunning(t: ShellTask) {
    return RUNNING_STATUSES.includes(t.status)
}
