// ES 连接管理：只配置端点（协议/主机/端口/鉴权/TLS/源坐标系）。
// 索引选择与字段映射移到「航迹浏览」页，连接后再选。

import { useEffect, useState } from 'react'
import { GcIcon } from '@/components/shell'
import {
    aisDeleteConnection,
    aisListIndices,
    aisSaveConnection,
    aisTestConnection,
} from '@/lib/ais/api'
import {
    type EsConnection,
    type EsTestResult,
    type IndexInfo,
    emptyConnection,
} from '@/lib/ais/types'

interface Props {
    connections: EsConnection[]
    selectedId: string
    onSelect: (id: string) => void
    onChanged: () => void | Promise<void>
}

export function EsConnectionPanel({ connections, selectedId, onSelect, onChanged }: Props) {
    const [draft, setDraft] = useState<EsConnection>(() => {
        const found = connections.find((c) => c.id === selectedId)
        return found ? structuredClone(found) : emptyConnection()
    })
    const [testing, setTesting] = useState(false)
    const [testResult, setTestResult] = useState<EsTestResult | null>(null)
    const [indices, setIndices] = useState<IndexInfo[]>([])
    const [busy, setBusy] = useState(false)
    const [err, setErr] = useState('')

    // 选中变化时载入草稿
    useEffect(() => {
        const found = connections.find((c) => c.id === selectedId)
        if (found) {
            setDraft(structuredClone(found))
            setTestResult(null)
            setIndices([])
            setErr('')
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedId])

    const isNew = !draft.id
    const update = (patch: Partial<EsConnection>) => setDraft((d) => ({ ...d, ...patch }))

    const doTest = async () => {
        if (!draft.host.trim()) {
            setErr('请填写主机')
            return
        }
        setTesting(true)
        setErr('')
        try {
            const r = await aisTestConnection(draft)
            setTestResult(r)
            try {
                setIndices(await aisListIndices(draft))
            } catch {
                setIndices([])
            }
        } catch (e) {
            setErr(String(e))
            setTestResult(null)
            setIndices([])
        } finally {
            setTesting(false)
        }
    }

    const doSave = async () => {
        if (!draft.host.trim()) {
            setErr('请填写主机')
            return
        }
        setBusy(true)
        setErr('')
        try {
            const saved = await aisSaveConnection(draft)
            setDraft(structuredClone(saved))
            await onChanged()
            onSelect(saved.id)
        } catch (e) {
            setErr(String(e))
        } finally {
            setBusy(false)
        }
    }

    const doDelete = async () => {
        if (isNew) return
        setBusy(true)
        try {
            await aisDeleteConnection(draft.id)
            await onChanged()
            setDraft(emptyConnection())
            setTestResult(null)
            setIndices([])
        } catch (e) {
            setErr(String(e))
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="ais-conn-layout page-scroll">
            {/* 连接列表 */}
            <div className="ais-conn-list">
                <button
                    type="button"
                    className="btn ais-conn-new"
                    onClick={() => {
                        setDraft(emptyConnection())
                        setTestResult(null)
                        setIndices([])
                        setErr('')
                    }}
                >
                    <GcIcon name="plus" size={13} /> 新建连接
                </button>
                {connections.map((c) => (
                    <button
                        key={c.id}
                        type="button"
                        className={`ais-conn-card${c.id === draft.id ? ' active' : ''}`}
                        onClick={() => onSelect(c.id)}
                    >
                        <div className="ais-conn-name">{c.name || `${c.host}:${c.port}`}</div>
                        <div className="ais-conn-sub">
                            {c.scheme}://{c.host}:{c.port}
                        </div>
                    </button>
                ))}
            </div>

            {/* 编辑器 */}
            <div className="ais-conn-editor">
                <div className="ais-section-title">{isNew ? '新建连接' : '编辑连接'}</div>
                <div className="ais-hint" style={{ margin: '0 0 10px' }}>
                    连接只填 ES 端点。索引选择与字段映射在「航迹浏览」页连接后再做（支持多索引同查、自动识别映射）。
                </div>

                <div className="ais-form-grid">
                    <label className="ais-mf full">
                        <span>名称</span>
                        <input value={draft.name} onChange={(e) => update({ name: e.target.value })} placeholder="可选，留空用 host:port" />
                    </label>
                    <label className="ais-mf">
                        <span>协议</span>
                        <select value={draft.scheme} onChange={(e) => update({ scheme: e.target.value as EsConnection['scheme'] })}>
                            <option value="http">http</option>
                            <option value="https">https</option>
                        </select>
                    </label>
                    <label className="ais-mf">
                        <span>主机<i className="req">*</i></span>
                        <input value={draft.host} onChange={(e) => update({ host: e.target.value })} placeholder="127.0.0.1" />
                    </label>
                    <label className="ais-mf">
                        <span>端口</span>
                        <input
                            type="number"
                            value={draft.port}
                            onChange={(e) => update({ port: parseInt(e.target.value, 10) || 9200 })}
                        />
                    </label>
                    <label className="ais-mf">
                        <span>鉴权</span>
                        <select value={draft.authType} onChange={(e) => update({ authType: e.target.value as EsConnection['authType'] })}>
                            <option value="none">无</option>
                            <option value="basic">Basic</option>
                            <option value="apikey">API Key</option>
                        </select>
                    </label>
                    <label className="ais-mf">
                        <span>源坐标系</span>
                        <select value={draft.sourceCrs} onChange={(e) => update({ sourceCrs: e.target.value as EsConnection['sourceCrs'] })}>
                            <option value="wgs84">WGS-84</option>
                            <option value="gcj02">GCJ-02</option>
                            <option value="bd09">BD-09</option>
                        </select>
                    </label>
                    {draft.authType === 'basic' && (
                        <>
                            <label className="ais-mf">
                                <span>用户名</span>
                                <input value={draft.username} onChange={(e) => update({ username: e.target.value })} />
                            </label>
                            <label className="ais-mf">
                                <span>密码</span>
                                <input type="password" value={draft.password} onChange={(e) => update({ password: e.target.value })} />
                            </label>
                        </>
                    )}
                    {draft.authType === 'apikey' && (
                        <label className="ais-mf full">
                            <span>API Key</span>
                            <input value={draft.apiKey} onChange={(e) => update({ apiKey: e.target.value })} placeholder="base64(id:api_key)" />
                        </label>
                    )}
                    {draft.scheme === 'https' && (
                        <label className="ais-mf full ais-check">
                            <input
                                type="checkbox"
                                checked={draft.acceptInvalidCerts}
                                onChange={(e) => update({ acceptInvalidCerts: e.target.checked })}
                            />
                            <span>允许自签名 / 无效证书</span>
                        </label>
                    )}
                </div>

                <div className="ais-form-actions">
                    <button type="button" className="btn" onClick={doTest} disabled={testing}>
                        <GcIcon name="zap" size={13} /> {testing ? '测试中…' : '测试连接'}
                    </button>
                    <button type="button" className="btn primary" onClick={doSave} disabled={busy}>
                        <GcIcon name="check" size={13} /> 保存
                    </button>
                    {!isNew && (
                        <button type="button" className="btn danger" onClick={doDelete} disabled={busy}>
                            <GcIcon name="trash" size={13} /> 删除
                        </button>
                    )}
                </div>

                {err && <div className="ais-hint err">{err}</div>}
                {testResult && (
                    <div className="ais-test-result ok">
                        <div>{testResult.message}</div>
                        {indices.length > 0 && (
                            <div className="ais-hint">发现 {indices.length} 个索引，到「航迹浏览」页勾选要查的索引。</div>
                        )}
                    </div>
                )}
            </div>
        </div>
    )
}
