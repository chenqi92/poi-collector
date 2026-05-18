import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { GcIcon } from '@/components/shell'
import { BrowseView } from './data-hub/BrowseView'
import { ExportView } from './data-hub/ExportView'
import { CleanupView } from './data-hub/CleanupView'

type TabKey = 'browse' | 'export' | 'cleanup'

const TABS: { key: TabKey; icon: string; label: string; subtitle: string }[] = [
    { key: 'browse', icon: 'search', label: '浏览查询', subtitle: '在地图与列表中查询已采集的 POI 与航标' },
    { key: 'export', icon: 'download', label: '导出', subtitle: '按地区 / 字段 / 格式 导出数据到磁盘' },
    { key: 'cleanup', icon: 'database', label: '整理', subtitle: '按地区清理 · 去重 · 异常检测 · 导入' },
]

export default function DataHub() {
    const [params, setParams] = useSearchParams()
    const initial = ((): TabKey => {
        const t = params.get('tab')
        if (t === 'export' || t === 'browse' || t === 'cleanup') return t
        if (t === 'manage') return 'cleanup'
        return 'browse'
    })()
    const [tab, setTab] = useState<TabKey>(initial)

    useEffect(() => {
        const q = params.get('tab')
        const mapped: TabKey | null = q === 'browse' || q === 'export' || q === 'cleanup'
            ? q
            : q === 'manage' ? 'cleanup' : null
        if (mapped && mapped !== tab) setTab(mapped)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [params])

    const onSwitch = (k: TabKey) => {
        setTab(k)
        const next = new URLSearchParams(params)
        next.set('tab', k)
        setParams(next, { replace: true })
    }

    const meta = TABS.find(t => t.key === tab)!

    return (
        <div className="page">
            <div className="page-header">
                <div>
                    <h1 className="page-title">数据中心</h1>
                    <div className="page-subtitle">{meta.subtitle}</div>
                </div>
                <div className="page-header-actions">
                    <div className="seg">
                        {TABS.map(t => (
                            <button
                                key={t.key}
                                type="button"
                                className={tab === t.key ? 'active' : ''}
                                onClick={() => onSwitch(t.key)}
                            >
                                <GcIcon
                                    name={t.icon}
                                    size={11}
                                    style={{ marginRight: 4, verticalAlign: '-1px' }}
                                />
                                {t.label}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {tab === 'browse' && <BrowseView />}
            {tab === 'export' && <ExportView />}
            {tab === 'cleanup' && <CleanupView />}
        </div>
    )
}
