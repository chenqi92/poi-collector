import { useEffect, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Titlebar } from './Titlebar'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { StatusBar } from './StatusBar'
import { CommandPalette } from './CommandPalette'
import { ContextMenuHost } from './ContextMenu'
import { Onboarding, shouldShowOnboarding } from './Onboarding'
import { APP_VERSION } from '@/lib/version'

const COLLAPSE_KEY = 'poi-ui-sidebar-collapsed'

/* Routes that have been rewritten to the new design and own their own
   padding/layout via the .page system. As more pages migrate this list grows. */
const NEW_DESIGN_ROUTES = ['/workspace', '/new', '/data', '/offline', '/ais', '/settings']

function detectPlatformLabel(): string {
    if (typeof navigator === 'undefined') return 'Desktop'
    const ua = navigator.userAgent || ''
    if (/Mac OS X|Macintosh/.test(ua)) return 'macOS'
    if (/Windows/.test(ua)) return 'Windows'
    if (/Linux/.test(ua)) return 'Linux'
    return 'Desktop'
}

export function Shell() {
    const [collapsed, setCollapsed] = useState<boolean>(() =>
        localStorage.getItem(COLLAPSE_KEY) === '1'
    )
    const [cmdOpen, setCmdOpen] = useState(false)
    const [onbOpen, setOnbOpen] = useState(false)
    const location = useLocation()
    const navigate = useNavigate()
    const isNewDesign = NEW_DESIGN_ROUTES.some(r => location.pathname.startsWith(r))

    useEffect(() => {
        localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0')
    }, [collapsed])

    // First-launch onboarding (delayed so it doesn't fight the initial render).
    useEffect(() => {
        if (shouldShowOnboarding()) {
            const t = setTimeout(() => setOnbOpen(true), 400)
            return () => clearTimeout(t)
        }
    }, [])

    // Global shortcuts: ⌘K palette, ⌘1-4/⌘, route jumps, ⌘⇧L theme toggle (handled inside palette items).
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const mod = e.metaKey || e.ctrlKey
            if (mod && e.key.toLowerCase() === 'k') {
                e.preventDefault()
                setCmdOpen(true)
            } else if (mod && !e.shiftKey && e.key === '1') {
                e.preventDefault(); navigate('/workspace')
            } else if (mod && !e.shiftKey && e.key === '2') {
                e.preventDefault(); navigate('/new')
            } else if (mod && !e.shiftKey && e.key === '3') {
                e.preventDefault(); navigate('/data')
            } else if (mod && !e.shiftKey && e.key === '4') {
                e.preventDefault(); navigate('/offline')
            } else if (mod && !e.shiftKey && e.key === '5') {
                e.preventDefault(); navigate('/ais')
            } else if (mod && e.key === ',') {
                e.preventDefault(); navigate('/settings')
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [navigate])

    const platform = detectPlatformLabel()

    return (
        <div className="app-root">
            <div className="win">
                <Titlebar title={`GeoCollector — 地理数据采集 · v${APP_VERSION}`} />

                <div className="shell">
                    <Sidebar collapsed={collapsed} />

                    <div className="main">
                        <Topbar
                            collapsed={collapsed}
                            setCollapsed={setCollapsed}
                            onCmdOpen={() => setCmdOpen(true)}
                        />
                        {isNewDesign ? (
                            <Outlet />
                        ) : (
                            /* Legacy pages assume a padded container. New-design
                               pages opt out via NEW_DESIGN_ROUTES and use the
                               .page / .page-scroll structure. */
                            <div className="flex-1 min-h-0 overflow-hidden p-6">
                                <Outlet />
                            </div>
                        )}
                    </div>
                </div>

                <StatusBar platformLabel={platform} />
            </div>

            <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} />
            <Onboarding open={onbOpen} onClose={() => setOnbOpen(false)} />
            <ContextMenuHost />
        </div>
    )
}
