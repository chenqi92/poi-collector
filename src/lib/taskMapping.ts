import type { ShellTask, TaskStatus, TaskType, PlatformKey } from './shellData'

export interface UnifiedTask {
    id: string
    task_type: string
    name: string
    status: string
    total: number
    completed: number
    failed: number
    platform: string | null
    output_path: string | null
    created_at: string | null
    completed_at: string | null
    extra: string | null
}

const STATUS_NORMALIZE: Record<string, TaskStatus> = {
    running: 'running',
    downloading: 'downloading',
    paused: 'paused',
    completed: 'done',
    done: 'done',
    failed: 'failed',
    error: 'error',
    canceled: 'canceled',
    cancelled: 'canceled',
    interrupted: 'interrupted',
    queued: 'queued',
    pending: 'queued',
    idle: 'idle',
    retrying: 'retrying',
}

export function normalizeStatus(s: string): TaskStatus {
    return STATUS_NORMALIZE[s.toLowerCase()] ?? 'idle'
}

export function inferType(taskType: string): TaskType {
    const t = taskType.toLowerCase()
    if (t.includes('tile')) return 'tile'
    if (t.includes('buoy') || t.includes('aton') || t.includes('feature')) return 'aton'
    return 'poi'
}

export function inferPlatforms(platform: string | null): PlatformKey[] {
    if (!platform) return []
    return (platform.split(/[,，\s]+/).filter(Boolean) as PlatformKey[])
}

/** 解析 extra JSON 中的 total_collected（POI 任务的实际采集条数）。 */
function parseCollected(extra: string | null): number | undefined {
    if (!extra) return undefined
    try {
        const obj = JSON.parse(extra)
        const v = obj?.total_collected
        return typeof v === 'number' ? v : undefined
    } catch {
        return undefined
    }
}

export function toShellTask(u: UnifiedTask): ShellTask {
    const progress = u.total > 0 ? Math.min(1, u.completed / u.total) : 0
    const collected = parseCollected(u.extra)
    return {
        id: u.id,
        name: u.name,
        type: inferType(u.task_type),
        status: normalizeStatus(u.status),
        platforms: inferPlatforms(u.platform),
        progress,
        done: u.completed,
        total: u.total,
        fail: u.failed,
        collected,
        speed: '—',
        eta: '—',
        started: u.created_at ?? undefined,
    }
}
