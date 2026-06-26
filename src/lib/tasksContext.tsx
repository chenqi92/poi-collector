import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { ShellTask, TaskStatus } from './shellData'
import { isActive, isRunning } from './shellData'
import { toShellTask, type UnifiedTask } from './taskMapping'
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
    feature: '航道图专题',
    tile: '瓦片下载',
}

export function TasksProvider({ children }: { children: ReactNode }) {
    const [tasks, setTasks] = useState<ShellTask[]>([])
    const prevStatusRef = useRef<Map<string, TaskStatus>>(new Map())

    // 全局轮询任务列表（含运行中任务），不依赖任何具体页面挂载，
    // 这样「进行中」「任务历史」「工作台」始终拿到一致的实时数据。
    useEffect(() => {
        let cancelled = false
        let timer: ReturnType<typeof setTimeout> | null = null

        const poll = async () => {
            try {
                const list = await invoke<UnifiedTask[]>('get_all_task_history')
                if (!cancelled) setTasks(list.map(toShellTask))
            } catch { /* ignore */ }
            if (!cancelled) timer = setTimeout(poll, 2500)
        }
        poll()

        return () => {
            cancelled = true
            if (timer) clearTimeout(timer)
        }
    }, [])

    useEffect(() => {
        const prev = prevStatusRef.current
        for (const t of tasks) {
            const before = prev.get(t.id)
            // First time we see this task: don't notify, just record its status.
            // Prevents historical terminal tasks from being announced on every
            // app launch when Dashboard hydrates the task list.
            if (before === undefined) continue
            if (before === t.status) continue
            if (!TERMINAL_STATUSES.includes(t.status)) continue
            if (TERMINAL_STATUSES.includes(before)) continue

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
        const next = new Map<string, TaskStatus>()
        for (const t of tasks) next.set(t.id, t.status)
        prevStatusRef.current = next
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
