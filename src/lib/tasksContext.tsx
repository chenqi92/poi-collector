import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ShellTask, TaskStatus } from './shellData'
import { isActive, isRunning } from './shellData'
import { externalPushNotification } from './notificationsContext'
import { osNotify } from './osNotify'

interface TasksContextValue {
    tasks: ShellTask[]
    setTasks: (tasks: ShellTask[]) => void
    activeCount: number
    runningCount: number
    failedCount: number
    avgRunningProgress: number
}

const TasksContext = createContext<TasksContextValue | null>(null)

const TERMINAL_STATUSES: TaskStatus[] = ['done', 'failed', 'error', 'canceled', 'interrupted']

const TYPE_LABEL: Record<ShellTask['type'], string> = {
    poi: 'POI 采集',
    aton: '航标采集',
    tile: '瓦片下载',
}

export function TasksProvider({ children }: { children: ReactNode }) {
    const [tasks, setTasks] = useState<ShellTask[]>([])
    const prevStatusRef = useRef<Map<string, TaskStatus>>(new Map())
    const initializedRef = useRef(false)

    useEffect(() => {
        const prev = prevStatusRef.current
        const next = new Map<string, TaskStatus>()
        for (const t of tasks) next.set(t.id, t.status)

        if (initializedRef.current) {
            for (const t of tasks) {
                const before = prev.get(t.id)
                if (before === t.status) continue
                if (!TERMINAL_STATUSES.includes(t.status)) continue
                if (before && TERMINAL_STATUSES.includes(before)) continue

                const variant =
                    t.status === 'done' ? 'success'
                    : t.status === 'canceled' || t.status === 'interrupted' ? 'warn'
                    : 'error'
                const statusLabel =
                    t.status === 'done' ? '已完成'
                    : t.status === 'failed' ? '失败'
                    : t.status === 'error' ? '出错'
                    : t.status === 'canceled' ? '已取消'
                    : '已中断'
                const title = `${TYPE_LABEL[t.type] ?? '任务'} ${statusLabel}`
                externalPushNotification({
                    title,
                    description: t.name,
                    variant,
                    source: 'task',
                })
                osNotify(title, t.name)
            }
        }
        prevStatusRef.current = next
        initializedRef.current = true
    }, [tasks])

    const value = useMemo<TasksContextValue>(() => {
        const running = tasks.filter(isRunning)
        const avg = running.length === 0
            ? 0
            : running.reduce((s, t) => s + (t.progress ?? 0), 0) / running.length
        return {
            tasks,
            setTasks,
            activeCount: tasks.filter(isActive).length,
            runningCount: running.length,
            failedCount: tasks.filter(t => t.status === 'failed').length,
            avgRunningProgress: avg,
        }
    }, [tasks])

    return <TasksContext.Provider value={value}>{children}</TasksContext.Provider>
}

export function useTasksContext() {
    const ctx = useContext(TasksContext)
    if (!ctx) throw new Error('useTasksContext must be used inside TasksProvider')
    return ctx
}
