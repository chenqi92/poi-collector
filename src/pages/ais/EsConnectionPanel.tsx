// ES 连接管理 + 字段映射编辑器。
// 测试连接会采样文档并回传字段路径，驱动映射输入框的 datalist 自动补全。

import { useEffect, useId, useMemo, useState } from 'react'
import { GcIcon } from '@/components/shell'
import {
    aisDeleteConnection,
    aisListIndices,
    aisSaveConnection,
    aisTestConnection,
} from '@/lib/ais/api'
import {
    type DataMode,
    type EsConnection,
    type EsTestResult,
    type FieldMapping,
    type IndexInfo,
    type TimestampFormat,
    emptyConnection,
    emptyMapping,
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
    const listId = useId()
    const indexListId = useId()

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
    const fieldPaths = testResult?.fieldPaths ?? []

    const update = (patch: Partial<EsConnection>) => setDraft((d) => ({ ...d, ...patch }))
    const updateMapping = (patch: Partial<FieldMapping>) =>
        setDraft((d) => ({ ...d, fieldMapping: { ...d.fieldMapping, ...patch } }))

    const validationError = useMemo(() => {
        if (!draft.host.trim()) return '请填写主机'
        if (!draft.index.trim()) return '请填写索引名'
        const m = draft.fieldMapping
        if (draft.dataMode === 'raw') {
            if (!m.message.trim()) return '请映射原始报文字段'
            if (!m.timestamp.trim()) return '请映射时间字段'
            return ''
        }
        if (!m.mmsi.trim() && !m.aggField.trim()) return '请映射 MMSI 字段'
        if (!m.timestamp.trim()) return '请映射时间字段'
        if (!m.geoPoint.trim() && (!m.lat.trim() || !m.lon.trim()))
            return '请映射经纬度（geoPoint 或 lat+lon）'
        return ''
    }, [draft])

    const runTest = async (target: EsConnection) => {
        setTesting(true)
        setErr('')
        try {
            const r = await aisTestConnection(target)
            setTestResult(r)
            // 首次采样到文档且映射还是空的，自动识别一把
            const det = autoDetect(r.sample)
            if (det && mappingIsEmpty(target.fieldMapping)) {
                setDraft((d) => ({ ...d, dataMode: det.dataMode, fieldMapping: det.fieldMapping }))
            }
            try {
                setIndices(await aisListIndices(target))
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

    const doTest = () => runTest(draft)

    // 点选索引：填入并立即重测以采样字段
    const pickIndex = (name: string) => {
        const next = { ...draft, index: name }
        setDraft(next)
        runTest(next)
    }

    const doAutoDetect = () => {
        if (!testResult?.sample) {
            setErr('请先「测试连接」采样文档')
            return
        }
        const det = autoDetect(testResult.sample)
        if (det) {
            setDraft((d) => ({ ...d, dataMode: det.dataMode, fieldMapping: det.fieldMapping }))
            setErr('')
        } else {
            setErr('未能自动识别字段，请手动映射')
        }
    }

    const doSave = async () => {
        if (validationError) {
            setErr(validationError)
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
                            {c.scheme}://{c.host}:{c.port} / {c.index || '—'}
                        </div>
                    </button>
                ))}
            </div>

            {/* 编辑器 */}
            <div className="ais-conn-editor">
                <div className="ais-section-title">{isNew ? '新建连接' : '编辑连接'}</div>

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
                        <span>索引<i className="req">*</i></span>
                        <input
                            list={indexListId}
                            value={draft.index}
                            onChange={(e) => update({ index: e.target.value })}
                            placeholder="点测试连接后从下方选，或手填 ais-*"
                        />
                        <datalist id={indexListId}>
                            {indices.map((i) => (
                                <option key={i.name} value={i.name} />
                            ))}
                        </datalist>
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
                    <button
                        type="button"
                        className="btn"
                        onClick={doAutoDetect}
                        disabled={!testResult?.sample}
                        title="根据采样文档自动识别数据模式与字段"
                    >
                        <GcIcon name="sparkle" size={13} /> 自动识别
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
                    <div className={`ais-test-result${testResult.fieldPaths.length ? ' ok' : ' warn'}`}>
                        <div>{testResult.message}</div>
                        {testResult.fieldPaths.length > 0 && (
                            <div className="ais-hint">采样到 {testResult.fieldPaths.length} 个字段，下方映射框可自动补全。</div>
                        )}
                    </div>
                )}

                {indices.length > 0 && (
                    <div className="ais-index-pick">
                        <div className="ais-hint">索引（点击填入并重新采样，共 {indices.length} 个）：</div>
                        <div className="ais-index-chips">
                            {indices.map((i) => (
                                <button
                                    key={i.name}
                                    type="button"
                                    className={`ais-index-chip${draft.index === i.name ? ' active' : ''}`}
                                    onClick={() => pickIndex(i.name)}
                                    title={typeof i.docsCount === 'number' ? `${i.docsCount} 条文档` : undefined}
                                >
                                    <span className="ais-index-chip-name">{i.name}</span>
                                    {typeof i.docsCount === 'number' && (
                                        <span className="ais-index-count">{i.docsCount}</span>
                                    )}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {/* 字段映射 */}
                <div className="ais-section-title">字段映射</div>
                <div className="seg ais-seg ais-mode-seg">
                    <button
                        type="button"
                        className={draft.dataMode === 'fields' ? 'active' : ''}
                        onClick={() => update({ dataMode: 'fields' })}
                    >
                        结构化字段
                    </button>
                    <button
                        type="button"
                        className={draft.dataMode === 'raw' ? 'active' : ''}
                        onClick={() => update({ dataMode: 'raw' })}
                    >
                        原始 AIVDM 报文
                    </button>
                </div>
                <div className="ais-hint" style={{ margin: '8px 0' }}>
                    {draft.dataMode === 'raw' ? (
                        <>
                            数据是原始 AIVDM 报文，后端会解码出 MMSI / 经纬度 / 航速等，只需指定
                            <code>报文字段</code>与<code>时间字段</code>。点「自动识别」可自动填好。
                        </>
                    ) : (
                        <>
                            把 ES 字段映射到统一 AIS 模型，支持点路径（如 <code>position.lat</code>）。先「测试连接 /
                            自动识别」更省事。
                        </>
                    )}
                </div>
                <datalist id={listId}>
                    {fieldPaths.map((p) => (
                        <option key={p} value={p} />
                    ))}
                </datalist>

                {draft.dataMode === 'raw' ? (
                    <div className="ais-form-grid">
                        <MapField label="原始报文字段 (AIVDM)" required value={draft.fieldMapping.message} listId={listId} placeholder="如 message" onChange={(v) => updateMapping({ message: v })} />
                        <MapField label="时间戳" required value={draft.fieldMapping.timestamp} listId={listId} placeholder="如 createDateTime" onChange={(v) => updateMapping({ timestamp: v })} />
                        <label className="ais-mf">
                            <span>时间格式</span>
                            <select
                                value={draft.fieldMapping.timestampFormat}
                                onChange={(e) => updateMapping({ timestampFormat: e.target.value as TimestampFormat })}
                            >
                                <option value="epoch_ms">epoch 毫秒</option>
                                <option value="epoch_s">epoch 秒</option>
                                <option value="iso">ISO 8601 / date</option>
                            </select>
                        </label>
                        <label className="ais-mf full">
                            <span>停泊状态取值（逗号分隔，解码自报文）</span>
                            <input
                                value={draft.fieldMapping.navStatusAnchored.join(',')}
                                placeholder="默认 1,5（at anchor / moored）"
                                onChange={(e) =>
                                    updateMapping({
                                        navStatusAnchored: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                                    })
                                }
                            />
                        </label>
                    </div>
                ) : (
                    <div className="ais-form-grid">
                        <MapField label="MMSI / 船号" required value={draft.fieldMapping.mmsi} listId={listId} onChange={(v) => updateMapping({ mmsi: v })} />
                        <MapField label="聚合字段 (keyword)" value={draft.fieldMapping.aggField} listId={listId} placeholder="如 mmsi.keyword" onChange={(v) => updateMapping({ aggField: v })} />
                        <MapField label="船名" value={draft.fieldMapping.name} listId={listId} onChange={(v) => updateMapping({ name: v })} />
                        <MapField label="geoPoint (可选)" value={draft.fieldMapping.geoPoint} listId={listId} placeholder="单字段，优先于 lat/lon" onChange={(v) => updateMapping({ geoPoint: v })} />
                        <MapField label="纬度 lat" value={draft.fieldMapping.lat} listId={listId} onChange={(v) => updateMapping({ lat: v })} />
                        <MapField label="经度 lon" value={draft.fieldMapping.lon} listId={listId} onChange={(v) => updateMapping({ lon: v })} />
                        <MapField label="时间戳" required value={draft.fieldMapping.timestamp} listId={listId} onChange={(v) => updateMapping({ timestamp: v })} />
                        <label className="ais-mf">
                            <span>时间格式</span>
                            <select
                                value={draft.fieldMapping.timestampFormat}
                                onChange={(e) => updateMapping({ timestampFormat: e.target.value as TimestampFormat })}
                            >
                                <option value="epoch_ms">epoch 毫秒</option>
                                <option value="epoch_s">epoch 秒</option>
                                <option value="iso">ISO 8601 / date</option>
                            </select>
                        </label>
                        <MapField label="对地速度 SOG (节)" value={draft.fieldMapping.sog} listId={listId} onChange={(v) => updateMapping({ sog: v })} />
                        <MapField label="对地航向 COG (度)" value={draft.fieldMapping.cog} listId={listId} onChange={(v) => updateMapping({ cog: v })} />
                        <MapField label="船首向 (度)" value={draft.fieldMapping.heading} listId={listId} onChange={(v) => updateMapping({ heading: v })} />
                        <MapField label="导航状态" value={draft.fieldMapping.navStatus} listId={listId} onChange={(v) => updateMapping({ navStatus: v })} />
                        <label className="ais-mf full">
                            <span>停泊状态取值（逗号分隔）</span>
                            <input
                                value={draft.fieldMapping.navStatusAnchored.join(',')}
                                placeholder="如 1,5（at anchor / moored）"
                                onChange={(e) =>
                                    updateMapping({
                                        navStatusAnchored: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                                    })
                                }
                            />
                        </label>
                    </div>
                )}
            </div>
        </div>
    )
}

function MapField({
    label,
    value,
    onChange,
    listId,
    placeholder,
    required,
}: {
    label: string
    value: string
    onChange: (v: string) => void
    listId: string
    placeholder?: string
    required?: boolean
}) {
    return (
        <label className="ais-mf">
            <span>
                {label}
                {required && <i className="req">*</i>}
            </span>
            <input list={listId} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        </label>
    )
}

// ── 自动识别：根据采样文档猜数据模式与字段 ──────────────────────────

type Leaf = { path: string; value: unknown }

function flattenLeaves(obj: Record<string, unknown>, prefix: string, out: Leaf[]) {
    for (const k of Object.keys(obj)) {
        const p = prefix ? `${prefix}.${k}` : k
        const v = obj[k]
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            flattenLeaves(v as Record<string, unknown>, p, out)
        } else {
            out.push({ path: p, value: v })
        }
    }
}

function detectTimestamp(leaves: Leaf[]): { path: string; fmt: TimestampFormat } | null {
    const pick = (cands: Leaf[]): { path: string; fmt: TimestampFormat } | null => {
        for (const l of cands) {
            if (typeof l.value === 'number') {
                const fmt: TimestampFormat = l.value > 1e12 ? 'epoch_ms' : l.value > 1e9 ? 'epoch_s' : 'epoch_ms'
                return { path: l.path, fmt }
            }
            if (typeof l.value === 'string' && /\d{4}.?\d{2}.?\d{2}/.test(l.value) && /[T:]/.test(l.value)) {
                return { path: l.path, fmt: 'iso' }
            }
        }
        return null
    }
    const named = leaves.filter((l) => /time|date|ts|epoch/i.test(l.path))
    return pick(named) ?? pick(leaves)
}

function mappingIsEmpty(m: FieldMapping): boolean {
    return !m.message.trim() && !m.mmsi.trim() && !m.lat.trim() && !m.geoPoint.trim()
}

function autoDetect(sample: unknown): { dataMode: DataMode; fieldMapping: FieldMapping } | null {
    if (!sample || typeof sample !== 'object') return null
    const leaves: Leaf[] = []
    flattenLeaves(sample as Record<string, unknown>, '', leaves)
    if (leaves.length === 0) return null
    const ts = detectTimestamp(leaves)

    // raw 模式：含 AIVDM 报文
    const msg = leaves.find((l) => typeof l.value === 'string' && l.value.includes('!AIV'))
    if (msg) {
        return {
            dataMode: 'raw',
            fieldMapping: {
                ...emptyMapping(),
                message: msg.path,
                timestamp: ts?.path ?? '',
                timestampFormat: ts?.fmt ?? 'epoch_ms',
                navStatusAnchored: ['1', '5'],
            },
        }
    }

    // 结构化模式
    const m = emptyMapping()
    if (ts) {
        m.timestamp = ts.path
        m.timestampFormat = ts.fmt
    }
    const num = (l: Leaf): number | null => {
        if (typeof l.value === 'number') return l.value
        if (typeof l.value === 'string' && l.value.trim() !== '' && !Number.isNaN(Number(l.value))) return Number(l.value)
        return null
    }
    const byName = (re: RegExp, valOk?: (n: number) => boolean): string => {
        for (const l of leaves) {
            if (!re.test(l.path)) continue
            if (valOk) {
                const n = num(l)
                if (n == null || !valOk(n)) continue
            }
            return l.path
        }
        return ''
    }
    m.lat = byName(/(^|[._])(lat|latitude)($|[._])/i, (n) => n >= -90 && n <= 90)
    m.lon = byName(/(^|[._])(lon|lng|long|longitude)($|[._])/i, (n) => n >= -180 && n <= 180)
    m.mmsi = byName(/mmsi|shipid|ship_id/i)
    if (m.mmsi) m.aggField = `${m.mmsi}.keyword`
    m.name = byName(/shipname|ship_name|vesselname|(^|[._])name($|[._])/i)
    m.sog = byName(/sog|speed/i)
    m.cog = byName(/cog|course/i)
    m.heading = byName(/heading|hdg/i)
    m.navStatus = byName(/nav.?status|status/i)
    return { dataMode: 'fields', fieldMapping: m }
}
