import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { GcIcon } from '@/components/shell'

interface Region {
    code: string
    name: string
    level: string
    parent_code: string | null
}

export interface SelectedRegion {
    code: string
    name: string
    level: string
}

interface RegionTagsPickerProps {
    value: SelectedRegion[]
    onChange: (v: SelectedRegion[]) => void
    title?: string
}

const LEVEL_LABEL: Record<string, string> = {
    province: '省',
    city: '市',
    district: '区',
}

function isDescendant(childCode: string, parentCode: string): boolean {
    if (childCode === parentCode) return false
    if (parentCode.endsWith('0000')) return childCode.slice(0, 2) === parentCode.slice(0, 2)
    if (parentCode.endsWith('00')) return childCode.slice(0, 4) === parentCode.slice(0, 4)
    return false
}

function isAncestor(ancestorCode: string, descendantCode: string): boolean {
    return isDescendant(descendantCode, ancestorCode)
}

// ──────── Inline summary (always visible in the form) ────────
export function RegionTagsPicker({ value, onChange, title }: RegionTagsPickerProps) {
    const [open, setOpen] = useState(false)

    const tagsByLevel = useMemo(() => {
        const out = { province: 0, city: 0, district: 0 }
        for (const v of value) {
            if (v.level === 'province') out.province++
            else if (v.level === 'city') out.city++
            else if (v.level === 'district') out.district++
        }
        return out
    }, [value])

    return (
        <div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button
                    type="button"
                    className="btn"
                    onClick={() => setOpen(true)}
                    style={{ flex: 1, justifyContent: 'flex-start' }}
                >
                    <GcIcon name="archive" size={12} />
                    {value.length === 0 ? '选择地区...' : `已选 ${value.length} 个地区 · 点击修改`}
                </button>
                {value.length > 0 && (
                    <button
                        type="button"
                        className="btn ghost"
                        onClick={() => onChange([])}
                        title="清空所有已选地区"
                    >
                        清空
                    </button>
                )}
            </div>

            {value.length > 0 ? (
                <>
                    <div className="selected-tags-head">
                        <span>
                            已选 <span className="count">{value.length}</span> 个
                        </span>
                        <span style={{ color: 'var(--text-4)' }}>·</span>
                        <span className="mono" style={{ fontSize: 10.5 }}>
                            {tagsByLevel.province > 0 && <>省 {tagsByLevel.province} </>}
                            {tagsByLevel.city > 0 && <>· 市 {tagsByLevel.city} </>}
                            {tagsByLevel.district > 0 && <>· 区 {tagsByLevel.district}</>}
                        </span>
                    </div>
                    <div className="selected-tags">
                        {value.map(v => (
                            <span className="tag" key={v.code} title={v.code}>
                                <span className="tag-level">{LEVEL_LABEL[v.level] ?? v.level}</span>
                                {v.name}
                                <span
                                    className="x"
                                    onClick={() => onChange(value.filter(x => x.code !== v.code))}
                                    role="button"
                                    aria-label={`移除 ${v.name}`}
                                >×</span>
                            </span>
                        ))}
                    </div>
                </>
            ) : (
                <div className="rp-inline-empty">尚未选择地区。点击上方按钮从地区库选择，或搜索省 / 市 / 区。</div>
            )}

            {open && (
                <RegionPickerDialog
                    initial={value}
                    title={title}
                    onCancel={() => setOpen(false)}
                    onConfirm={v => { onChange(v); setOpen(false) }}
                />
            )}
        </div>
    )
}

// ──────── Dialog ────────────────────────────────────────────
interface DialogProps {
    initial: SelectedRegion[]
    title?: string
    onCancel: () => void
    onConfirm: (v: SelectedRegion[]) => void
}

function RegionPickerDialog({ initial, title, onCancel, onConfirm }: DialogProps) {
    const [draft, setDraft] = useState<SelectedRegion[]>(initial)
    const [provinces, setProvinces] = useState<Region[]>([])
    const [expanded, setExpanded] = useState<Set<string>>(new Set())
    const [childrenMap, setChildrenMap] = useState<Record<string, Region[]>>({})
    const [query, setQuery] = useState('')
    const [debouncedQuery, setDebouncedQuery] = useState('')
    const [searchResults, setSearchResults] = useState<Region[]>([])
    const [searching, setSearching] = useState(false)
    const searchAbortRef = useRef(0)

    useEffect(() => {
        invoke<Region[]>('get_provinces').then(setProvinces).catch(() => { })
    }, [])

    useEffect(() => {
        const h = setTimeout(() => setDebouncedQuery(query.trim()), 180)
        return () => clearTimeout(h)
    }, [query])

    useEffect(() => {
        if (!debouncedQuery) {
            setSearchResults([])
            setSearching(false)
            return
        }
        const seq = ++searchAbortRef.current
        setSearching(true)
        invoke<Region[]>('search_regions', { query: debouncedQuery })
            .then(rs => { if (seq === searchAbortRef.current) setSearchResults(rs) })
            .catch(() => { if (seq === searchAbortRef.current) setSearchResults([]) })
            .finally(() => { if (seq === searchAbortRef.current) setSearching(false) })
    }, [debouncedQuery])

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onCancel()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onCancel])

    const selectedCodes = useMemo(() => new Set(draft.map(v => v.code)), [draft])

    const loadChildren = async (code: string) => {
        if (childrenMap[code]) return
        try {
            const list = await invoke<Region[]>('get_region_children', { parentCode: code })
            setChildrenMap(prev => ({ ...prev, [code]: list }))
        } catch { /* ignore */ }
    }

    const toggleExpand = async (code: string) => {
        if (expanded.has(code)) {
            setExpanded(s => { const n = new Set(s); n.delete(code); return n })
        } else {
            await loadChildren(code)
            setExpanded(s => new Set(s).add(code))
        }
    }

    const selectRegion = (r: Region | SelectedRegion) => {
        const next = draft.filter(v =>
            v.code !== r.code && !isAncestor(v.code, r.code) && !isDescendant(v.code, r.code)
        )
        next.push({ code: r.code, name: r.name, level: r.level })
        setDraft(next)
    }

    const deselectRegion = (code: string) => {
        setDraft(draft.filter(v => v.code !== code))
    }

    const toggleRegion = (r: Region) => {
        if (selectedCodes.has(r.code)) deselectRegion(r.code)
        else selectRegion(r)
    }

    const checkState = (code: string): 'checked' | 'partial' | 'none' => {
        if (selectedCodes.has(code)) return 'checked'
        for (const v of draft) {
            if (isAncestor(v.code, code)) return 'checked'
        }
        for (const v of draft) {
            if (isDescendant(v.code, code)) return 'partial'
        }
        return 'none'
    }

    const breadcrumbFor = (r: Region): string => {
        const parts: string[] = []
        if (r.level === 'district' || r.level === 'city') {
            const provinceCode = r.code.slice(0, 2) + '0000'
            const p = provinces.find(x => x.code === provinceCode)
            if (p) parts.push(p.name)
        }
        if (r.level === 'district') {
            const cityCode = r.code.slice(0, 4) + '00'
            const cities = childrenMap[r.code.slice(0, 2) + '0000']
            const c = cities?.find(x => x.code === cityCode)
            if (c) parts.push(c.name)
        }
        return parts.join(' / ')
    }

    const tagsByLevel = useMemo(() => {
        const out = { province: 0, city: 0, district: 0 }
        for (const v of draft) {
            if (v.level === 'province') out.province++
            else if (v.level === 'city') out.city++
            else if (v.level === 'district') out.district++
        }
        return out
    }, [draft])

    const renderCheckbox = (state: 'checked' | 'partial' | 'none', onClick: () => void) => (
        <span
            className={`region-check${state === 'checked' ? ' checked' : state === 'partial' ? ' partial' : ''}`}
            onClick={e => { e.stopPropagation(); onClick() }}
            role="checkbox"
            aria-checked={state === 'checked'}
        >
            {state === 'checked' && <GcIcon name="check" size={9} strokeWidth={2.5} />}
        </span>
    )

    const node = (
        <div className="rp-overlay" onClick={onCancel}>
            <div className="rp-dialog" onClick={e => e.stopPropagation()}>
                <div className="rp-head">
                    <h3>{title ?? '选择地区'}</h3>
                    <span className="meta">支持搜索省 / 市 / 区。父级选中后自动覆盖下属地区。</span>
                    <span style={{ flex: 1 }} />
                    <button type="button" className="close-btn" onClick={onCancel} aria-label="关闭">×</button>
                </div>

                <div className="rp-search-row">
                    <div style={{ position: 'relative', flex: 1 }}>
                        <input
                            className="input"
                            placeholder="搜索省 / 市 / 区..."
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                            autoFocus
                            style={{ width: '100%', paddingRight: query ? 26 : undefined }}
                        />
                        {query && (
                            <button
                                type="button"
                                onClick={() => setQuery('')}
                                style={{
                                    position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
                                    background: 'transparent', border: 'none', cursor: 'pointer',
                                    color: 'var(--text-4)', padding: 2, lineHeight: 0, fontSize: 14,
                                }}
                                aria-label="清空搜索"
                            >×</button>
                        )}
                    </div>
                    {searching && (
                        <span className="mono" style={{ fontSize: 11, color: 'var(--text-4)' }}>搜索中...</span>
                    )}
                </div>

                <div className="rp-body">
                    <div className="rp-tree-pane">
                        <div className="region-tree">
                            {debouncedQuery ? (
                                searching ? null : searchResults.length === 0 ? (
                                    <div className="region-empty">未找到匹配的地区</div>
                                ) : (
                                    searchResults.map(r => {
                                        const state = checkState(r.code)
                                        const crumb = breadcrumbFor(r)
                                        return (
                                            <div
                                                key={r.code}
                                                className={`region-tree-item${state === 'checked' ? ' active' : ''}`}
                                                onClick={() => toggleRegion(r)}
                                            >
                                                {renderCheckbox(state, () => toggleRegion(r))}
                                                <span className="level-pill">{LEVEL_LABEL[r.level] ?? r.level}</span>
                                                <span style={{ flex: '0 1 auto' }}>{r.name}</span>
                                                {crumb && <span className="crumb">— {crumb}</span>}
                                            </div>
                                        )
                                    })
                                )
                            ) : (
                                provinces.map(p => {
                                    const isOpenP = expanded.has(p.code)
                                    const cities = childrenMap[p.code] ?? []
                                    const pState = checkState(p.code)
                                    return (
                                        <div key={p.code}>
                                            <div className={`region-tree-item${pState === 'checked' ? ' active' : ''}`}>
                                                <span className="chevron" onClick={() => toggleExpand(p.code)}>
                                                    <GcIcon name={isOpenP ? 'chevronDown' : 'chevronRight'} size={11} />
                                                </span>
                                                {renderCheckbox(pState, () => toggleRegion(p))}
                                                <span style={{ flex: 1, cursor: 'pointer' }} onClick={() => toggleRegion(p)}>{p.name}</span>
                                            </div>
                                            {isOpenP && cities.map(c => {
                                                const isOpenC = expanded.has(c.code)
                                                const districts = childrenMap[c.code] ?? []
                                                const cState = checkState(c.code)
                                                return (
                                                    <div key={c.code}>
                                                        <div className={`region-tree-item child${cState === 'checked' ? ' active' : ''}`}>
                                                            <span className="chevron" onClick={() => toggleExpand(c.code)}>
                                                                <GcIcon name={isOpenC ? 'chevronDown' : 'chevronRight'} size={11} />
                                                            </span>
                                                            {renderCheckbox(cState, () => toggleRegion(c))}
                                                            <span style={{ flex: 1, cursor: 'pointer' }} onClick={() => toggleRegion(c)}>{c.name}</span>
                                                        </div>
                                                        {isOpenC && districts.map(d => {
                                                            const dState = checkState(d.code)
                                                            return (
                                                                <div
                                                                    key={d.code}
                                                                    className={`region-tree-item grandchild${dState === 'checked' ? ' active' : ''}`}
                                                                    onClick={() => toggleRegion(d)}
                                                                >
                                                                    {renderCheckbox(dState, () => toggleRegion(d))}
                                                                    <span style={{ flex: 1 }}>{d.name}</span>
                                                                </div>
                                                            )
                                                        })}
                                                    </div>
                                                )
                                            })}
                                        </div>
                                    )
                                })
                            )}
                        </div>
                    </div>

                    <div className="rp-selected-pane">
                        <div className="rp-selected-head">
                            <span>已选 <b style={{ color: 'var(--text)' }}>{draft.length}</b></span>
                            <span style={{ flex: 1 }} />
                            {draft.length > 0 && (
                                <button
                                    type="button"
                                    onClick={() => setDraft([])}
                                    style={{
                                        background: 'transparent', border: 'none', cursor: 'pointer',
                                        fontSize: 11, color: 'var(--text-3)', padding: '2px 4px',
                                        borderRadius: 3,
                                    }}
                                >
                                    全部清除
                                </button>
                            )}
                        </div>
                        <div className="rp-selected-list">
                            {draft.length === 0 ? (
                                <div className="empty">尚未选择任何地区</div>
                            ) : draft.map(v => (
                                <div key={v.code} className="rp-selected-row">
                                    <span className="level-pill">{LEVEL_LABEL[v.level] ?? v.level}</span>
                                    <span className="name" title={v.code}>{v.name}</span>
                                    <button
                                        type="button"
                                        className="remove"
                                        onClick={() => deselectRegion(v.code)}
                                        aria-label={`移除 ${v.name}`}
                                    >×</button>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                <div className="rp-foot">
                    <span className="summary">
                        {draft.length === 0 ? (
                            '尚未选择'
                        ) : (
                            <>
                                共 <b style={{ color: 'var(--text)' }}>{draft.length}</b> 个 ·
                                {tagsByLevel.province > 0 && <> 省 {tagsByLevel.province}</>}
                                {tagsByLevel.city > 0 && <> · 市 {tagsByLevel.city}</>}
                                {tagsByLevel.district > 0 && <> · 区 {tagsByLevel.district}</>}
                            </>
                        )}
                    </span>
                    <span className="spacer" />
                    <button type="button" className="btn ghost" onClick={onCancel}>取消</button>
                    <button type="button" className="btn primary" onClick={() => onConfirm(draft)}>
                        <GcIcon name="check" size={12} />确定
                    </button>
                </div>
            </div>
        </div>
    )

    return createPortal(node, document.body)
}
