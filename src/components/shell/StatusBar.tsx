import { GcIcon } from './Icon'
import { useTasksContext } from '@/lib/tasksContext'
import { APP_VERSION } from '@/lib/version'

interface StatusBarProps {
    platformLabel?: string
    version?: string
}

export function StatusBar({ platformLabel = 'Desktop', version = APP_VERSION }: StatusBarProps) {
    const { tasks, runningCount, failedCount } = useTasksContext()
    const firstActive = tasks.find(t => t.status === 'running' || t.status === 'downloading' || t.status === 'retrying')
    return (
        <div className="statusbar">
            <div className="sb-item">
                <span className="sb-dot" />
                <span>已连接</span>
            </div>
            <div className="sb-sep" />
            {runningCount > 0 ? (
                <div className="sb-item accent">
                    <GcIcon name="refresh" size={11} />
                    <span>
                        {runningCount} 个任务运行中{firstActive?.speed ? ` · ${firstActive.speed}` : ''}
                    </span>
                </div>
            ) : (
                <div className="sb-item">
                    <GcIcon name="check" size={11} />
                    <span>空闲</span>
                </div>
            )}
            <div className="sb-sep" />
            {failedCount > 0 && (
                <>
                    <div className="sb-item">
                        <span className="sb-dot err" />
                        <span>{failedCount} 个失败</span>
                    </div>
                    <div className="sb-sep" />
                </>
            )}
            <div className="sb-item right">
                <span>v{version}</span>
            </div>
            <div className="sb-sep" />
            <div className="sb-item">
                <GcIcon name="globe" size={11} />
                <span>{platformLabel}</span>
            </div>
            <div className="sb-grip" title="拖动调整窗口大小" />
        </div>
    )
}
