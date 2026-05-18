import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { GcIcon } from './Icon'
import { TaskTray } from './TaskTray'
import { useTheme } from '@/components/theme-provider'
import { useTasksContext } from '@/lib/tasksContext'

const ROUTE_LABEL: Record<string, [string, string | null]> = {
    '/workspace': ['工作台', null],
    '/new': ['新建采集', null],
    '/data': ['数据中心', null],
    '/offline': ['离线地图', null],
    '/settings': ['设置', null],
}

interface TopbarProps {
    collapsed: boolean
    setCollapsed: (v: boolean) => void
    onCmdOpen: () => void
}

export function Topbar({ collapsed, setCollapsed, onCmdOpen }: TopbarProps) {
    const { resolvedTheme, toggleTheme } = useTheme()
    const { runningCount, avgRunningProgress } = useTasksContext()
    const [trayOpen, setTrayOpen] = useState(false)

    const loc = useLocation()
    const [main, sub] = ROUTE_LABEL[loc.pathname] ?? [loc.pathname.replace(/^\//, '') || '工作台', null]

    return (
        <>
            <div className="topbar">
                <button
                    className="iconbtn"
                    onClick={() => setCollapsed(!collapsed)}
                    title="收起侧栏"
                    type="button"
                >
                    <GcIcon name="panelLeft" size={16} />
                </button>
                <div className="topbar-divider" />
                <div className="crumb">
                    <span>GeoCollector</span>
                    <span className="crumb-sep"><GcIcon name="chevronRight" size={11} /></span>
                    <b>{main}</b>
                    {sub && (
                        <>
                            <span className="crumb-sep"><GcIcon name="chevronRight" size={11} /></span>
                            <span>{sub}</span>
                        </>
                    )}
                </div>

                <div className="topbar-spacer" />

                <div className="search-pill" onClick={onCmdOpen}>
                    <GcIcon name="search" size={13} />
                    <span>搜索功能、POI、地区...</span>
                    <kbd>⌘K</kbd>
                </div>

                {runningCount > 0 && (
                    <button className="tray-btn" onClick={() => setTrayOpen(o => !o)} type="button">
                        <span className="pulse" />
                        <span>{runningCount} 个任务</span>
                        <div className="tray-mini-bar">
                            <i style={{ width: `${avgRunningProgress * 100}%` }} />
                        </div>
                    </button>
                )}

                <button className="iconbtn has-dot" title="通知" type="button">
                    <GcIcon name="bell" size={15} />
                </button>
                <button className="iconbtn" title="切换主题" onClick={toggleTheme} type="button">
                    <GcIcon name={resolvedTheme === 'dark' ? 'sun' : 'moon'} size={15} />
                </button>
            </div>
            {trayOpen && <TaskTray onClose={() => setTrayOpen(false)} />}
        </>
    )
}
