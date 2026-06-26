import { NavLink } from 'react-router-dom'
import { GcIcon } from './Icon'
import { useTasksContext } from '@/lib/tasksContext'
import { APP_VERSION } from '@/lib/version'

interface NavEntry {
    to: string
    icon: string
    label: string
    badgeKey?: 'active'
}

const NAV: NavEntry[] = [
    { to: '/workspace', icon: 'home', label: '工作台' },
    { to: '/new', icon: 'plus', label: '新建采集', badgeKey: 'active' },
    { to: '/data', icon: 'database', label: '数据中心' },
    { to: '/offline', icon: 'map', label: '离线地图' },
    { to: '/ais', icon: 'ship', label: 'AIS 航迹' },
    { to: '/settings', icon: 'settings', label: '设置' },
]

interface SidebarProps {
    collapsed?: boolean
}

export function Sidebar({ collapsed = false }: SidebarProps) {
    const { activeCount } = useTasksContext()
    return (
        <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
            <div className="sidebar-brand">
                <div className="brand-mark" />
                <span className="brand-text">GeoCollector</span>
            </div>
            <div className="sidebar-section-title">导航</div>
            {NAV.map(n => {
                const badge = n.badgeKey === 'active' ? activeCount : 0
                return (
                    <NavLink
                        key={n.to}
                        to={n.to}
                        className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                    >
                        <span className="nav-icon"><GcIcon name={n.icon} size={15} /></span>
                        <span className="nav-label">{n.label}</span>
                        {badge > 0 && <span className="nav-badge live">{badge}</span>}
                    </NavLink>
                )
            })}

            <div className="sidebar-foot">
                <div className="sidebar-account">
                    <div className="avatar">G</div>
                    <div className="account-info">
                        <div className="account-name">本地用户</div>
                        <div className="account-sub">v{APP_VERSION} · 离线</div>
                    </div>
                </div>
            </div>
        </aside>
    )
}
