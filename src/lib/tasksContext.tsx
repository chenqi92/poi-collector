import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import type { ShellTask } from './shellData'
import { isActive, isRunning } from './shellData'

interface TasksContextValue {
    tasks: ShellTask[]
    setTasks: (tasks: ShellTask[]) => void
    activeCount: number
    runningCount: number
    failedCount: number
    avgRunningProgress: number
}

const TasksContext = createContext<TasksContextValue | null>(null)

export function TasksProvider({ children }: { children: ReactNode }) {
    const [tasks, setTasks] = useState<ShellTask[]>([])

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
