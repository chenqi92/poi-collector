import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { GcIcon } from '@/components/shell'
import { useToast } from '@/components/ui/toast'

interface Region {
    code: string
    name: string
    level: string
    parent_code: string | null
}

interface CleanupRow {
    code: string
    name: string
    count: number
    pct: number
}

export function CleanupView() {
    const { success, error: errorToast } = useToast()
    const [loading, setLoading] = useState(true)
    const [stats, setStats] = useState<[string, number][]>([])
    const [regionNames, setRegionNames] = useState<Map<string, string>>(new Map())
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [buoyCount, setBuoyCount] = useState(0)
    const [tilePackages, setTilePackages] = useState(0)
    const [search, setSearch] = useState('')

    const load = async () => {
        setLoading(true)
        try {
            await invoke<[number, number]>('fix_region_codes').catch(() => { })
            const [s, bc] = await Promise.all([
                invoke<[string, number][]>('get_poi_stats_by_region').catch(() => [] as [string, number][]),
                invoke<number>('chart_get_buoy_count').catch(() => 0),
            ])
            setStats(s)
            setBuoyCount(bc)
        } catch (e) {
            errorToast('加载失败', String(e))
        } finally {
            setLoading(false)
        }

        // tile packages = completed tile tasks
        try {
            const tasks = await invoke<{ status: string }[]>('get_tile_tasks')
            setTilePackages(tasks.filter(t => t.status === 'completed' || t.status === 'done').length)
        } catch { /* ignore */ }
    }

    const loadRegionNames = async () => {
        try {
            const provinces = await invoke<Region[]>('get_provinces')
            const names = new Map<string, string>()
            provinces.forEach(p => names.set(p.code, p.name))
            // 1-level child lookup is enough for top-level display; deeper expansion is lazy
            const codesInStats = new Set(stats.map(([c]) => c))
            const parentCodes = new Set<string>()
            for (const c of codesInStats) {
                if (!names.has(c)) parentCodes.add(c.slice(0, 2) + '0000')
            }
            await Promise.all(
                Array.from(parentCodes).map(async pc => {
                    try {
                        const cities = await invoke<Region[]>('get_region_children', { parentCode: pc })
                        cities.forEach(c => names.set(c.code, c.name))
                        for (const city of cities) {
                            try {
                                const districts = await invoke<Region[]>('get_region_children', { parentCode: city.code })
                                districts.forEach(d => names.set(d.code, d.name))
                            } catch { /* ignore */ }
                        }
                    } catch { /* ignore */ }
                })
            )
            setRegionNames(names)
        } catch { /* ignore */ }
    }

    useEffect(() => { load() }, [])
    useEffect(() => {
        if (stats.length > 0) loadRegionNames()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stats.length])

    const totalCount = useMemo(() => stats.reduce((s, [, n]) => s + n, 0), [stats])
    const maxCount = useMemo(() => stats.reduce((m, [, n]) => Math.max(m, n), 0), [stats])

    const rows: CleanupRow[] = useMemo(() => {
        const list = stats.map(([code, n]) => ({
            code,
            name: regionNames.get(code) ?? code,
            count: n,
            pct: maxCount > 0 ? n / maxCount : 0,
        }))
        const q = search.trim().toLowerCase()
        return q
            ? list.filter(r => r.name.toLowerCase().includes(q) || r.code.includes(q))
            : list
    }, [stats, regionNames, maxCount, search])

    const selectedCount = useMemo(() => {
        let n = 0
        for (const c of selected) n += stats.find(s => s[0] === c)?.[1] ?? 0
        return n
    }, [selected, stats])

    const toggleSelect = (code: string) =>
        setSelected(s => {
            const n = new Set(s)
            if (n.has(code)) n.delete(code); else n.add(code)
            return n
        })

    const deleteSelected = async () => {
        if (selected.size === 0) return
        const codes = Array.from(selected)
        const names = codes.map(c => regionNames.get(c) ?? c).join('、')
        if (!confirm(`确定要删除以下地区的所有 POI 数据吗？\n\n${names}\n\n此操作不可撤销！`)) return
        try {
            const n = await invoke<number>('delete_poi_by_regions', { codes })
            success('删除成功', `已删除 ${n.toLocaleString()} 条 POI`)
            setSelected(new Set())
            load()
        } catch (e) {
            errorToast('删除失败', String(e))
        }
    }

    const deleteOne = async (code: string) => {
        const name = regionNames.get(code) ?? code
        if (!confirm(`确定要删除 ${name} 的所有 POI 数据吗？\n\n此操作不可撤销！`)) return
        try {
            const n = await invoke<number>('delete_poi_by_regions', { codes: [code] })
            success('删除成功', `已删除 ${n.toLocaleString()} 条 POI`)
            load()
        } catch (e) {
            errorToast('删除失败', String(e))
        }
    }

    const clearAllPoi = async () => {
        if (!confirm('⚠ 危险操作\n\n确定要清空所有 POI 数据吗？此操作不可撤销！')) return
        if (!confirm('再次确认：真的要删除全部 POI 吗？')) return
        try {
            const n = await invoke<number>('clear_all_poi')
            success('已清空', `共删除 ${n.toLocaleString()} 条`)
            load()
        } catch (e) {
            errorToast('清空失败', String(e))
        }
    }

    const clearAllBuoys = async () => {
        if (!confirm('⚠ 危险操作\n\n确定要清空所有航标数据吗？此操作不可撤销！')) return
        try {
            await invoke('chart_clear_buoys')
            success('已清空', '所有航标数据已删除')
            load()
        } catch (e) {
            errorToast('清空失败', String(e))
        }
    }

    const exportBuoys = async (fmt: 'json' | 'csv') => {
        try {
            const path = await save({
                defaultPath: `buoys.${fmt}`,
                filters: [{ name: fmt.toUpperCase(), extensions: [fmt] }],
            })
            if (!path) return
            const result = await invoke<string>('chart_export_buoys', {
                format: fmt,
                outputPath: path,
            })
            success('导出成功', result)
        } catch (e) {
            errorToast('导出失败', String(e))
        }
    }

    return (
        <div className="page-scroll">
            <div style={{ padding: '18px 22px', maxWidth: 1100 }}>
                {/* 按地区清理 */}
                <div className="section-head">
                    <h2>按地区清理</h2>
                    <span className="section-link">
                        共 {stats.length} 个地区 ·
                        <b className="mono" style={{ color: 'var(--text)' }}> {totalCount.toLocaleString()} </b>
                        条 POI
                    </span>
                </div>

                <div className="panel cleanup-card">
                    <div className="panel-head">
                        <h3>按地区分布</h3>
                        <span className="meta">
                            <input
                                className="input"
                                placeholder="搜索地区..."
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                                style={{ height: 24, fontSize: 11.5, width: 160, marginLeft: 8 }}
                            />
                        </span>
                        <div className="panel-head-actions">
                            <button
                                type="button"
                                className="btn ghost sm"
                                onClick={() => load()}
                                disabled={loading}
                            >
                                <GcIcon name="refresh" size={11} />
                                {loading ? '刷新中...' : '刷新'}
                            </button>
                        </div>
                    </div>
                    <div style={{ padding: '6px 0' }}>
                        {rows.length === 0 ? (
                            <div className="empty" style={{ padding: '36px 16px' }}>
                                <div className="empty-icon"><GcIcon name="database" size={20} /></div>
                                <h4>{loading ? '加载中...' : '没有 POI 数据'}</h4>
                                {!loading && <p>采集任务完成后，地区分布会显示在这里。</p>}
                            </div>
                        ) : rows.map(r => (
                            <div className="cleanup-row" key={r.code}>
                                <input
                                    type="checkbox"
                                    checked={selected.has(r.code)}
                                    onChange={() => toggleSelect(r.code)}
                                />
                                <span style={{ fontSize: 12.5, color: 'var(--text)' }}>{r.name}</span>
                                <span
                                    className="mono"
                                    style={{ fontSize: 11.5, color: 'var(--text-2)', minWidth: 80, textAlign: 'right' }}
                                >
                                    {r.count.toLocaleString()}
                                </span>
                                <div className="cleanup-region-bar"><i style={{ width: `${r.pct * 100}%` }} /></div>
                                <button
                                    type="button"
                                    className="iconbtn"
                                    title="删除该地区"
                                    onClick={() => deleteOne(r.code)}
                                >
                                    <GcIcon name="trash" size={13} />
                                </button>
                            </div>
                        ))}
                    </div>
                </div>

                <div
                    style={{
                        display: 'flex',
                        gap: 8,
                        marginBottom: 24,
                        alignItems: 'center',
                        flexWrap: 'wrap',
                    }}
                >
                    <button
                        type="button"
                        className="btn"
                        onClick={deleteSelected}
                        disabled={selected.size === 0}
                    >
                        <GcIcon name="trash" size={13} />
                        删除已选 {selected.size} 个地区
                    </button>
                    {selected.size > 0 && (
                        <button
                            type="button"
                            className="btn ghost"
                            onClick={() => setSelected(new Set())}
                        >
                            取消选择
                        </button>
                    )}
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                        已选 <b className="mono" style={{ color: 'var(--text)' }}>{selectedCount.toLocaleString()}</b> 条
                    </span>
                </div>

                {/* 航标 */}
                <div className="section-head">
                    <h2>航标数据</h2>
                    <span className="section-link">
                        共 <b className="mono" style={{ color: 'var(--text)' }}>{buoyCount.toLocaleString()}</b> 条
                    </span>
                </div>

                <div className="panel" style={{ marginBottom: 16 }}>
                    <div style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
                        <GcIcon name="navigation" size={18} style={{ color: 'var(--st-blue)' }} />
                        <div style={{ flex: 1, fontSize: 12.5, color: 'var(--text-2)' }}>
                            航标数据来自长江航道图，独立存储。可单独导出或清空。
                        </div>
                        <button
                            type="button"
                            className="btn"
                            disabled={buoyCount === 0}
                            onClick={() => exportBuoys('json')}
                        >
                            <GcIcon name="download" size={13} />导出 JSON
                        </button>
                        <button
                            type="button"
                            className="btn"
                            disabled={buoyCount === 0}
                            onClick={() => exportBuoys('csv')}
                        >
                            <GcIcon name="download" size={13} />导出 CSV
                        </button>
                    </div>
                </div>

                {/* 危险区 */}
                <div className="danger-zone">
                    <div className="danger-zone-title">⚠ 危险操作</div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                        <button
                            type="button"
                            className="btn danger"
                            onClick={clearAllPoi}
                            disabled={totalCount === 0}
                        >
                            <GcIcon name="trash" size={13} />
                            清空所有 POI ({totalCount.toLocaleString()})
                        </button>
                        <button
                            type="button"
                            className="btn danger"
                            onClick={clearAllBuoys}
                            disabled={buoyCount === 0}
                        >
                            <GcIcon name="trash" size={13} />
                            清空所有航标 ({buoyCount.toLocaleString()})
                        </button>
                        <button
                            type="button"
                            className="btn danger"
                            disabled={tilePackages === 0}
                            title="瓦片包从离线地图页删除"
                        >
                            <GcIcon name="trash" size={13} />
                            清空瓦片包 ({tilePackages}) — 请到「离线地图」操作
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}
