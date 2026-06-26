// 索引选择弹窗：日索引（*_YYYY_MM_DD）用日期范围一键选，另有过滤 + 勾选做精细控制。

import { useMemo, useState, type CSSProperties } from 'react'
import type { IndexInfo } from '@/lib/ais/types'

const pad = (n: number) => String(n).padStart(2, '0')

/** 从索引名里抽出 YYYY-MM-DD（如 shipmixhistory_2026_06_26 → 2026-06-26） */
export function indexDate(name: string): string | null {
    const m = name.match(/(\d{4})[._-](\d{2})[._-](\d{2})/)
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

/** 给一组索引名算一个「选了 N · 日期范围」的摘要 */
export function indicesSummary(names: string[]): string {
    if (names.length === 0) return '未选索引'
    const dates = names.map(indexDate).filter(Boolean).sort() as string[]
    if (dates.length) {
        const lo = dates[0]
        const hi = dates[dates.length - 1]
        return `选了 ${names.length} 个 · ${lo === hi ? lo : `${lo} ~ ${hi}`}`
    }
    return `选了 ${names.length} 个`
}

export function IndexPickerDialog({
    indices,
    selected,
    onApply,
    onClose,
}: {
    indices: IndexInfo[]
    selected: string[]
    onApply: (next: string[]) => void
    onClose: () => void
}) {
    const dated = useMemo(() => indices.map((i) => ({ ...i, date: indexDate(i.name) })), [indices])
    const allDates = useMemo(
        () => (dated.map((i) => i.date).filter(Boolean) as string[]).sort(),
        [dated],
    )
    const minDate = allDates[0] ?? ''
    const maxDate = allDates[allDates.length - 1] ?? ''

    const [draft, setDraft] = useState<Set<string>>(() => new Set(selected))
    const [filter, setFilter] = useState('')
    const [sortBy, setSortBy] = useState<'date' | 'docs'>('date')
    const [from, setFrom] = useState(maxDate)
    const [to, setTo] = useState(maxDate)

    const filtered = useMemo(() => {
        const f = filter.trim().toLowerCase()
        return f ? dated.filter((i) => i.name.toLowerCase().includes(f)) : dated
    }, [dated, filter])
    const shown = useMemo(() => {
        if (sortBy === 'date') return filtered
        return [...filtered].sort((a, b) => (b.docsCount ?? 0) - (a.docsCount ?? 0))
    }, [filtered, sortBy])

    const applyRange = (f: string, t: string) => {
        if (!f || !t) return
        const lo = f <= t ? f : t
        const hi = f <= t ? t : f
        const sel = new Set<string>()
        for (const i of dated) if (i.date && i.date >= lo && i.date <= hi) sel.add(i.name)
        setDraft(sel)
    }
    const presetDays = (days: number | null) => {
        if (!maxDate) return
        if (days == null) {
            setFrom(minDate)
            setTo(maxDate)
            applyRange(minDate, maxDate)
            return
        }
        const endD = new Date(maxDate + 'T00:00:00')
        const startD = new Date(endD.getTime() - (days - 1) * 86400000)
        const start = `${startD.getFullYear()}-${pad(startD.getMonth() + 1)}-${pad(startD.getDate())}`
        setFrom(start)
        setTo(maxDate)
        applyRange(start, maxDate)
    }
    const toggle = (name: string) =>
        setDraft((s) => {
            const n = new Set(s)
            if (n.has(name)) n.delete(name)
            else n.add(name)
            return n
        })
    const addVisible = () =>
        setDraft((s) => {
            const n = new Set(s)
            for (const i of filtered) n.add(i.name)
            return n
        })
    const removeVisible = () =>
        setDraft((s) => {
            const n = new Set(s)
            for (const i of filtered) n.delete(i.name)
            return n
        })

    return (
        <div onClick={onClose} style={overlay}>
            <div onClick={(e) => e.stopPropagation()} style={dialog}>
                <div style={head}>
                    <strong>选择索引</strong>
                    <span style={{ color: 'var(--text-3)', fontSize: 12 }}>
                        共 {indices.length} 个 · 已选 {draft.size}
                    </span>
                    <button type="button" className="iconbtn" onClick={onClose} style={{ marginLeft: 'auto', fontSize: 18 }}>
                        ×
                    </button>
                </div>

                {minDate && (
                    <div style={rangeRow}>
                        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>日期范围</span>
                        <input type="date" className="ais-select" style={{ width: 152 }} min={minDate} max={maxDate} value={from} onChange={(e) => setFrom(e.target.value)} />
                        <span>~</span>
                        <input type="date" className="ais-select" style={{ width: 152 }} min={minDate} max={maxDate} value={to} onChange={(e) => setTo(e.target.value)} />
                        <button type="button" className="btn primary" onClick={() => applyRange(from, to)}>选此范围</button>
                        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                            <button type="button" className="ais-idx-preset" onClick={() => presetDays(3)}>最近3天</button>
                            <button type="button" className="ais-idx-preset" onClick={() => presetDays(7)}>最近7天</button>
                            <button type="button" className="ais-idx-preset" onClick={() => presetDays(30)}>最近30天</button>
                            <button type="button" className="ais-idx-preset" onClick={() => presetDays(null)}>全部</button>
                        </div>
                        <span style={{ fontSize: 11.5, color: 'var(--text-4)' }}>数据范围 {minDate} ~ {maxDate}</span>
                    </div>
                )}

                <div style={toolRow}>
                    <input className="ais-select" style={{ flex: 1 }} placeholder="过滤索引名…" value={filter} onChange={(e) => setFilter(e.target.value)} />
                    <div className="seg ais-seg" title="按文档数排序可一眼看出哪些日期有数据">
                        <button type="button" className={sortBy === 'date' ? 'active' : ''} onClick={() => setSortBy('date')}>按日期</button>
                        <button type="button" className={sortBy === 'docs' ? 'active' : ''} onClick={() => setSortBy('docs')}>按文档数</button>
                    </div>
                    <button type="button" className="btn" onClick={addVisible}>＋可见</button>
                    <button type="button" className="btn" onClick={removeVisible}>－可见</button>
                    <button type="button" className="btn" onClick={() => setDraft(new Set())}>清空</button>
                </div>

                <div style={listBox}>
                    {shown.map((i) => {
                        const on = draft.has(i.name)
                        return (
                            <label key={i.name} className={`ais-idx-row${on ? ' on' : ''}`}>
                                <input type="checkbox" checked={on} onChange={() => toggle(i.name)} />
                                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.name}</span>
                                {typeof i.docsCount === 'number' && <span className="idx-count">{i.docsCount}</span>}
                            </label>
                        )
                    })}
                    {filtered.length === 0 && <div className="ais-hint" style={{ padding: 16 }}>无匹配索引</div>}
                </div>

                <div style={foot}>
                    <span style={{ marginRight: 'auto', fontSize: 12, color: 'var(--text-3)' }}>{indicesSummary([...draft])}</span>
                    <button type="button" className="btn" onClick={onClose}>取消</button>
                    <button type="button" className="btn primary" onClick={() => { onApply([...draft]); onClose() }}>确定（{draft.size}）</button>
                </div>
            </div>
        </div>
    )
}

const overlay: CSSProperties = { position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(0,0,0,0.45)', display: 'grid', placeItems: 'center', padding: 20 }
const dialog: CSSProperties = { width: 'min(720px, 94vw)', height: 'min(72vh, 660px)', display: 'flex', flexDirection: 'column', background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: 'var(--shadow-pop)', overflow: 'hidden' }
const head: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: '1px solid var(--hairline)' }
const rangeRow: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--hairline)' }
const toolRow: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', padding: '10px 14px' }
const listBox: CSSProperties = { flex: 1, overflow: 'auto', padding: '0 14px 8px' }
const foot: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center', padding: '10px 14px', borderTop: '1px solid var(--hairline)' }
