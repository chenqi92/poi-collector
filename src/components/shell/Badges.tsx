import {
    STATUS_LABEL,
    PLATFORM_LABEL,
    type TaskStatus,
    type PlatformKey,
    type TaskType,
} from '@/lib/shellData'

export function StatusBadge({ status }: { status: TaskStatus | string }) {
    const label = (STATUS_LABEL as Record<string, string>)[status] ?? status
    return (
        <span className={`badge st-${status}`}>
            <i className="dot" />
            {label}
        </span>
    )
}

export function PlatformBadge({ name }: { name: PlatformKey | string }) {
    const label = (PLATFORM_LABEL as Record<string, string>)[name] ?? name
    return (
        <span className={`pf-badge pf-${name}`}>
            <i className="pf-mark" />
            {label}
        </span>
    )
}

const TYPE_LABEL: Record<TaskType, string> = { poi: 'POI', aton: '航标', tile: '瓦片' }
export function TypeBadge({ type }: { type: TaskType | string }) {
    return (
        <span className={`type-badge t-${type}`}>
            {(TYPE_LABEL as Record<string, string>)[type] ?? type}
        </span>
    )
}
