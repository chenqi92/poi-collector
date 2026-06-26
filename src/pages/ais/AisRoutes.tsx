// AIS 航迹模块：航迹浏览 / ES 连接 两个 tab，连接选择在两 tab 间共享。

import { useEffect, useState } from 'react'
import { GcIcon } from '@/components/shell'
import { aisListConnections } from '@/lib/ais/api'
import type { EsConnection } from '@/lib/ais/types'
import { AisMapView } from './AisMapView'
import { EsConnectionPanel } from './EsConnectionPanel'

type TabKey = 'map' | 'conn'

export default function AisRoutes() {
    const [tab, setTab] = useState<TabKey>('map')
    const [connections, setConnections] = useState<EsConnection[]>([])
    const [connId, setConnId] = useState('')

    const reload = async () => {
        try {
            const list = await aisListConnections()
            setConnections(list)
            setConnId((prev) => (prev && list.find((c) => c.id === prev) ? prev : list[0]?.id ?? ''))
        } catch {
            /* ignore */
        }
    }

    useEffect(() => {
        reload()
    }, [])

    const conn = connections.find((c) => c.id === connId) ?? null

    return (
        <div className="page">
            <div className="page-header">
                <div>
                    <h1 className="page-title">AIS 航迹</h1>
                    <div className="page-subtitle">
                        连接 Elasticsearch，按船渲染航迹，区分行驶 / 停泊并按水域过滤异常点
                    </div>
                </div>
                <div className="page-header-actions">
                    <div className="seg">
                        <button type="button" className={tab === 'map' ? 'active' : ''} onClick={() => setTab('map')}>
                            <GcIcon name="route" size={11} style={{ marginRight: 4, verticalAlign: '-1px' }} />
                            航迹浏览
                        </button>
                        <button type="button" className={tab === 'conn' ? 'active' : ''} onClick={() => setTab('conn')}>
                            <GcIcon name="database" size={11} style={{ marginRight: 4, verticalAlign: '-1px' }} />
                            ES 连接
                        </button>
                    </div>
                </div>
            </div>

            {tab === 'map' ? (
                <AisMapView
                    conn={conn}
                    connections={connections}
                    connId={connId}
                    onConnId={setConnId}
                    onGoConnections={() => setTab('conn')}
                />
            ) : (
                <EsConnectionPanel
                    connections={connections}
                    selectedId={connId}
                    onSelect={setConnId}
                    onChanged={reload}
                />
            )}
        </div>
    )
}
