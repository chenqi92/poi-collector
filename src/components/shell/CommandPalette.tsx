import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { GcIcon } from './Icon'
import { useTheme } from '@/components/theme-provider'

interface CommandItem {
    id: string
    group: string
    icon: string
    label: string
    sub?: string
    keywords?: string[]
    kbd?: string
    onRun: () => void
}

interface CommandPaletteProps {
    open: boolean
    onClose: () => void
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
    const navigate = useNavigate()
    const { resolvedTheme, toggleTheme, setTheme, setAccent, setDensity } = useTheme()
    const [query, setQuery] = useState('')
    const [active, setActive] = useState(0)
    const inputRef = useRef<HTMLInputElement>(null)
    const listRef = useRef<HTMLDivElement>(null)

    const go = (path: string) => () => {
        navigate(path)
        onClose()
    }

    const items = useMemo<CommandItem[]>(() => [
        // Navigation
        { id: 'nav-workspace', group: '导航', icon: 'home', label: '工作台', sub: '总览 / 最近任务 / 配额', keywords: ['dashboard', 'overview'], kbd: '⌘1', onRun: go('/workspace') },
        { id: 'nav-new', group: '导航', icon: 'plus', label: '新建采集', sub: 'POI / 航标 / 瓦片', keywords: ['collect', 'create'], kbd: '⌘2', onRun: go('/new') },
        { id: 'nav-data', group: '导航', icon: 'database', label: '数据中心', sub: '浏览 / 导出 / 整理', keywords: ['hub', 'browse', 'export'], kbd: '⌘3', onRun: go('/data') },
        { id: 'nav-offline', group: '导航', icon: 'map', label: '离线地图', sub: '瓦片包列表 / 预览 / 转换', keywords: ['tile', 'mbtiles'], kbd: '⌘4', onRun: go('/offline') },
        { id: 'nav-settings', group: '导航', icon: 'settings', label: '设置', sub: 'Keys / 偏好 / 外观', keywords: ['preferences', 'config'], kbd: '⌘,', onRun: go('/settings') },

        // Quick actions
        { id: 'act-new-poi', group: '快捷操作', icon: 'mapPin', label: '新建 POI 采集', sub: '天地图 / 高德 / 百度 / OSM', onRun: go('/new?tab=poi') },
        { id: 'act-new-tile', group: '快捷操作', icon: 'download', label: '下载离线瓦片', sub: '按区域 + 缩放范围', onRun: go('/new?tab=tile') },
        { id: 'act-active-tasks', group: '快捷操作', icon: 'refresh', label: '查看进行中任务', sub: '运行中 / 暂停 / 等待', onRun: go('/new?sub=active') },
        { id: 'act-history', group: '快捷操作', icon: 'archive', label: '任务历史', sub: '已完成 / 失败 / 取消', onRun: go('/new?sub=history') },
        { id: 'act-export', group: '快捷操作', icon: 'externalLink', label: '导出数据', sub: 'CSV / JSON / MySQL', onRun: go('/data?tab=export') },
        { id: 'act-cleanup', group: '快捷操作', icon: 'trash', label: '数据库整理', sub: '清理 / 去重 / 异常检测', onRun: go('/data?tab=cleanup') },

        // Theme
        {
            id: 'theme-toggle', group: '外观', icon: resolvedTheme === 'dark' ? 'sun' : 'moon',
            label: resolvedTheme === 'dark' ? '切换到浅色主题' : '切换到深色主题',
            keywords: ['theme', 'dark', 'light'], kbd: '⌘⇧L', onRun: () => { toggleTheme(); onClose() }
        },
        { id: 'theme-light', group: '外观', icon: 'sun', label: '浅色主题', onRun: () => { setTheme('light'); onClose() } },
        { id: 'theme-dark', group: '外观', icon: 'moon', label: '深色主题', onRun: () => { setTheme('dark'); onClose() } },
        { id: 'theme-system', group: '外观', icon: 'globe', label: '跟随系统主题', onRun: () => { setTheme('system'); onClose() } },
        { id: 'accent-blue', group: '外观', icon: 'sparkle', label: '强调色 · 蓝', onRun: () => { setAccent('blue'); onClose() } },
        { id: 'accent-green', group: '外观', icon: 'sparkle', label: '强调色 · 绿', onRun: () => { setAccent('green'); onClose() } },
        { id: 'accent-purple', group: '外观', icon: 'sparkle', label: '强调色 · 紫', onRun: () => { setAccent('purple'); onClose() } },
        { id: 'accent-orange', group: '外观', icon: 'sparkle', label: '强调色 · 橙', onRun: () => { setAccent('orange'); onClose() } },
        { id: 'density-compact', group: '外观', icon: 'list', label: '密度 · 紧凑', onRun: () => { setDensity('compact'); onClose() } },
        { id: 'density-standard', group: '外观', icon: 'list', label: '密度 · 标准', onRun: () => { setDensity('standard'); onClose() } },
        { id: 'density-comfy', group: '外观', icon: 'list', label: '密度 · 舒适', onRun: () => { setDensity('comfy'); onClose() } },
    ], [resolvedTheme, toggleTheme, setTheme, setAccent, setDensity, navigate, onClose])

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase()
        if (!q) return items
        return items.filter(it => {
            const hay = [it.label, it.sub, it.group, ...(it.keywords ?? [])]
                .filter(Boolean)
                .join(' ')
                .toLowerCase()
            return hay.includes(q)
        })
    }, [items, query])

    const grouped = useMemo(() => {
        const map = new Map<string, CommandItem[]>()
        for (const it of filtered) {
            const arr = map.get(it.group) ?? []
            arr.push(it)
            map.set(it.group, arr)
        }
        return Array.from(map.entries())
    }, [filtered])

    useEffect(() => {
        if (open) {
            setQuery('')
            setActive(0)
            setTimeout(() => inputRef.current?.focus(), 30)
        }
    }, [open])

    useEffect(() => { setActive(0) }, [query])

    useEffect(() => {
        if (!open) return
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
                return
            }
            if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive(a => Math.min(filtered.length - 1, a + 1))
            } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive(a => Math.max(0, a - 1))
            } else if (e.key === 'Enter') {
                e.preventDefault()
                filtered[active]?.onRun()
            }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [open, filtered, active, onClose])

    useEffect(() => {
        if (!listRef.current) return
        const row = listRef.current.querySelector(`[data-row-idx="${active}"]`) as HTMLElement | null
        row?.scrollIntoView({ block: 'nearest' })
    }, [active])

    if (!open) return null

    let idx = -1
    return (
        <div className="cmdk-backdrop" onClick={onClose} role="presentation">
            <div className="cmdk-panel" onClick={e => e.stopPropagation()}>
                <div className="cmdk-input-wrap">
                    <GcIcon name="search" size={16} />
                    <input
                        ref={inputRef}
                        className="cmdk-input"
                        placeholder="搜索功能、模块、外观切换..."
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                    />
                    <kbd>ESC</kbd>
                </div>
                <div className="cmdk-list" ref={listRef}>
                    {filtered.length === 0 && (
                        <div className="cmdk-empty">
                            <GcIcon name="inbox" size={28} />
                            <span>没有匹配的命令</span>
                        </div>
                    )}
                    {grouped.map(([group, gItems]) => (
                        <div key={group}>
                            <div className="cmdk-group-label">{group}</div>
                            {gItems.map(it => {
                                idx++
                                const isActive = idx === active
                                const myIdx = idx
                                return (
                                    <div
                                        key={it.id}
                                        data-row-idx={myIdx}
                                        className={`cmdk-row${isActive ? ' active' : ''}`}
                                        onMouseEnter={() => setActive(myIdx)}
                                        onClick={() => it.onRun()}
                                    >
                                        <div className="cmdk-icon"><GcIcon name={it.icon} size={13} /></div>
                                        <div className="cmdk-main">
                                            <div className="cmdk-label">{it.label}</div>
                                            {it.sub && <div className="cmdk-sub">{it.sub}</div>}
                                        </div>
                                        {it.kbd && <kbd className="cmdk-kbd">{it.kbd}</kbd>}
                                        {isActive && <span className="cmdk-enter">⏎</span>}
                                    </div>
                                )
                            })}
                        </div>
                    ))}
                </div>
                <div className="cmdk-foot">
                    <span><kbd>↑</kbd><kbd>↓</kbd>选择</span>
                    <span><kbd>⏎</kbd>执行</span>
                    <span><kbd>ESC</kbd>关闭</span>
                </div>
            </div>
        </div>
    )
}
