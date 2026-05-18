import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { invoke } from '@tauri-apps/api/core'
import { save, open as openDialog } from '@tauri-apps/plugin-dialog'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { MapContainer, TileLayer, Rectangle, useMap } from 'react-leaflet'
import L from 'leaflet'
import { GcIcon, PlatformBadge } from '@/components/shell'
import { useToast } from '@/components/ui/toast'
import 'leaflet/dist/leaflet.css'

interface Bounds {
    north: number
    south: number
    east: number
    west: number
}

interface TileTask {
    id: string
    name: string
    platform: string
    map_type: string
    bounds: Bounds
    zoom_levels: number[]
    status: string
    total_tiles: number
    completed_tiles: number
    failed_tiles: number
    output_path: string
    output_format: string
    created_at: string
    updated_at: string
    completed_at: string | null
}

interface Pkg {
    id: string
    name: string
    platform: string
    mapType: string
    zoom: [number, number]
    bounds: Bounds
    tiles: number
    created: string
    outputPath: string
    outputFormat: string
}

const PLATFORM_THUMB_HUE: Record<string, number> = {
    tianditu: 224,
    amap: 35,
    baidu: 0,
    osm: 145,
    cjhy: 200,
}

function pickPlatformKey(p: string) {
    const k = p.toLowerCase()
    if (k.includes('tianditu')) return 'tianditu'
    if (k.includes('amap') || k.includes('gaode')) return 'amap'
    if (k.includes('baidu')) return 'baidu'
    if (k.includes('osm') || k.includes('openstreet')) return 'osm'
    return p
}

function taskToPkg(t: TileTask): Pkg {
    const zs = t.zoom_levels.length > 0 ? [...t.zoom_levels].sort((a, b) => a - b) : [0, 0]
    return {
        id: t.id,
        name: t.name,
        platform: pickPlatformKey(t.platform),
        mapType: t.map_type,
        zoom: [zs[0], zs[zs.length - 1]] as [number, number],
        bounds: t.bounds,
        tiles: t.completed_tiles || t.total_tiles,
        created: t.completed_at ?? t.updated_at ?? t.created_at ?? '',
        outputPath: t.output_path,
        outputFormat: t.output_format,
    }
}

// ──────── Thumbnail (SVG) ─────────────────────────────────
function PkgThumb({ pkg }: { pkg: Pkg }) {
    const hue = PLATFORM_THUMB_HUE[pkg.platform] ?? 224
    const seed = useMemo(
        () => pkg.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0),
        [pkg.id]
    )
    const ox = seed % 30
    const oy = (seed * 7) % 15
    const ow = 20 + (seed % 15)
    const oh = 15 + (seed % 10)
    const tilesLabel = pkg.tiles >= 1e6
        ? `${(pkg.tiles / 1e6).toFixed(1)}M`
        : `${(pkg.tiles / 1e3).toFixed(0)}k`
    return (
        <div className="pkg-thumb" style={{ background: `oklch(0.22 0.04 ${hue})` }}>
            <svg viewBox="0 0 100 60" preserveAspectRatio="none">
                <defs>
                    <pattern id={`grid-${pkg.id}`} width="10" height="10" patternUnits="userSpaceOnUse">
                        <path
                            d="M 10 0 L 0 0 0 10"
                            fill="none"
                            stroke={`oklch(0.4 0.04 ${hue})`}
                            strokeWidth="0.3"
                        />
                    </pattern>
                </defs>
                <rect width="100" height="60" fill={`url(#grid-${pkg.id})`} />
                <path
                    d={`M 10 ${30 + Math.sin(hue) * 8} Q 30 ${20 + Math.cos(hue) * 5} 50 28 T 90 ${32 + Math.sin(hue * 2) * 6}`}
                    fill="none"
                    stroke={`oklch(0.65 0.12 ${hue})`}
                    strokeWidth="1.2"
                    opacity="0.7"
                />
                <rect
                    x={20 + ox}
                    y={15 + oy}
                    width={ow}
                    height={oh}
                    fill={`oklch(0.7 0.18 ${hue} / 0.25)`}
                    stroke={`oklch(0.75 0.18 ${hue})`}
                    strokeWidth="0.6"
                />
            </svg>
            <div className="pkg-thumb-overlay">
                <span className="mono">{tilesLabel}</span>
            </div>
        </div>
    )
}

// ──────── Packages list ────────────────────────────────────
function PackagesList({
    packages,
    selected,
    onSelect,
    onPreview,
    sortBy,
    setSortBy,
    filterPlatform,
    setFilterPlatform,
    onOpenFolder,
}: {
    packages: Pkg[]
    selected: string | null
    onSelect: (id: string) => void
    onPreview: (id: string) => void
    sortBy: 'date' | 'tiles' | 'name'
    setSortBy: (s: 'date' | 'tiles' | 'name') => void
    filterPlatform: string
    setFilterPlatform: (p: string) => void
    onOpenFolder: (path: string) => void
}) {
    const totalTiles = useMemo(
        () => packages.reduce((s, p) => s + p.tiles, 0),
        [packages]
    )

    return (
        <>
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 22px',
                    borderBottom: '1px solid var(--hairline)',
                    background: 'var(--panel)',
                }}
            >
                <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                    <b className="mono" style={{ color: 'var(--text)' }}>{packages.length}</b> 个瓦片包 ·
                    共 <b className="mono" style={{ color: 'var(--text)' }}>{totalTiles.toLocaleString()}</b> 瓦片
                </div>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                    <div className="seg">
                        {['all', 'tianditu', 'amap', 'osm', 'baidu'].map(p => (
                            <button
                                key={p}
                                type="button"
                                className={filterPlatform === p ? 'active' : ''}
                                onClick={() => setFilterPlatform(p)}
                            >
                                {p === 'all' ? '全部' : p === 'tianditu' ? '天地图' : p === 'amap' ? '高德' : p === 'osm' ? 'OSM' : '百度'}
                            </button>
                        ))}
                    </div>
                    <select
                        className="select"
                        value={sortBy}
                        onChange={e => setSortBy(e.target.value as 'date' | 'tiles' | 'name')}
                        style={{ width: 130 }}
                    >
                        <option value="date">最近创建</option>
                        <option value="tiles">瓦片数量</option>
                        <option value="name">名称</option>
                    </select>
                </div>
            </div>

            <div className="page-scroll">
                <div style={{ padding: '16px 22px' }}>
                    {packages.length === 0 ? (
                        <div className="empty" style={{ padding: '60px 20px' }}>
                            <div className="empty-icon"><GcIcon name="map" size={22} /></div>
                            <h4>还没有离线瓦片包</h4>
                            <p>到「新建采集 → 离线地图瓦片」开始下载第一个区域。</p>
                        </div>
                    ) : (
                        <div className="pkg-grid">
                            {packages.map(pkg => {
                                return (
                                    <div
                                        key={pkg.id}
                                        className={`pkg-card${pkg.id === selected ? ' selected' : ''}`}
                                        onClick={() => onSelect(pkg.id)}
                                        onDoubleClick={() => onPreview(pkg.id)}
                                        data-context-path={pkg.outputPath || undefined}
                                    >
                                        <PkgThumb pkg={pkg} />
                                        <div className="pkg-card-body">
                                            <div className="pkg-card-title">{pkg.name}</div>
                                            <div className="pkg-card-meta">
                                                <PlatformBadge name={pkg.platform} />
                                                <span className="type-badge t-tile">{pkg.mapType}</span>
                                                <span className="mono" style={{ color: 'var(--text-3)' }}>
                                                    z{pkg.zoom[0]}–z{pkg.zoom[1]}
                                                </span>
                                            </div>
                                            <div className="pkg-card-foot mono">
                                                <span>
                                                    <b style={{ color: 'var(--text)' }}>{pkg.tiles.toLocaleString()}</b> 瓦片
                                                </span>
                                                <span style={{ marginLeft: 'auto', color: 'var(--text-4)' }}>
                                                    {pkg.created.slice(0, 16).replace('T', ' ')}
                                                </span>
                                            </div>
                                        </div>
                                        <div className="pkg-card-actions">
                                            <button
                                                type="button"
                                                className="btn sm"
                                                onClick={e => {
                                                    e.stopPropagation()
                                                    onPreview(pkg.id)
                                                }}
                                            >
                                                <GcIcon name="play" size={11} />预览
                                            </button>
                                            <button
                                                type="button"
                                                className="iconbtn"
                                                title="打开所在文件夹"
                                                onClick={e => {
                                                    e.stopPropagation()
                                                    if (pkg.outputPath) onOpenFolder(pkg.outputPath)
                                                }}
                                            >
                                                <GcIcon name="folder" size={13} />
                                            </button>
                                            <button
                                                type="button"
                                                className="iconbtn"
                                                title="复制路径"
                                                onClick={e => {
                                                    e.stopPropagation()
                                                    if (pkg.outputPath) navigator.clipboard?.writeText(pkg.outputPath).catch(() => { })
                                                }}
                                            >
                                                <GcIcon name="copy" size={13} />
                                            </button>
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </div>
            </div>
        </>
    )
}

// ──────── Preview ──────────────────────────────────────────
function FitToBounds({ b }: { b: Bounds }) {
    const map = useMap()
    useEffect(() => {
        try {
            map.fitBounds([[b.south, b.west], [b.north, b.east]], { padding: [40, 40] })
        } catch { /* ignore */ }
    }, [map, b])
    return null
}

function PackagePreview({
    packages,
    selected,
    setSelected,
}: { packages: Pkg[]; selected: string | null; setSelected: (id: string) => void }) {
    const pkg = packages.find(p => p.id === selected) ?? packages[0]
    if (!pkg) {
        return (
            <div className="empty" style={{ padding: '60px 20px' }}>
                <div className="empty-icon"><GcIcon name="map" size={22} /></div>
                <h4>没有可预览的瓦片包</h4>
                <p>先下载一个离线瓦片包再来预览。</p>
            </div>
        )
    }

    return (
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            <div
                style={{
                    width: 300,
                    borderRight: '1px solid var(--hairline)',
                    background: 'var(--panel)',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                }}
            >
                <div className="panel-head" style={{ borderBottom: '1px solid var(--hairline)' }}>
                    <h3>选择瓦片包</h3>
                    <span className="meta">{packages.length}</span>
                </div>
                <div style={{ overflow: 'auto', flex: 1 }}>
                    {packages.map(p => (
                        <div
                            key={p.id}
                            className={`pkg-list-row${p.id === pkg.id ? ' active' : ''}`}
                            onClick={() => setSelected(p.id)}
                        >
                            <div className="pkg-list-thumb"><PkgThumb pkg={p} /></div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div
                                    style={{
                                        fontSize: 12.5,
                                        fontWeight: 500,
                                        color: 'var(--text)',
                                        whiteSpace: 'nowrap',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                    }}
                                >
                                    {p.name}
                                </div>
                                <div
                                    className="mono"
                                    style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 2 }}
                                >
                                    {p.tiles.toLocaleString()} 瓦片 · z{p.zoom[0]}–z{p.zoom[1]}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
                <MapContainer
                    key={pkg.id}
                    bounds={
                        L.latLngBounds(
                            [pkg.bounds.south, pkg.bounds.west],
                            [pkg.bounds.north, pkg.bounds.east]
                        )
                    }
                    style={{ position: 'absolute', inset: 0 }}
                    zoomControl={false}
                    attributionControl={false}
                >
                    <TileLayer
                        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                        maxZoom={19}
                    />
                    <Rectangle
                        bounds={[
                            [pkg.bounds.south, pkg.bounds.west],
                            [pkg.bounds.north, pkg.bounds.east],
                        ]}
                        pathOptions={{
                            color: 'var(--accent)',
                            weight: 2,
                            fillColor: 'var(--accent)',
                            fillOpacity: 0.15,
                        }}
                    />
                    <FitToBounds b={pkg.bounds} />
                </MapContainer>

                <div
                    style={{
                        position: 'absolute',
                        top: 12,
                        left: 12,
                        zIndex: 800,
                        background: 'var(--panel)',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        padding: '12px 14px',
                        boxShadow: 'var(--shadow)',
                        width: 340,
                    }}
                >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                        <div style={{ width: 60, height: 36, borderRadius: 4, overflow: 'hidden', flexShrink: 0 }}>
                            <PkgThumb pkg={pkg} />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div
                                style={{
                                    fontSize: 13,
                                    fontWeight: 600,
                                    color: 'var(--text)',
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                }}
                            >
                                {pkg.name}
                            </div>
                            <div style={{ marginTop: 4, display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                                <PlatformBadge name={pkg.platform} />
                                <span className="type-badge t-tile">{pkg.mapType}</span>
                            </div>
                        </div>
                    </div>
                    <div className="pkg-detail-grid">
                        <div><span>缩放</span><b className="mono">z{pkg.zoom[0]}–z{pkg.zoom[1]}</b></div>
                        <div><span>瓦片</span><b className="mono">{pkg.tiles.toLocaleString()}</b></div>
                        <div><span>格式</span><b className="mono">{pkg.outputFormat}</b></div>
                        <div><span>创建</span><b style={{ whiteSpace: 'nowrap' }}>{pkg.created.slice(0, 16).replace('T', ' ')}</b></div>
                    </div>
                    <div
                        className="mono"
                        style={{
                            fontSize: 10.5,
                            color: 'var(--text-3)',
                            marginTop: 6,
                            paddingTop: 6,
                            borderTop: '1px dashed var(--hairline)',
                        }}
                    >
                        SW {pkg.bounds.south.toFixed(4)}, {pkg.bounds.west.toFixed(4)} → NE {pkg.bounds.north.toFixed(4)}, {pkg.bounds.east.toFixed(4)}
                    </div>
                </div>

                <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 800, display: 'flex', gap: 6 }}>
                    <button
                        type="button"
                        className="btn"
                        onClick={() => pkg.outputPath && revealItemInDir(pkg.outputPath).catch(() => { })}
                    >
                        <GcIcon name="folder" size={13} />打开文件夹
                    </button>
                </div>
            </div>
        </div>
    )
}

// ──────── Convert panel ────────────────────────────────────
function ConvertPanel() {
    const [src, setSrc] = useState('')
    const [dst, setDst] = useState('')
    const [fmt, setFmt] = useState<'mbtiles' | 'zip' | 'folder'>('zip')
    const [busy, setBusy] = useState(false)
    const { success, error: errorToast } = useToast()

    const pickSrc = async () => {
        try {
            const picked = await openDialog({
                multiple: false,
                directory: false,
                filters: [{ name: 'Tile package', extensions: ['mbtiles', 'zip'] }],
            })
            if (typeof picked === 'string') setSrc(picked)
        } catch { /* user cancelled */ }
    }

    const pickDst = async () => {
        try {
            if (fmt === 'folder') {
                const dir = await openDialog({ multiple: false, directory: true })
                if (typeof dir === 'string') setDst(dir)
            } else {
                const ext = fmt === 'zip' ? 'zip' : 'mbtiles'
                const path = await save({
                    filters: [{ name: 'Tile package', extensions: [ext] }],
                    defaultPath: `tiles.${ext}`,
                })
                if (path) setDst(path)
            }
        } catch { /* cancelled */ }
    }

    const runConvert = async () => {
        if (!src || !dst) {
            errorToast('请填写源文件与输出位置', '两个字段都不能为空')
            return
        }
        setBusy(true)
        try {
            await invoke('convert_tile_file', {
                inputPath: src,
                outputPath: dst,
                outputFormat: fmt,
            })
            success('转换完成', `已输出到 ${dst}`)
        } catch (e: unknown) {
            errorToast('转换失败', String(e))
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="page-scroll">
            <div style={{ maxWidth: 720, margin: '32px auto', padding: '0 22px' }}>
                <div className="panel">
                    <div className="panel-head">
                        <h3>格式转换</h3>
                        <span className="meta">MBTiles ↔ ZIP (XYZ) ↔ 目录</span>
                    </div>
                    <div style={{ padding: 18 }}>
                        <div className="field-row" style={{ marginBottom: 14 }}>
                            <label className="field-label">源文件</label>
                            <div style={{ display: 'flex', gap: 6 }}>
                                <input
                                    className="input mono"
                                    value={src}
                                    onChange={e => setSrc(e.target.value)}
                                    placeholder="选择 .mbtiles 或 .zip 文件"
                                    style={{ flex: 1, fontSize: 11.5 }}
                                />
                                <button type="button" className="btn" onClick={pickSrc}>
                                    <GcIcon name="folder" size={13} />选择文件...
                                </button>
                            </div>
                        </div>

                        <div className="field-row" style={{ marginBottom: 14 }}>
                            <label className="field-label">输出格式</label>
                            <div className="seg" style={{ width: '100%' }}>
                                <button
                                    type="button"
                                    style={{ flex: 1 }}
                                    className={fmt === 'mbtiles' ? 'active' : ''}
                                    onClick={() => setFmt('mbtiles')}
                                >
                                    MBTiles
                                </button>
                                <button
                                    type="button"
                                    style={{ flex: 1 }}
                                    className={fmt === 'zip' ? 'active' : ''}
                                    onClick={() => setFmt('zip')}
                                >
                                    ZIP (XYZ)
                                </button>
                                <button
                                    type="button"
                                    style={{ flex: 1 }}
                                    className={fmt === 'folder' ? 'active' : ''}
                                    onClick={() => setFmt('folder')}
                                >
                                    目录 (XYZ)
                                </button>
                            </div>
                        </div>

                        <div className="field-row">
                            <label className="field-label">输出位置</label>
                            <div style={{ display: 'flex', gap: 6 }}>
                                <input
                                    className="input mono"
                                    value={dst}
                                    onChange={e => setDst(e.target.value)}
                                    placeholder={fmt === 'folder' ? '选择输出目录' : `输出 .${fmt}`}
                                    style={{ flex: 1, fontSize: 11.5 }}
                                />
                                <button type="button" className="btn" onClick={pickDst}>
                                    <GcIcon name="folder" size={13} />选择...
                                </button>
                            </div>
                        </div>

                        <div
                            style={{
                                marginTop: 16,
                                padding: '10px 12px',
                                background: 'var(--panel-3)',
                                borderRadius: 6,
                                fontSize: 11.5,
                                color: 'var(--text-3)',
                                display: 'flex',
                                gap: 8,
                                alignItems: 'flex-start',
                            }}
                        >
                            <GcIcon
                                name="alertTriangle"
                                size={13}
                                style={{ flexShrink: 0, marginTop: 2, color: 'var(--st-amber)' }}
                            />
                            <div>
                                ZIP 适合分享 / 上传；MBTiles 适合 QGIS / 移动端离线集成；目录适合静态网站托管。
                                转换大文件可能需要数分钟。
                            </div>
                        </div>

                        <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                            <button
                                type="button"
                                className="btn ghost"
                                onClick={() => {
                                    setSrc('')
                                    setDst('')
                                }}
                                disabled={busy}
                            >
                                重置
                            </button>
                            <button type="button" className="btn primary" onClick={runConvert} disabled={busy}>
                                <GcIcon name="refresh" size={13} />
                                {busy ? '转换中...' : '开始转换'}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}

// ──────── Page wrapper ─────────────────────────────────────
type Tab = 'list' | 'preview' | 'convert'

const TABS: { key: Tab; label: string; icon: string }[] = [
    { key: 'list', label: '我的瓦片包', icon: 'grid' },
    { key: 'preview', label: '浏览预览', icon: 'map' },
    { key: 'convert', label: '格式转换', icon: 'refresh' },
]

export default function OfflineMaps() {
    const [params, setParams] = useSearchParams()
    const initialTab = (params.get('tab') as Tab) || 'list'
    const [tab, setTab] = useState<Tab>(initialTab)
    const [packages, setPackages] = useState<Pkg[]>([])
    const [loading, setLoading] = useState(true)
    const [selected, setSelected] = useState<string | null>(null)
    const [sortBy, setSortBy] = useState<'date' | 'tiles' | 'name'>('date')
    const [filterPlatform, setFilterPlatform] = useState<string>('all')

    useEffect(() => {
        let cancelled = false
        const load = async () => {
            try {
                const tasks = await invoke<TileTask[]>('get_tile_tasks')
                const completed = tasks.filter(t =>
                    t.status === 'completed' || t.status === 'done'
                )
                const mapped = completed.map(taskToPkg)
                if (cancelled) return
                setPackages(mapped)
                if (mapped.length > 0 && !selected) setSelected(mapped[0].id)
            } catch {
                if (!cancelled) setPackages([])
            } finally {
                if (!cancelled) setLoading(false)
            }
        }
        load()
        return () => { cancelled = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        const q = params.get('tab') as Tab | null
        if (q && q !== tab) setTab(q)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [params])

    const onSwitch = (k: Tab) => {
        setTab(k)
        const next = new URLSearchParams(params)
        next.set('tab', k)
        setParams(next, { replace: true })
    }

    const filtered = useMemo(() => {
        const list = filterPlatform === 'all'
            ? packages
            : packages.filter(p => p.platform === filterPlatform)
        const sorted = [...list].sort((a, b) => {
            if (sortBy === 'tiles') return b.tiles - a.tiles
            if (sortBy === 'name') return a.name.localeCompare(b.name)
            return (b.created || '').localeCompare(a.created || '')
        })
        return sorted
    }, [packages, sortBy, filterPlatform])

    const subtitle =
        tab === 'list' ? '已下载瓦片包 · 浏览预览 · 格式转换' :
            tab === 'preview' ? '在地图上预览瓦片包覆盖范围' :
                'MBTiles ↔ ZIP ↔ 目录 互相转换'

    return (
        <div className="page">
            <div className="page-header">
                <div>
                    <h1 className="page-title">离线地图</h1>
                    <div className="page-subtitle">
                        {loading ? '正在加载...' : subtitle}
                    </div>
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

            {tab === 'list' && (
                <PackagesList
                    packages={filtered}
                    selected={selected}
                    onSelect={setSelected}
                    onPreview={id => {
                        setSelected(id)
                        onSwitch('preview')
                    }}
                    sortBy={sortBy}
                    setSortBy={setSortBy}
                    filterPlatform={filterPlatform}
                    setFilterPlatform={setFilterPlatform}
                    onOpenFolder={p => revealItemInDir(p).catch(() => { })}
                />
            )}
            {tab === 'preview' && (
                <PackagePreview
                    packages={filtered.length > 0 ? filtered : packages}
                    selected={selected}
                    setSelected={setSelected}
                />
            )}
            {tab === 'convert' && <ConvertPanel />}
        </div>
    )
}
