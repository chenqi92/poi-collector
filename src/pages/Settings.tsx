import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { openUrl } from '@tauri-apps/plugin-opener'
import { GcIcon, PlatformBadge } from '@/components/shell'
import { useTheme } from '@/components/theme-provider'
import { useToast } from '@/components/ui/toast'
import { refreshTiandituKey } from '@/lib/baseMaps'
import { APP_VERSION } from '@/lib/version'
import type { PlatformKey } from '@/lib/shellData'

interface ApiKey {
    id: number
    name?: string | null
    api_key: string
    is_active?: boolean
    quota_exhausted?: boolean
}

interface Province {
    code: string
    name: string
    level: string
    parent_code: string | null
}

const PLATFORMS: { id: PlatformKey; label: string; hint: string; docUrl: string; cap: number; unlimited?: boolean }[] = [
    {
        id: 'tianditu',
        label: '天地图',
        hint: '国家测绘地理信息局',
        docUrl: 'https://console.tianditu.gov.cn/api/key',
        cap: 100000,
    },
    {
        id: 'amap',
        label: '高德地图',
        hint: 'console.amap.com',
        docUrl: 'https://console.amap.com/dev/key/app',
        cap: 100000,
    },
    {
        id: 'baidu',
        label: '百度地图',
        hint: 'lbsyun.baidu.com',
        docUrl: 'https://lbsyun.baidu.com/apiconsole/key',
        cap: 50000,
    },
    {
        id: 'osm',
        label: 'OpenStreetMap',
        hint: '社区维护，无需 Key',
        docUrl: 'https://www.openstreetmap.org',
        cap: 0,
        unlimited: true,
    },
]

type TabId = 'keys' | 'regions' | 'prefs' | 'appear' | 'about'

const NAV: { id: TabId; label: string; icon: string }[] = [
    { id: 'keys', label: 'API Keys', icon: 'key' },
    { id: 'regions', label: '地区库', icon: 'globe' },
    { id: 'prefs', label: '通用偏好', icon: 'settings' },
    { id: 'appear', label: '外观', icon: 'sparkle' },
    { id: 'about', label: '关于', icon: 'inbox' },
]

// ──────── Keys panel ──────────────────────────────────────
function maskKey(k: string) {
    if (!k) return ''
    if (k.length <= 8) return '***'
    return `${k.slice(0, 4)}${'•'.repeat(Math.min(28, k.length - 8))}${k.slice(-4)}`
}

function KeysPanel() {
    const [keys, setKeys] = useState<Record<string, ApiKey[]>>({})
    const [adding, setAdding] = useState<string | null>(null)
    const [newKey, setNewKey] = useState<Record<string, { name: string; key: string }>>({})
    const { success, error: errorToast } = useToast()

    const load = async () => {
        try {
            const data = await invoke<Record<string, ApiKey[]>>('get_api_keys')
            setKeys(data)
        } catch (e) {
            errorToast('加载 Key 失败', String(e))
        }
    }

    useEffect(() => { load() }, [])

    const onAdd = async (platform: string) => {
        const v = newKey[platform]
        if (!v?.key) return
        try {
            await invoke('add_api_key', {
                platform,
                apiKey: v.key,
                name: v.name || undefined,
            })
            setNewKey(s => ({ ...s, [platform]: { name: '', key: '' } }))
            setAdding(null)
            success('Key 已添加', `${platform} · ${v.name || '未命名'}`)
            if (platform === 'tianditu') refreshTiandituKey()
            load()
        } catch (e) {
            errorToast('添加失败', String(e))
        }
    }

    const onDelete = async (platform: string, keyId: number) => {
        if (!confirm('确定要删除这个 API Key 吗？')) return
        try {
            await invoke('delete_api_key', { platform, keyId })
            if (platform === 'tianditu') refreshTiandituKey()
            success('已删除', '')
            load()
        } catch (e) {
            errorToast('删除失败', String(e))
        }
    }

    return (
        <div className="set-pad">
            <div className="set-section-head">
                <div>
                    <h3>API Keys</h3>
                    <div className="set-section-sub">
                        每个平台可配置多把 Key，任务运行时按可用性自动轮换。OpenStreetMap 不需要 Key。
                    </div>
                </div>
            </div>

            {PLATFORMS.filter(p => !p.unlimited).map(pf => {
                const list = keys[pf.id] ?? []
                const isAdding = adding === pf.id
                const form = newKey[pf.id] ?? { name: '', key: '' }
                return (
                    <div className="panel set-key-card" key={pf.id}>
                        <div className="panel-head">
                            <PlatformBadge name={pf.id} />
                            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginLeft: 4 }}>
                                {pf.label}
                            </span>
                            <span className="meta">{list.length} 把 Key · {pf.hint}</span>
                            <div className="panel-head-actions">
                                <button
                                    type="button"
                                    className="btn ghost sm"
                                    onClick={() => openUrl(pf.docUrl).catch(() => { })}
                                >
                                    <GcIcon name="externalLink" size={11} />申请新 Key
                                </button>
                                <button
                                    type="button"
                                    className="btn sm"
                                    onClick={() => setAdding(isAdding ? null : pf.id)}
                                >
                                    <GcIcon name="plus" size={11} />添加 Key
                                </button>
                            </div>
                        </div>

                        {isAdding && (
                            <div
                                style={{
                                    padding: '10px 14px',
                                    borderBottom: '1px solid var(--hairline)',
                                    background: 'var(--panel-2)',
                                    display: 'flex',
                                    gap: 6,
                                    alignItems: 'center',
                                }}
                            >
                                <input
                                    className="input"
                                    placeholder="名称（可选）"
                                    style={{ width: 160 }}
                                    value={form.name}
                                    onChange={e =>
                                        setNewKey(s => ({ ...s, [pf.id]: { ...form, name: e.target.value } }))
                                    }
                                />
                                <input
                                    className="input mono"
                                    placeholder="粘贴 API Key"
                                    style={{ flex: 1, fontSize: 11.5 }}
                                    value={form.key}
                                    onChange={e =>
                                        setNewKey(s => ({ ...s, [pf.id]: { ...form, key: e.target.value } }))
                                    }
                                />
                                <button type="button" className="btn ghost sm" onClick={() => setAdding(null)}>
                                    取消
                                </button>
                                <button
                                    type="button"
                                    className="btn primary sm"
                                    onClick={() => onAdd(pf.id)}
                                    disabled={!form.key}
                                >
                                    保存
                                </button>
                            </div>
                        )}

                        <div>
                            {list.length === 0 ? (
                                <div
                                    className="empty"
                                    style={{ padding: '24px 16px', color: 'var(--text-3)' }}
                                >
                                    <div className="empty-icon"><GcIcon name="key" size={20} /></div>
                                    <h4>还没有配置 Key</h4>
                                    <p>点击右上「添加 Key」录入第一把。</p>
                                </div>
                            ) : (
                                list.map(k => {
                                    const exhausted = k.quota_exhausted
                                    const ok = !exhausted && k.is_active !== false
                                    return (
                                        <div className="key-row" key={k.id}>
                                            <div className="key-status">
                                                <span className={`dot dot-${ok ? 'ok' : 'err'}`} />
                                            </div>
                                            <div className="key-main">
                                                <div className="key-name">
                                                    <b>{k.name || `Key #${k.id}`}</b>
                                                    <span className="key-mask mono">{maskKey(k.api_key)}</span>
                                                    <button
                                                        type="button"
                                                        className="iconbtn"
                                                        title="复制"
                                                        onClick={() => navigator.clipboard?.writeText(k.api_key).catch(() => { })}
                                                    >
                                                        <GcIcon name="copy" size={12} />
                                                    </button>
                                                </div>
                                                <div className="key-foot">
                                                    <span>
                                                        额度上限 <b className="mono">{(pf.cap / 1000).toFixed(0)}k/天</b>
                                                    </span>
                                                    <span className="sep">·</span>
                                                    <span style={{ color: ok ? 'var(--text-3)' : 'var(--st-amber)' }}>
                                                        {exhausted ? '已耗尽配额' : ok ? '可用' : '已停用'}
                                                    </span>
                                                </div>
                                            </div>
                                            <div className="key-actions">
                                                <button
                                                    type="button"
                                                    className="iconbtn"
                                                    title="删除"
                                                    onClick={() => onDelete(pf.id, k.id)}
                                                >
                                                    <GcIcon name="trash" size={13} />
                                                </button>
                                            </div>
                                        </div>
                                    )
                                })
                            )}
                        </div>
                    </div>
                )
            })}

            <div className="set-tip">
                <GcIcon name="alertTriangle" size={14} />
                <div>
                    <b>Key 健康度</b>多把 Key 时，任务运行中遇到配额耗尽会自动跳到下一把。OpenStreetMap 与长江航道图无需 Key。
                </div>
            </div>
        </div>
    )
}

// ──────── Regions panel ──────────────────────────────────
function RegionsPanel() {
    const [provinces, setProvinces] = useState<Province[]>([])
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        let cancelled = false
        invoke<Province[]>('get_provinces')
            .then(p => { if (!cancelled) { setProvinces(p); setLoading(false) } })
            .catch(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
    }, [])

    return (
        <div className="set-pad">
            <div className="set-section-head">
                <div>
                    <h3>地区库</h3>
                    <div className="set-section-sub">
                        采集和导出时可重用的省市区数据。当前内置 GB/T 2260 全国行政区划。
                    </div>
                </div>
            </div>

            <div className="panel">
                <div className="panel-head">
                    <h3>省级行政区</h3>
                    <span className="meta">{loading ? '加载中...' : `共 ${provinces.length} 个`}</span>
                </div>
                <div style={{ padding: '8px 10px', maxHeight: 360, overflow: 'auto' }}>
                    <div
                        style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
                            gap: 6,
                        }}
                    >
                        {provinces.map(p => (
                            <div
                                key={p.code}
                                className="set-nav-item"
                                style={{ margin: 0, height: 28 }}
                            >
                                <GcIcon name="globe" size={12} />
                                <span style={{ fontSize: 12 }}>{p.name}</span>
                                <span
                                    style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--text-4)' }}
                                    className="mono"
                                >
                                    {p.code}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

        </div>
    )
}

// ──────── Prefs panel ─────────────────────────────────────
interface Prefs {
    defaultDownloadPath: string
    defaultConcurrency: number
    notifyOnComplete: boolean
    soundOnComplete: boolean
    minimizeToTray: boolean
    autostart: boolean
    sendStats: boolean
}

const DEFAULT_PREFS: Prefs = {
    defaultDownloadPath: '',
    defaultConcurrency: 8,
    notifyOnComplete: true,
    soundOnComplete: false,
    minimizeToTray: true,
    autostart: false,
    sendStats: false,
}

function loadPrefs(): Prefs {
    try {
        return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem('poi-prefs') ?? '{}') }
    } catch {
        return DEFAULT_PREFS
    }
}

function savePrefs(p: Prefs) {
    localStorage.setItem('poi-prefs', JSON.stringify(p))
}

function SetToggle({
    label,
    sub,
    value,
    onChange,
}: { label: string; sub?: string; value: boolean; onChange: (v: boolean) => void }) {
    return (
        <div className="set-row">
            <div className="set-row-main">
                <div className="set-row-title">{label}</div>
                {sub && <div className="set-row-sub">{sub}</div>}
            </div>
            <div className="set-row-control">
                <button
                    type="button"
                    className="toggle"
                    data-on={value ? '1' : '0'}
                    onClick={() => onChange(!value)}
                >
                    <i />
                </button>
            </div>
        </div>
    )
}

function PrefsPanel() {
    const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs())
    const update = <K extends keyof Prefs>(k: K, v: Prefs[K]) => {
        const next = { ...prefs, [k]: v }
        setPrefs(next)
        savePrefs(next)
    }

    const pickDir = async () => {
        try {
            const picked = await openDialog({ multiple: false, directory: true })
            if (typeof picked === 'string') update('defaultDownloadPath', picked)
        } catch { /* cancelled */ }
    }

    return (
        <div className="set-pad">
            <div className="set-section-head">
                <div>
                    <h3>通用偏好</h3>
                    <div className="set-section-sub">应用启动行为、默认值、系统集成。所有设置实时保存。</div>
                </div>
            </div>

            <div className="panel">
                <div className="set-group">
                    <div className="set-row">
                        <div className="set-row-main">
                            <div className="set-row-title">默认下载路径</div>
                            <div className="set-row-sub">瓦片包、POI 导出文件的保存位置（每次任务可覆盖）</div>
                        </div>
                        <div className="set-row-control" style={{ width: 420 }}>
                            <input
                                className="input mono"
                                style={{ fontSize: 11.5 }}
                                placeholder="未设置 · 任务级单独选择"
                                value={prefs.defaultDownloadPath}
                                onChange={e => update('defaultDownloadPath', e.target.value)}
                            />
                            <button type="button" className="btn sm" onClick={pickDir}>
                                <GcIcon name="folder" size={11} />选择...
                            </button>
                        </div>
                    </div>

                    <div className="set-row">
                        <div className="set-row-main">
                            <div className="set-row-title">默认并发数</div>
                            <div className="set-row-sub">新任务的初始并发线程数（瓦片下载使用）</div>
                        </div>
                        <div className="set-row-control">
                            <select
                                className="select"
                                value={prefs.defaultConcurrency}
                                onChange={e => update('defaultConcurrency', Number(e.target.value))}
                                style={{ width: 100 }}
                            >
                                {[4, 6, 8, 12, 16, 24].map(n => (
                                    <option key={n} value={n}>{n}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                </div>

                <div className="set-divider" />

                <div className="set-group">
                    <div className="set-group-title">系统集成</div>
                    <SetToggle
                        label="任务完成后系统通知"
                        sub="使用 macOS / Windows 原生通知中心"
                        value={prefs.notifyOnComplete}
                        onChange={v => update('notifyOnComplete', v)}
                    />
                    <SetToggle
                        label="任务完成时播放提示音"
                        sub="播放系统提示音"
                        value={prefs.soundOnComplete}
                        onChange={v => update('soundOnComplete', v)}
                    />
                    <SetToggle
                        label="关闭窗口时最小化到系统托盘"
                        sub="任务继续后台运行（需托盘插件支持）"
                        value={prefs.minimizeToTray}
                        onChange={v => update('minimizeToTray', v)}
                    />
                    <SetToggle
                        label="开机自启动"
                        sub="登录系统后自动启动 GeoCollector（后台运行）"
                        value={prefs.autostart}
                        onChange={v => update('autostart', v)}
                    />
                </div>

                <div className="set-divider" />

                <div className="set-group">
                    <div className="set-group-title">数据与隐私</div>
                    <SetToggle
                        label="发送匿名使用统计"
                        sub="帮助改进产品。不包含 Key 或采集数据。"
                        value={prefs.sendStats}
                        onChange={v => update('sendStats', v)}
                    />
                    <div className="set-row danger">
                        <div className="set-row-main">
                            <div className="set-row-title" style={{ color: 'var(--st-red)' }}>清空所有本地数据</div>
                            <div className="set-row-sub">删除已采集的 POI、航标、瓦片包。此操作不可恢复。</div>
                        </div>
                        <div className="set-row-control">
                            <button
                                type="button"
                                className="btn danger sm"
                                onClick={async () => {
                                    if (!confirm('确定要清空所有 POI 数据吗？此操作不可恢复。')) return
                                    try {
                                        const n = await invoke<number>('clear_all_poi')
                                        alert(`已清空 ${n} 条 POI`)
                                    } catch (e) {
                                        alert(`失败: ${e}`)
                                    }
                                }}
                            >
                                清空 POI 数据
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}

// ──────── Appearance panel ────────────────────────────────
function ThemeCard({
    name,
    label,
    active,
    onClick,
}: { name: 'light' | 'dark' | 'auto'; label: string; active: boolean; onClick: () => void }) {
    return (
        <div className={`theme-card${active ? ' active' : ''}`} onClick={onClick}>
            <div className={`theme-preview theme-${name}`}>
                <span className="tp-side" />
                <span className="tp-body">
                    <span className="tp-bar" />
                    <span className="tp-line" />
                    <span className="tp-line short" />
                </span>
            </div>
            <span className="theme-card-label">{label}</span>
        </div>
    )
}

function AppearPanel() {
    const { theme, setTheme, accent, setAccent, density, setDensity } = useTheme()
    const ACCENT_COLORS: { id: 'blue' | 'green' | 'purple' | 'orange'; hex: string; label: string }[] = [
        { id: 'blue', hex: '#3b82f6', label: '蓝（默认）' },
        { id: 'green', hex: '#10b981', label: '绿' },
        { id: 'purple', hex: '#8b5cf6', label: '紫' },
        { id: 'orange', hex: '#f59e0b', label: '橙' },
    ]

    return (
        <div className="set-pad">
            <div className="set-section-head">
                <div>
                    <h3>外观</h3>
                    <div className="set-section-sub">主题、密度、强调色。所有设置实时生效。</div>
                </div>
            </div>

            <div className="panel">
                <div className="set-group">
                    <div className="set-row">
                        <div className="set-row-main">
                            <div className="set-row-title">主题</div>
                            <div className="set-row-sub">长时间使用建议深色，降低眼疲劳</div>
                        </div>
                        <div className="set-row-control">
                            <div className="theme-cards">
                                <ThemeCard
                                    name="light"
                                    label="浅色"
                                    active={theme === 'light'}
                                    onClick={() => setTheme('light')}
                                />
                                <ThemeCard
                                    name="dark"
                                    label="深色"
                                    active={theme === 'dark'}
                                    onClick={() => setTheme('dark')}
                                />
                                <ThemeCard
                                    name="auto"
                                    label="跟随系统"
                                    active={theme === 'system'}
                                    onClick={() => setTheme('system')}
                                />
                            </div>
                        </div>
                    </div>

                    <div className="set-row">
                        <div className="set-row-main">
                            <div className="set-row-title">强调色</div>
                            <div className="set-row-sub">用于按钮、链接、激活态</div>
                        </div>
                        <div className="set-row-control" style={{ display: 'flex', gap: 8 }}>
                            {ACCENT_COLORS.map(c => (
                                <div
                                    key={c.id}
                                    className={`accent-swatch${accent === c.id ? ' active' : ''}`}
                                    onClick={() => setAccent(c.id)}
                                >
                                    <span style={{ background: c.hex }} />
                                    <span style={{ fontSize: 11 }}>{c.label}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="set-row">
                        <div className="set-row-main">
                            <div className="set-row-title">数据密度</div>
                            <div className="set-row-sub">影响行高、间距、字号</div>
                        </div>
                        <div className="set-row-control">
                            <div className="seg">
                                <button
                                    type="button"
                                    className={density === 'compact' ? 'active' : ''}
                                    onClick={() => setDensity('compact')}
                                >
                                    紧凑
                                </button>
                                <button
                                    type="button"
                                    className={density === 'standard' ? 'active' : ''}
                                    onClick={() => setDensity('standard')}
                                >
                                    标准
                                </button>
                                <button
                                    type="button"
                                    className={density === 'comfy' ? 'active' : ''}
                                    onClick={() => setDensity('comfy')}
                                >
                                    舒适
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}

// ──────── About panel ──────────────────────────────────────
function AboutLink({
    icon,
    label,
    sub,
    onClick,
}: { icon: string; label: string; sub: string; onClick?: () => void }) {
    return (
        <div
            className="set-nav-item"
            style={{ margin: '1px 6px', height: 36 }}
            onClick={onClick}
        >
            <GcIcon name={icon} size={14} />
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, color: 'var(--text)' }}>{label}</div>
                <div style={{ fontSize: 10.5, color: 'var(--text-3)' }} className="mono">{sub}</div>
            </div>
            <GcIcon name="chevronRight" size={11} style={{ color: 'var(--text-4)' }} />
        </div>
    )
}

function AboutPanel() {
    return (
        <div className="set-pad">
            <div className="about-hero panel">
                <div className="brand-mark" style={{ width: 56, height: 56, borderRadius: 14 }} />
                <div style={{ flex: 1 }}>
                    <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>GeoCollector</h2>
                    <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
                        桌面端 POI / 航标 数据采集 · 离线瓦片下载 · 数据浏览与导出
                    </div>
                    <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
                        <span className="tag mono" style={{ fontSize: 11 }}>v{APP_VERSION}</span>
                        <span className="tag" style={{ color: 'var(--st-green)' }}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />
                            本地构建
                        </span>
                    </div>
                </div>
            </div>

            <div style={{ marginTop: 14 }}>
                <div className="panel">
                    <div className="panel-head"><h3>资源</h3></div>
                    <div style={{ padding: '6px 4px' }}>
                        <AboutLink
                            icon="externalLink"
                            label="天地图开发者控制台"
                            sub="console.tianditu.gov.cn"
                            onClick={() => openUrl('https://console.tianditu.gov.cn').catch(() => { })}
                        />
                        <AboutLink
                            icon="externalLink"
                            label="高德开发者控制台"
                            sub="console.amap.com"
                            onClick={() => openUrl('https://console.amap.com').catch(() => { })}
                        />
                        <AboutLink
                            icon="externalLink"
                            label="百度开发者控制台"
                            sub="lbsyun.baidu.com"
                            onClick={() => openUrl('https://lbsyun.baidu.com').catch(() => { })}
                        />
                    </div>
                </div>
            </div>

            <div style={{ marginTop: 24, color: 'var(--text-4)', fontSize: 11, textAlign: 'center' }}>
                Built with Rust + Tauri 2 · React 19 · Leaflet
            </div>
        </div>
    )
}

// ──────── Page wrapper ─────────────────────────────────────
export default function Settings() {
    const [params, setParams] = useSearchParams()
    const initial = (params.get('tab') as TabId) || 'keys'
    const [tab, setTab] = useState<TabId>(initial)

    useEffect(() => {
        const q = params.get('tab') as TabId | null
        if (q && q !== tab) setTab(q)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [params])

    const onSwitch = (k: TabId) => {
        setTab(k)
        const next = new URLSearchParams(params)
        next.set('tab', k)
        setParams(next, { replace: true })
    }

    const meta = useMemo(() => NAV.find(n => n.id === tab) ?? NAV[0], [tab])

    return (
        <div className="page settings-page">
            <div className="page-header">
                <div>
                    <h1 className="page-title">设置</h1>
                    <div className="page-subtitle">{meta.label} · 实时保存到本地</div>
                </div>
            </div>

            <div className="set-layout">
                <div className="set-nav">
                    {NAV.map(n => (
                        <div
                            key={n.id}
                            className={`set-nav-item${tab === n.id ? ' active' : ''}`}
                            onClick={() => onSwitch(n.id)}
                        >
                            <GcIcon name={n.icon} size={14} />
                            <span>{n.label}</span>
                        </div>
                    ))}
                </div>
                <div className="set-content page-scroll">
                    {tab === 'keys' && <KeysPanel />}
                    {tab === 'regions' && <RegionsPanel />}
                    {tab === 'prefs' && <PrefsPanel />}
                    {tab === 'appear' && <AppearPanel />}
                    {tab === 'about' && <AboutPanel />}
                </div>
            </div>
        </div>
    )
}
