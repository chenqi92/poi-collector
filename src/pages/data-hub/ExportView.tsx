import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { GcIcon, PlatformBadge } from '@/components/shell'
import { useToast } from '@/components/ui/toast'
import {
    useSearchPois,
    useAllBuoys,
    type PoiSearchFilters,
    type POI,
} from '@/lib/searchHooks'

type DataType = 'poi' | 'buoy' | 'boundary' | 'chartFeature'
type Format = 'csv' | 'json' | 'mysql' | 'excel' | 'geojson'

interface Region {
    code: string
    name: string
    level: string
    parent_code: string | null
}

type ExportPOI = POI

interface RegionBounds {
    north: number
    south: number
    east: number
    west: number
}

interface BoundarySummary {
    code: string
    name: string
    level: string
    bounds: RegionBounds
    feature_count: number
    polygon_count: number
    ring_count: number
    point_count: number
}

interface BuoyInfo {
    id: string
    name: string | null
    lon_84: number | null
    lat_84: number | null
    buoy_type: string | null
    color: string | null
    waterway: string | null
    shape: string | null
    light_info: string | null
    region: string | null
}

interface ChartFeatureStatRow {
    layer: string
    layerLabel: string
    featureType: string
    count: number
}

interface ChartTaskLite {
    id: string
    name: string
    available_layers: string[]
    bounds_north: number
    bounds_south: number
    bounds_east: number
    bounds_west: number
}

const POI_FIELDS: { id: string; label: string }[] = [
    { id: 'id', label: 'ID' },
    { id: 'name', label: '名称' },
    { id: 'address', label: '地址' },
    { id: 'category', label: '类别' },
    { id: 'phone', label: '电话' },
    { id: 'lat', label: '纬度' },
    { id: 'lon', label: '经度' },
    { id: 'platform', label: '平台' },
    { id: 'region_code', label: '行政区码' },
]

const BUOY_FIELDS: { id: string; label: string }[] = [
    { id: 'id', label: '编号' },
    { id: 'name', label: '名称' },
    { id: 'waterway', label: '航道' },
    { id: 'region', label: '地区' },
    { id: 'lat_84', label: '纬度' },
    { id: 'lon_84', label: '经度' },
    { id: 'shape', label: '形状' },
    { id: 'light_info', label: '灯质' },
    { id: 'color', label: '颜色' },
    { id: 'buoy_type', label: '类型' },
]

const FORMATS: { id: Format; label: string; ext: string }[] = [
    { id: 'csv', label: 'CSV', ext: 'csv' },
    { id: 'json', label: 'JSON', ext: 'json' },
    { id: 'mysql', label: 'MySQL', ext: 'sql' },
    { id: 'excel', label: 'Excel', ext: 'xlsx' },
]

const BOUNDARY_FORMATS: { id: Format; label: string; ext: string }[] = [
    { id: 'geojson', label: 'GeoJSON', ext: 'geojson' },
    { id: 'json', label: 'JSON', ext: 'json' },
    { id: 'csv', label: 'CSV 坐标表', ext: 'csv' },
]

const CHART_FEATURE_FORMATS: { id: Format; label: string; ext: string }[] = [
    { id: 'geojson', label: 'GeoJSON', ext: 'geojson' },
    { id: 'json', label: 'JSON', ext: 'json' },
    { id: 'csv', label: 'CSV', ext: 'csv' },
    { id: 'mysql', label: 'MySQL', ext: 'sql' },
]

const CHART_FEATURE_LAYERS: { id: string; label: string; desc: string }[] = [
    { id: 'HYDRO_A', label: '水域面', desc: 'HYDRO_A 多边形' },
    { id: 'electronic_fence', label: '航道要素', desc: '电子围栏 / 报告线 / 卡口' },
]

const CHART_LAYER_LABEL_EXPORT: Record<string, string> = {
    yizhangtu: '航道图',
    cjshoudong: '水域',
    soundg: '水深',
    electronic_fence: '航道要素',
    HYDRO_A: '水域面',
}

const DEFAULT_POI_FIELDS = new Set(['id', 'name', 'address', 'category', 'lat', 'lon', 'platform'])
const DEFAULT_BUOY_FIELDS = new Set(['id', 'name', 'waterway', 'region', 'lat_84', 'lon_84', 'shape', 'light_info', 'color'])

const COUNTRY_REGION: Region = {
    code: '100000',
    name: '中国',
    level: 'country',
    parent_code: null,
}

const LEVEL_LABEL: Record<string, string> = {
    country: '国家',
    province: '省级',
    city: '市级',
    district: '区县',
}

interface RegionTreeNodeProps {
    region: Region
    selected: Set<string>
    expanded: Set<string>
    childrenMap: Record<string, Region[]>
    onToggleExpand: (code: string) => void
    onToggleSelect: (code: string) => void
    depth: number
}

function RegionTreeNode({
    region,
    selected,
    expanded,
    childrenMap,
    onToggleExpand,
    onToggleSelect,
    depth,
}: RegionTreeNodeProps) {
    const isOpen = expanded.has(region.code)
    const isSel = selected.has(region.code)
    const myChildren = childrenMap[region.code]
    // 省、市可下钻（子级懒加载），县为叶子。不能等子级加载完才显示箭头，
    // 否则永远点不开。
    const hasChildren = region.level !== 'district'
    return (
        <>
            <label
                className={`region-tree-item${depth > 0 ? ' child' : ''}${isSel ? ' active' : ''}`}
                style={{ paddingLeft: 8 + depth * 14 }}
            >
                {hasChildren ? (
                    <span
                        className="chevron"
                        onClick={e => { e.preventDefault(); onToggleExpand(region.code) }}
                    >
                        <GcIcon name={isOpen ? 'chevronDown' : 'chevronRight'} size={11} />
                    </span>
                ) : (
                    <span style={{ width: 12 }} />
                )}
                <span
                    style={{
                        width: 14, height: 14, borderRadius: 3,
                        border: '1px solid var(--border-2)',
                        background: isSel ? 'var(--accent)' : 'var(--panel)',
                        display: 'grid', placeItems: 'center', color: '#fff',
                        flexShrink: 0,
                    }}
                    onClick={e => { e.preventDefault(); onToggleSelect(region.code) }}
                >
                    {isSel && <GcIcon name="check" size={9} strokeWidth={2.5} />}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>{region.name}</span>
                <span
                    style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--text-4)' }}
                    className="mono"
                >
                    {region.code}
                </span>
            </label>
            {isOpen && myChildren?.map(c => (
                <RegionTreeNode
                    key={c.code}
                    region={c}
                    selected={selected}
                    expanded={expanded}
                    childrenMap={childrenMap}
                    onToggleExpand={onToggleExpand}
                    onToggleSelect={onToggleSelect}
                    depth={depth + 1}
                />
            ))}
        </>
    )
}

export function ExportView() {
    const { success, error: errorToast } = useToast()

    const [dataType, setDataType] = useState<DataType>('poi')
    const [provinces, setProvinces] = useState<Region[]>([])
    const [childrenMap, setChildrenMap] = useState<Record<string, Region[]>>({})
    const [regionMap, setRegionMap] = useState<Record<string, Region>>({
        [COUNTRY_REGION.code]: COUNTRY_REGION,
    })
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [expanded, setExpanded] = useState<Set<string>>(new Set())
    const [regionSearch, setRegionSearch] = useState('')
    const [regionSearchResults, setRegionSearchResults] = useState<Region[]>([])
    const [regionSearching, setRegionSearching] = useState(false)

    const [platform, setPlatform] = useState<string>('all')
    const [search, setSearch] = useState('')

    const [poiFields, setPoiFields] = useState<Set<string>>(new Set(DEFAULT_POI_FIELDS))
    const [buoyFields, setBuoyFields] = useState<Set<string>>(new Set(DEFAULT_BUOY_FIELDS))
    const [format, setFormat] = useState<Format>('csv')
    const [exporting, setExporting] = useState(false)
    const [chartFeatureLayers, setChartFeatureLayers] = useState<Set<string>>(
        () => new Set(CHART_FEATURE_LAYERS.map(layer => layer.id))
    )
    const [chartFeatureStatsRaw, setChartFeatureStatsRaw] = useState<[string, number][]>([])
    const [chartFeatureLoading, setChartFeatureLoading] = useState(false)
    const [outlineOnly, setOutlineOnly] = useState(false)
    // 航道图要素：按下载任务(区域)导出，而非行政区
    const [chartTasks, setChartTasks] = useState<ChartTaskLite[]>([])
    const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set())
    const [taskSearch, setTaskSearch] = useState('')
    const [includeBoundaryChildren, setIncludeBoundaryChildren] = useState(false)
    const [boundaryPreview, setBoundaryPreview] = useState<BoundarySummary[]>([])
    const [boundaryLoading, setBoundaryLoading] = useState(false)
    const [boundaryPreviewKey, setBoundaryPreviewKey] = useState('')

    useEffect(() => {
        invoke<Region[]>('get_provinces')
            .then(list => {
                setProvinces(list)
                setChildrenMap(prev => ({ ...prev, [COUNTRY_REGION.code]: list }))
                setRegionMap(prev => {
                    const next = { ...prev, [COUNTRY_REGION.code]: COUNTRY_REGION }
                    for (const r of list) next[r.code] = r
                    return next
                })
            })
            .catch(e => errorToast('加载省份失败', String(e)))
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        setChartFeatureLoading(true)
        invoke<[string, number][]>('chart_get_feature_stats')
            .then(setChartFeatureStatsRaw)
            .catch(() => setChartFeatureStatsRaw([]))
            .finally(() => setChartFeatureLoading(false))
    }, [])

    useEffect(() => {
        invoke<ChartTaskLite[]>('chart_get_display_tasks')
            .then(ts =>
                setChartTasks(
                    ts.filter(t => t.bounds_north > t.bounds_south && t.bounds_east > t.bounds_west),
                ),
            )
            .catch(() => setChartTasks([]))
    }, [])

    const toggleTask = (id: string) => {
        setSelectedTaskIds(prev => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id); else next.add(id)
            return next
        })
    }

    const selectedTasks = useMemo(
        () => chartTasks.filter(t => selectedTaskIds.has(t.id)),
        [chartTasks, selectedTaskIds],
    )

    // 所选任务区域的外接范围并集（用于过滤导出的要素）
    const selectedTaskBounds = useMemo<RegionBounds | null>(() => {
        if (selectedTasks.length === 0) return null
        return selectedTasks.reduce<RegionBounds>(
            (acc, t) => ({
                west: Math.min(acc.west, t.bounds_west),
                south: Math.min(acc.south, t.bounds_south),
                east: Math.max(acc.east, t.bounds_east),
                north: Math.max(acc.north, t.bounds_north),
            }),
            {
                west: selectedTasks[0].bounds_west,
                south: selectedTasks[0].bounds_south,
                east: selectedTasks[0].bounds_east,
                north: selectedTasks[0].bounds_north,
            },
        )
    }, [selectedTasks])

    const visibleChartTasks = useMemo(() => {
        const q = taskSearch.trim().toLowerCase()
        if (!q) return chartTasks
        return chartTasks.filter(t => (t.name || t.id).toLowerCase().includes(q))
    }, [chartTasks, taskSearch])

    const rememberRegions = (list: Region[]) => {
        setRegionMap(prev => {
            const next = { ...prev }
            for (const r of list) next[r.code] = r
            return next
        })
    }

    const loadChildren = async (code: string) => {
        if (childrenMap[code]) return
        if (code === COUNTRY_REGION.code) {
            setChildrenMap(prev => ({ ...prev, [COUNTRY_REGION.code]: provinces }))
            return
        }
        try {
            const list = await invoke<Region[]>('get_region_children', { parentCode: code })
            rememberRegions(list)
            setChildrenMap(prev => ({ ...prev, [code]: list }))
        } catch (e) { console.error(e) }
    }

    const onToggleExpand = async (code: string) => {
        if (expanded.has(code)) {
            setExpanded(s => { const n = new Set(s); n.delete(code); return n })
        } else {
            await loadChildren(code)
            setExpanded(s => new Set(s).add(code))
        }
    }

    const onToggleSelect = (code: string) => {
        setSelected(s => {
            if (dataType === 'boundary' && code === COUNTRY_REGION.code) {
                return s.has(code) ? new Set() : new Set([COUNTRY_REGION.code])
            }
            const n = new Set(s)
            if (n.has(code)) n.delete(code); else n.add(code)
            if (dataType === 'boundary') n.delete(COUNTRY_REGION.code)
            return n
        })
    }

    useEffect(() => {
        const q = regionSearch.trim()
        if (!q) {
            setRegionSearchResults([])
            setRegionSearching(false)
            return
        }
        let cancelled = false
        setRegionSearching(true)
        const t = setTimeout(() => {
            invoke<Region[]>('search_regions', { query: q })
                .then(list => {
                    if (cancelled) return
                    setRegionSearchResults(list)
                    rememberRegions(list)
                })
                .catch(() => {
                    if (!cancelled) setRegionSearchResults([])
                })
                .finally(() => {
                    if (!cancelled) setRegionSearching(false)
                })
        }, 180)
        return () => {
            cancelled = true
            clearTimeout(t)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [regionSearch])

    // One-time region_code fix on mount — backend ignores if up to date.
    useEffect(() => {
        invoke<[number, number]>('fix_region_codes').catch(() => { /* ignore */ })
    }, [])

    // 后端 region_codes 用前缀 LIKE 处理省/市/县三级，所以前端只要把用户勾选的
    // 原始 code 透传过去就行，不再需要把子节点都展平。
    const poiFilters = useMemo<PoiSearchFilters>(() => ({
        query: search.trim() || null,
        platforms: platform === 'all' ? [] : [platform],
        bounds: null,
        region_codes: selected.size > 0 ? Array.from(selected) : [],
    }), [search, platform, selected])

    const poiPreview = useSearchPois(poiFilters, { limit: 200, offset: 0 })
    const allBuoys = useAllBuoys()

    const selectedRegions = useMemo(() => (
        Array.from(selected)
            .map(code => regionMap[code])
            .filter((r): r is Region => !!r)
            .map(r => ({ code: r.code, name: r.name, level: r.level }))
    ), [selected, regionMap])

    const boundarySelectionKey = useMemo(() => (
        `${includeBoundaryChildren ? 'children' : 'outline'}:${selectedRegions.map(r => r.code).sort().join(',')}`
    ), [includeBoundaryChildren, selectedRegions])

    const filteredBuoys = useMemo<BuoyInfo[]>(() => {
        const q = search.trim().toLowerCase()
        if (!q) return allBuoys.items
        return allBuoys.items.filter(b => {
            const s = `${b.id ?? ''}|${b.name ?? ''}|${b.waterway ?? ''}|${b.region ?? ''}|${b.shape ?? ''}|${b.buoy_type ?? ''}`.toLowerCase()
            return s.includes(q)
        })
    }, [search, allBuoys.items])

    useEffect(() => {
        if (dataType === 'boundary' && !BOUNDARY_FORMATS.some(f => f.id === format)) {
            setFormat('geojson')
        } else if (dataType === 'chartFeature' && !CHART_FEATURE_FORMATS.some(f => f.id === format)) {
            setFormat('geojson')
        } else if (dataType !== 'boundary' && dataType !== 'chartFeature' && format === 'geojson') {
            setFormat('csv')
        }
        if (dataType !== 'boundary' && selected.has(COUNTRY_REGION.code)) {
            setSelected(prev => {
                const next = new Set(prev)
                next.delete(COUNTRY_REGION.code)
                return next
            })
        }
    }, [dataType, format])

    useEffect(() => {
        setBoundaryPreview([])
        setBoundaryPreviewKey('')
    }, [boundarySelectionKey])

    const chartFeatureStats = useMemo<ChartFeatureStatRow[]>(() => (
        chartFeatureStatsRaw.map(([key, count]) => {
            const [layer, ...rest] = String(key).split(':')
            const layerLabel = CHART_FEATURE_LAYERS.find(item => item.id === layer)?.label ?? layer
            return {
                layer,
                layerLabel,
                featureType: rest.join(':') || '未知',
                count,
            }
        })
    ), [chartFeatureStatsRaw])

    const chartFeatureLayerCounts = useMemo(() => {
        const out: Record<string, number> = {}
        for (const row of chartFeatureStats) {
            out[row.layer] = (out[row.layer] ?? 0) + row.count
        }
        return out
    }, [chartFeatureStats])

    const selectedChartFeatureLayers = useMemo(
        () => Array.from(chartFeatureLayers).filter(layer => CHART_FEATURE_LAYERS.some(item => item.id === layer)),
        [chartFeatureLayers]
    )

    const chartFeatureTotal = selectedChartFeatureLayers.reduce(
        (sum, layer) => sum + (chartFeatureLayerCounts[layer] ?? 0),
        0
    )

    const chartFeatureRows = chartFeatureStats.filter(row => chartFeatureLayers.has(row.layer))

    const toggleChartFeatureLayer = (id: string) => {
        setChartFeatureLayers(prev => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id); else next.add(id)
            return next
        })
    }

    const loading = dataType === 'poi'
        ? poiPreview.loading
        : dataType === 'buoy'
            ? allBuoys.loading
            : dataType === 'chartFeature'
                ? chartFeatureLoading
                : boundaryLoading

    const fieldsCur = dataType === 'poi' ? poiFields : buoyFields
    const toggleField = (id: string) => {
        const setter = dataType === 'poi' ? setPoiFields : setBuoyFields
        setter(s => {
            const n = new Set(s)
            if (n.has(id)) n.delete(id); else n.add(id)
            return n
        })
    }
    const FIELDS_CUR = dataType === 'poi' ? POI_FIELDS : BUOY_FIELDS
    const boundaryPointCount = boundaryPreview.reduce((n, r) => n + r.point_count, 0)
    const boundaryPreviewReady = boundaryPreview.length > 0 && boundaryPreviewKey === boundarySelectionKey
    const totalCount = dataType === 'poi'
        ? poiPreview.total
        : dataType === 'buoy'
            ? filteredBuoys.length
            : dataType === 'chartFeature'
                ? chartFeatureTotal
                : boundaryPointCount
    const previewRows = dataType === 'poi' ? poiPreview.items : filteredBuoys.slice(0, 200)

    const visibleProvinces = useMemo(() => {
        if (!regionSearch.trim()) return provinces
        const q = regionSearch.trim().toLowerCase()
        return provinces.filter(p =>
            p.name.toLowerCase().includes(q) || p.code.includes(q)
        )
    }, [provinces, regionSearch])

    const visibleRegionRoots = useMemo(() => (
        dataType === 'boundary' ? [COUNTRY_REGION] : visibleProvinces
    ), [dataType, visibleProvinces])

    const visibleRegionSearchResults = useMemo(() => {
        const q = regionSearch.trim().toLowerCase()
        const includeCountry = dataType === 'boundary'
            && !!q
            && (COUNTRY_REGION.name.toLowerCase().includes(q)
                || COUNTRY_REGION.code.includes(q)
                || COUNTRY_REGION.level.includes(q)
                || '国家'.includes(q)
                || '国别'.includes(q))
        if (!includeCountry) return regionSearchResults
        if (regionSearchResults.some(r => r.code === COUNTRY_REGION.code)) return regionSearchResults
        return [COUNTRY_REGION, ...regionSearchResults]
    }, [dataType, regionSearch, regionSearchResults])

    const loadBoundaryPreview = async () => {
        if (selectedRegions.length === 0) {
            errorToast('未选择区域', '请先在左侧选择国别 / 省 / 市 / 区')
            return
        }
        setBoundaryLoading(true)
        try {
            const rows = await invoke<BoundarySummary[]>('collect_region_boundaries', {
                regions: selectedRegions,
                includeChildren: includeBoundaryChildren,
            })
            setBoundaryPreview(rows)
            setBoundaryPreviewKey(boundarySelectionKey)
            success('边界已获取', `已加载 ${rows.length} 个区域边界`)
        } catch (e) {
            setBoundaryPreview([])
            setBoundaryPreviewKey('')
            errorToast('获取边界失败', String(e))
        } finally {
            setBoundaryLoading(false)
        }
    }

    const doExport = async () => {
        if (dataType === 'boundary') {
            if (selectedRegions.length === 0) {
                errorToast('未选择区域', '请先在左侧选择国别 / 省 / 市 / 区')
                return
            }
            const fmt = BOUNDARY_FORMATS.find(f => f.id === format) ?? BOUNDARY_FORMATS[0]
            try {
                const path = await save({
                    defaultPath: `boundary_${new Date().toISOString().split('T')[0]}.${fmt.ext}`,
                    filters: [{ name: fmt.label, extensions: [fmt.ext] }],
                })
                if (!path) return
                setExporting(true)
                const n = await invoke<number>('export_region_boundaries_to_file', {
                    path,
                    format: fmt.id,
                    regions: selectedRegions,
                    includeChildren: includeBoundaryChildren,
                })
                success('导出成功', `已导出 ${n.toLocaleString()} 个区域边界`)
            } catch (e) {
                errorToast('导出失败', String(e))
            } finally {
                setExporting(false)
            }
            return
        }

        if (dataType === 'chartFeature') {
            if (selectedChartFeatureLayers.length === 0) {
                errorToast('未选择图层', '请至少选择水域面或航道要素')
                return
            }
            if (chartFeatureTotal === 0) {
                errorToast('无数据', '没有可导出的航道图要素数据')
                return
            }
            const fmt = CHART_FEATURE_FORMATS.find(f => f.id === format) ?? CHART_FEATURE_FORMATS[0]
            const wantOutline = outlineOnly && chartFeatureLayers.has('HYDRO_A')
            try {
                const path = await save({
                    defaultPath: `${wantOutline ? 'water_outline' : 'chart_features'}_${new Date().toISOString().split('T')[0]}.${fmt.ext}`,
                    filters: [{ name: fmt.label, extensions: [fmt.ext] }],
                })
                if (!path) return
                setExporting(true)
                const bounds = selectedTaskBounds
                const params: Record<string, unknown> = {
                    format: fmt.id,
                    outputPath: path,
                    sourceLayers: selectedChartFeatureLayers,
                    outlineOnly: wantOutline,
                }
                if (bounds) {
                    params.west = bounds.west
                    params.south = bounds.south
                    params.east = bounds.east
                    params.north = bounds.north
                }
                const msg = await invoke<string>('chart_export_features', params)
                success('导出成功', msg)
            } catch (e) {
                errorToast('导出失败', String(e))
            } finally {
                setExporting(false)
            }
            return
        }

        if (totalCount === 0) {
            errorToast('无数据', '没有可导出的数据')
            return
        }
        const fmt = FORMATS.find(f => f.id === format)!
        try {
            const path = await save({
                defaultPath: `${dataType}_${new Date().toISOString().split('T')[0]}.${fmt.ext}`,
                filters: [{ name: fmt.label, extensions: [fmt.ext] }],
            })
            if (!path) return
            setExporting(true)
            if (dataType === 'poi') {
                const n = await invoke<number>('export_poi_to_file', {
                    path,
                    format,
                    filters: poiFilters,
                })
                success('导出成功', `已导出 ${n.toLocaleString()} 条 POI`)
            } else {
                const backendFormat = format === 'excel' ? 'csv' : format
                const msg = await invoke<string>('chart_export_buoys', {
                    format: backendFormat,
                    outputPath: path,
                })
                success('导出成功', msg)
            }
        } catch (e) {
            errorToast('导出失败', String(e))
        } finally {
            setExporting(false)
        }
    }

    return (
        <div className="flex h-full min-h-0 flex-col">
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
                <div className="seg">
                    <button
                        type="button"
                        className={dataType === 'poi' ? 'active' : ''}
                        onClick={() => setDataType('poi')}
                    >
                        <GcIcon name="mapPin" size={11} style={{ marginRight: 4, verticalAlign: '-1px' }} />
                        POI 兴趣点
                    </button>
                    <button
                        type="button"
                        className={dataType === 'buoy' ? 'active' : ''}
                        onClick={() => setDataType('buoy')}
                    >
                        <GcIcon name="navigation" size={11} style={{ marginRight: 4, verticalAlign: '-1px' }} />
                        航标
                    </button>
                    <button
                        type="button"
                        className={dataType === 'boundary' ? 'active' : ''}
                        onClick={() => { setDataType('boundary'); setFormat('geojson') }}
                    >
                        <GcIcon name="polygon" size={11} style={{ marginRight: 4, verticalAlign: '-1px' }} />
                        行政区边界
                    </button>
                    <button
                        type="button"
                        className={dataType === 'chartFeature' ? 'active' : ''}
                        onClick={() => { setDataType('chartFeature'); setFormat('geojson') }}
                    >
                        <GcIcon name="layers" size={11} style={{ marginRight: 4, verticalAlign: '-1px' }} />
                        航道图要素
                    </button>
                </div>
                <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--text-3)' }}>
                    {loading
                        ? '正在加载...'
                        : dataType === 'poi'
                            ? <>匹配 <b className="mono" style={{ color: 'var(--text)' }}>{poiPreview.total.toLocaleString()}</b> 条</>
                            : dataType === 'buoy'
                                ? <>航标共 <b className="mono" style={{ color: 'var(--text)' }}>{allBuoys.items.length.toLocaleString()}</b> 条</>
                                : dataType === 'chartFeature'
                                    ? <>航道图要素 <b className="mono" style={{ color: 'var(--text)' }}>{chartFeatureTotal.toLocaleString()}</b> 条</>
                                    : <>已选 <b className="mono" style={{ color: 'var(--text)' }}>{selectedRegions.length.toLocaleString()}</b> 个区域</>
                    }
                </span>
            </div>

            <div className="dh-export-layout">
                {/* Left side: chart tasks / region tree / buoy filter */}
                {dataType === 'chartFeature' ? (
                    <div className="dh-export-side">
                        <div className="panel-head">
                            <h3>下载任务</h3>
                            <span className="meta">
                                {selectedTaskIds.size > 0 ? `已选 ${selectedTaskIds.size}` : `共 ${chartTasks.length}`}
                            </span>
                            {selectedTaskIds.size > 0 && (
                                <div className="panel-head-actions">
                                    <button type="button" className="btn ghost sm" onClick={() => setSelectedTaskIds(new Set())}>
                                        清空
                                    </button>
                                </div>
                            )}
                        </div>
                        <div style={{ padding: '8px 10px' }}>
                            <input
                                className="input"
                                placeholder="搜索任务名..."
                                value={taskSearch}
                                onChange={e => setTaskSearch(e.target.value)}
                            />
                        </div>
                        <div
                            className="region-tree"
                            style={{ flex: 1, maxHeight: 'none', border: 0, borderRadius: 0, background: 'transparent', padding: '0 6px 8px', overflow: 'auto' }}
                        >
                            {chartTasks.length === 0 ? (
                                <div className="region-empty">没有下载任务（可在「新建采集」创建航道 / 水域任务）</div>
                            ) : visibleChartTasks.length === 0 ? (
                                <div className="region-empty">无匹配任务</div>
                            ) : (
                                visibleChartTasks.map(t => {
                                    const isSel = selectedTaskIds.has(t.id)
                                    return (
                                        <label
                                            key={t.id}
                                            className={`region-tree-item${isSel ? ' active' : ''}`}
                                            onClick={() => toggleTask(t.id)}
                                        >
                                            <span
                                                style={{ width: 14, height: 14, borderRadius: 3, border: '1px solid var(--border-2)', background: isSel ? 'var(--accent)' : 'var(--panel)', display: 'grid', placeItems: 'center', color: '#fff', flexShrink: 0 }}
                                            >
                                                {isSel && <GcIcon name="check" size={9} strokeWidth={2.5} />}
                                            </span>
                                            <span style={{ flex: 1, minWidth: 0 }}>{t.name || t.id}</span>
                                            <span style={{ color: 'var(--text-4)', fontSize: 10.5 }}>
                                                {(t.available_layers || []).map(l => CHART_LAYER_LABEL_EXPORT[l] ?? l).join('/')}
                                            </span>
                                        </label>
                                    )
                                })
                            )}
                        </div>
                        <div style={{ padding: '8px 12px', borderTop: '1px solid var(--hairline)', fontSize: 11, color: 'var(--text-3)' }}>
                            选中任务后，按其下载区域(外接范围)过滤导出要素；不选则导出全部已采要素。
                        </div>
                    </div>
                ) : dataType !== 'buoy' ? (
                    <div className="dh-export-side">
                        <div className="panel-head">
                            <h3>{dataType === 'boundary' ? '国别 / 行政区' : '地区'}</h3>
                            <span className="meta">
                                {selected.size > 0
                                    ? `已选 ${selected.size}`
                                    : dataType === 'boundary'
                                        ? `1 国 / ${provinces.length} 省`
                                        : `共 ${provinces.length} 省`}
                            </span>
                            {selected.size > 0 && (
                                <div className="panel-head-actions">
                                    <button
                                        type="button"
                                        className="btn ghost sm"
                                        onClick={() => setSelected(new Set())}
                                    >
                                        清空
                                    </button>
                                </div>
                            )}
                        </div>
                        <div style={{ padding: '8px 10px' }}>
                            <input
                                className="input"
                                placeholder={dataType === 'boundary' ? '搜索国别 / 省 / 市 / 区...' : '搜索省 / 市 / 区...'}
                                value={regionSearch}
                                onChange={e => setRegionSearch(e.target.value)}
                            />
                        </div>
                        <div
                            className="region-tree"
                            style={{
                                flex: 1,
                                maxHeight: 'none',
                                border: 0,
                                borderRadius: 0,
                                background: 'transparent',
                                padding: '0 6px 8px',
                                overflow: 'auto',
                            }}
                        >
                            {regionSearch.trim() ? (
                                regionSearching ? (
                                    <div className="region-empty">搜索中...</div>
                                ) : visibleRegionSearchResults.length === 0 ? (
                                    <div className="region-empty">未找到匹配的地区</div>
                                ) : (
                                    visibleRegionSearchResults.map(r => {
                                        const isSel = selected.has(r.code)
                                        return (
                                            <label
                                                key={r.code}
                                                className={`region-tree-item${isSel ? ' active' : ''}`}
                                                onClick={() => onToggleSelect(r.code)}
                                            >
                                                <span
                                                    style={{
                                                        width: 14, height: 14, borderRadius: 3,
                                                        border: '1px solid var(--border-2)',
                                                        background: isSel ? 'var(--accent)' : 'var(--panel)',
                                                        display: 'grid', placeItems: 'center', color: '#fff',
                                                        flexShrink: 0,
                                                    }}
                                                >
                                                    {isSel && <GcIcon name="check" size={9} strokeWidth={2.5} />}
                                                </span>
                                                <span style={{ flex: 1, minWidth: 0 }}>{r.name}</span>
                                                <span style={{ color: 'var(--text-4)', fontSize: 10.5 }}>
                                                    {LEVEL_LABEL[r.level] ?? r.level}
                                                </span>
                                                <span className="mono" style={{ color: 'var(--text-4)', fontSize: 10.5 }}>
                                                    {r.code}
                                                </span>
                                            </label>
                                        )
                                    })
                                )
                            ) : (
                                visibleRegionRoots.map(p => (
                                    <RegionTreeNode
                                        key={p.code}
                                        region={p}
                                        selected={selected}
                                        expanded={expanded}
                                        childrenMap={childrenMap}
                                        onToggleExpand={onToggleExpand}
                                        onToggleSelect={onToggleSelect}
                                        depth={0}
                                    />
                                ))
                            )}
                        </div>
                    </div>
                ) : (
                    <div className="dh-export-side">
                        <div className="panel-head">
                            <h3>航标筛选</h3>
                            <span className="meta">全部航道</span>
                        </div>
                        <div className="set-tip" style={{ margin: 14 }}>
                            <GcIcon name="alertTriangle" size={14} />
                            <div>航标暂只支持按航道 / 地区做关键词筛选。在右侧搜索栏输入即可。</div>
                        </div>
                    </div>
                )}

                {/* Main: data preview */}
                <div className="dh-export-main">
                    <div className="dh-export-toolbar">
                        {dataType === 'poi' && (
                            <select
                                className="select"
                                value={platform}
                                onChange={e => setPlatform(e.target.value)}
                                style={{ width: 130 }}
                            >
                                <option value="all">所有平台</option>
                                <option value="tianditu">天地图</option>
                                <option value="amap">高德</option>
                                <option value="baidu">百度</option>
                                <option value="osm">OSM</option>
                            </select>
                        )}
                        {dataType === 'poi' || dataType === 'buoy' ? (
                            <input
                                className="input"
                                placeholder={dataType === 'poi' ? '搜索名称 / 地址...' : '搜索名称 / 航道 / 地区...'}
                                style={{ flex: 1, maxWidth: 320 }}
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                            />
                        ) : dataType === 'chartFeature' ? (
                            <>
                                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                                    {CHART_FEATURE_LAYERS.map(layer => (
                                        <label
                                            key={layer.id}
                                            className="checkbox"
                                            style={{ height: 24 }}
                                            title={layer.desc}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={chartFeatureLayers.has(layer.id)}
                                                onChange={() => toggleChartFeatureLayer(layer.id)}
                                            />
                                            {layer.label}
                                            <span className="mono" style={{ marginLeft: 4, fontSize: 10, color: 'var(--text-3)' }}>
                                                {(chartFeatureLayerCounts[layer.id] ?? 0).toLocaleString()}
                                            </span>
                                        </label>
                                    ))}
                                </div>
                                {chartFeatureLayers.has('HYDRO_A') && (
                                    <span
                                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                                        title="水域面常是大大小小嵌套的多边形，只取最外层外环（去洞、去内层），导出干净的范围边框；航道要素不受影响"
                                    >
                                        <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>水域面</span>
                                        <div className="seg">
                                            <button
                                                type="button"
                                                className={!outlineOnly ? 'active' : ''}
                                                onClick={() => setOutlineOnly(false)}
                                            >
                                                完整面
                                            </button>
                                            <button
                                                type="button"
                                                className={outlineOnly ? 'active' : ''}
                                                onClick={() => setOutlineOnly(true)}
                                            >
                                                <GcIcon name="polygon" size={11} style={{ marginRight: 4, verticalAlign: '-1px' }} />
                                                只取最外层边框
                                            </button>
                                        </div>
                                    </span>
                                )}
                                <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                                    {selectedTasks.length > 0
                                        ? `按 ${selectedTasks.length} 个任务区域过滤导出`
                                        : '未选择任务时导出全部已采要素'}
                                </span>
                            </>
                        ) : (
                            <>
                                <div className="seg">
                                    <button
                                        type="button"
                                        className={!includeBoundaryChildren ? 'active' : ''}
                                        onClick={() => setIncludeBoundaryChildren(false)}
                                    >
                                        本级轮廓
                                    </button>
                                    <button
                                        type="button"
                                        className={includeBoundaryChildren ? 'active' : ''}
                                        onClick={() => setIncludeBoundaryChildren(true)}
                                    >
                                        含下级边界
                                    </button>
                                </div>
                                <button
                                    type="button"
                                    className="btn"
                                    onClick={loadBoundaryPreview}
                                    disabled={boundaryLoading || selectedRegions.length === 0}
                                >
                                    <GcIcon name="refresh" size={12} />
                                    {boundaryLoading ? '获取中...' : '获取边界预览'}
                                </button>
                            </>
                        )}
                        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                            <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                                {dataType === 'boundary' ? (
                                    <>
                                        {boundaryPreviewReady
                                            ? <>边界点 <b className="mono" style={{ color: 'var(--text)' }}>{boundaryPointCount.toLocaleString()}</b> 个</>
                                            : <>已选 <b className="mono" style={{ color: 'var(--text)' }}>{selectedRegions.length.toLocaleString()}</b> 个区域</>}
                                    </>
                                ) : dataType === 'chartFeature' ? (
                                    <>
                                        可导出 <b className="mono" style={{ color: 'var(--text)' }}>{chartFeatureTotal.toLocaleString()}</b> 条
                                    </>
                                ) : (
                                    <>
                                        匹配 <b className="mono" style={{ color: 'var(--text)' }}>{totalCount.toLocaleString()}</b> 条
                                        {previewRows.length < totalCount && (
                                            <span style={{ color: 'var(--text-4)' }}> · 仅预览前 200 条</span>
                                        )}
                                    </>
                                )}
                            </span>
                        </div>
                    </div>

                    <div className="dh-export-table-wrap">
                        {dataType === 'poi' ? (
                            <table className="table">
                                <thead>
                                    <tr>
                                        {poiFields.has('id') && <th style={{ width: 80 }}>ID</th>}
                                        {poiFields.has('name') && <th>名称</th>}
                                        {poiFields.has('address') && <th>地址</th>}
                                        {poiFields.has('category') && <th style={{ width: 90 }}>类别</th>}
                                        {poiFields.has('phone') && <th style={{ width: 120 }}>电话</th>}
                                        {poiFields.has('lat') && <th style={{ width: 90, textAlign: 'right' }}>纬度</th>}
                                        {poiFields.has('lon') && <th style={{ width: 90, textAlign: 'right' }}>经度</th>}
                                        {poiFields.has('platform') && <th style={{ width: 80 }}>平台</th>}
                                        {poiFields.has('region_code') && <th style={{ width: 80 }}>区码</th>}
                                    </tr>
                                </thead>
                                <tbody>
                                    {previewRows.length === 0 && (
                                        <tr>
                                            <td
                                                colSpan={poiFields.size}
                                                style={{ textAlign: 'center', padding: 40, color: 'var(--text-3)' }}
                                            >
                                                没有匹配的 POI
                                            </td>
                                        </tr>
                                    )}
                                    {(previewRows as ExportPOI[]).map(p => (
                                        <tr key={p.id}>
                                            {poiFields.has('id') && <td className="mono">{p.id}</td>}
                                            {poiFields.has('name') && <td style={{ color: 'var(--text)' }}>{p.name}</td>}
                                            {poiFields.has('address') && <td>{p.address}</td>}
                                            {poiFields.has('category') && <td>{p.category}</td>}
                                            {poiFields.has('phone') && <td className="mono">{p.phone}</td>}
                                            {poiFields.has('lat') && <td className="num mono">{p.lat.toFixed(4)}</td>}
                                            {poiFields.has('lon') && <td className="num mono">{p.lon.toFixed(4)}</td>}
                                            {poiFields.has('platform') && <td><PlatformBadge name={p.platform} /></td>}
                                            {poiFields.has('region_code') && <td className="mono">{p.region_code}</td>}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        ) : dataType === 'boundary' ? (
                            <table className="table">
                                <thead>
                                    <tr>
                                        <th>区域</th>
                                        <th style={{ width: 70 }}>层级</th>
                                        <th style={{ width: 90 }}>区码</th>
                                        <th style={{ width: 90, textAlign: 'right' }}>要素</th>
                                        <th style={{ width: 90, textAlign: 'right' }}>多边形</th>
                                        <th style={{ width: 90, textAlign: 'right' }}>环</th>
                                        <th style={{ width: 110, textAlign: 'right' }}>坐标点</th>
                                        <th style={{ width: 240 }}>外接范围</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {selectedRegions.length === 0 ? (
                                        <tr>
                                            <td colSpan={8} style={{ textAlign: 'center', padding: 40, color: 'var(--text-3)' }}>
                                                请先在左侧选择国别 / 省 / 市 / 区
                                            </td>
                                        </tr>
                                    ) : !boundaryPreviewReady ? (
                                        <tr>
                                            <td colSpan={8} style={{ textAlign: 'center', padding: 40, color: 'var(--text-3)' }}>
                                                已选择 {selectedRegions.length} 个区域，可直接导出，或先获取边界预览
                                            </td>
                                        </tr>
                                    ) : (
                                        boundaryPreview.map(row => (
                                            <tr key={row.code}>
                                                <td style={{ color: 'var(--text)' }}>{row.name}</td>
                                                <td>{LEVEL_LABEL[row.level] ?? row.level}</td>
                                                <td className="mono">{row.code}</td>
                                                <td className="num mono">{row.feature_count.toLocaleString()}</td>
                                                <td className="num mono">{row.polygon_count.toLocaleString()}</td>
                                                <td className="num mono">{row.ring_count.toLocaleString()}</td>
                                                <td className="num mono">{row.point_count.toLocaleString()}</td>
                                                <td className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)' }}>
                                                    W {row.bounds.west.toFixed(4)} · S {row.bounds.south.toFixed(4)}
                                                    {' / '}
                                                    E {row.bounds.east.toFixed(4)} · N {row.bounds.north.toFixed(4)}
                                                </td>
                                            </tr>
                                        ))
                                    )}
                                </tbody>
                            </table>
                        ) : dataType === 'chartFeature' ? (
                            <table className="table">
                                <thead>
                                    <tr>
                                        <th>图层</th>
                                        <th>要素类型</th>
                                        <th style={{ width: 120, textAlign: 'right' }}>数量</th>
                                        <th style={{ width: 220 }}>导出说明</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {chartFeatureRows.length === 0 ? (
                                        <tr>
                                            <td colSpan={4} style={{ textAlign: 'center', padding: 40, color: 'var(--text-3)' }}>
                                                {chartFeatureLoading ? '正在加载航道图要素统计...' : '没有可导出的水域面或航道要素'}
                                            </td>
                                        </tr>
                                    ) : (
                                        chartFeatureRows.map(row => {
                                            const isWaterOutline = row.layer === 'HYDRO_A' && outlineOnly
                                            return (
                                                <tr key={`${row.layer}:${row.featureType}`}>
                                                    <td style={{ color: 'var(--text)' }}>{row.layerLabel}</td>
                                                    <td>{row.featureType}</td>
                                                    <td className="num mono">{row.count.toLocaleString()}</td>
                                                    <td style={{ color: 'var(--text-3)' }}>
                                                        {isWaterOutline ? (
                                                            <span
                                                                style={{
                                                                    display: 'inline-flex',
                                                                    alignItems: 'center',
                                                                    gap: 4,
                                                                    color: 'var(--accent)',
                                                                    fontWeight: 600,
                                                                }}
                                                            >
                                                                <GcIcon name="polygon" size={11} />
                                                                只取最外层边框 · 去洞去内层
                                                            </span>
                                                        ) : selectedTasks.length > 0 ? (
                                                            `按 ${selectedTasks.length} 个任务区域粗筛`
                                                        ) : (
                                                            '导出全部已采集要素'
                                                        )}
                                                    </td>
                                                </tr>
                                            )
                                        })
                                    )}
                                </tbody>
                            </table>
                        ) : (
                            <table className="table">
                                <thead>
                                    <tr>
                                        {buoyFields.has('id') && <th style={{ width: 80 }}>编号</th>}
                                        {buoyFields.has('name') && <th>名称</th>}
                                        {buoyFields.has('waterway') && <th style={{ width: 110 }}>航道</th>}
                                        {buoyFields.has('region') && <th style={{ width: 130 }}>地区</th>}
                                        {buoyFields.has('lat_84') && <th style={{ width: 90, textAlign: 'right' }}>纬度</th>}
                                        {buoyFields.has('lon_84') && <th style={{ width: 90, textAlign: 'right' }}>经度</th>}
                                        {buoyFields.has('shape') && <th style={{ width: 80 }}>形状</th>}
                                        {buoyFields.has('light_info') && <th style={{ width: 130 }}>灯质</th>}
                                        {buoyFields.has('color') && <th style={{ width: 70 }}>颜色</th>}
                                        {buoyFields.has('buoy_type') && <th style={{ width: 90 }}>类型</th>}
                                    </tr>
                                </thead>
                                <tbody>
                                    {previewRows.length === 0 && (
                                        <tr>
                                            <td
                                                colSpan={buoyFields.size}
                                                style={{ textAlign: 'center', padding: 40, color: 'var(--text-3)' }}
                                            >
                                                没有匹配的航标
                                            </td>
                                        </tr>
                                    )}
                                    {(previewRows as BuoyInfo[]).map(b => (
                                        <tr key={b.id}>
                                            {buoyFields.has('id') && <td className="mono">{b.id}</td>}
                                            {buoyFields.has('name') && <td style={{ color: 'var(--text)' }}>{b.name ?? '—'}</td>}
                                            {buoyFields.has('waterway') && <td>{b.waterway ?? '—'}</td>}
                                            {buoyFields.has('region') && <td>{b.region ?? '—'}</td>}
                                            {buoyFields.has('lat_84') && (
                                                <td className="num mono">
                                                    {b.lat_84 != null ? b.lat_84.toFixed(4) : '—'}
                                                </td>
                                            )}
                                            {buoyFields.has('lon_84') && (
                                                <td className="num mono">
                                                    {b.lon_84 != null ? b.lon_84.toFixed(4) : '—'}
                                                </td>
                                            )}
                                            {buoyFields.has('shape') && <td>{b.shape ?? '—'}</td>}
                                            {buoyFields.has('light_info') && <td>{b.light_info ?? '—'}</td>}
                                            {buoyFields.has('color') && <td>{b.color ?? '—'}</td>}
                                            {buoyFields.has('buoy_type') && <td>{b.buoy_type ?? '—'}</td>}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>

                    {/* Field chips */}
                    {(dataType === 'poi' || dataType === 'buoy') && (
                        <div
                            style={{
                                borderTop: '1px solid var(--hairline)',
                                background: 'var(--panel-2)',
                                padding: '12px 16px',
                            }}
                        >
                            <div className="section-head" style={{ marginBottom: 8 }}>
                                <h2>导出字段</h2>
                                <span className="section-link">
                                    <b className="mono" style={{ color: 'var(--text)' }}>{fieldsCur.size}</b>
                                    {' '}/ {FIELDS_CUR.length} 个字段
                                </span>
                            </div>
                            <div className="field-chips">
                                {FIELDS_CUR.map(f => (
                                    <button
                                        key={f.id}
                                        type="button"
                                        className={`field-chip${fieldsCur.has(f.id) ? ' on' : ''}`}
                                        onClick={() => toggleField(f.id)}
                                    >
                                        {fieldsCur.has(f.id) && <GcIcon name="check" size={10} strokeWidth={2.5} />}
                                        {f.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Footer: format + export */}
                    <div className="dh-export-foot">
                        <span>格式:</span>
                        <div className="seg">
                            {(dataType === 'boundary'
                                ? BOUNDARY_FORMATS
                                : dataType === 'chartFeature'
                                    ? CHART_FEATURE_FORMATS
                                    : FORMATS.filter(f => dataType === 'poi' || f.id !== 'mysql'))
                                .map(f => (
                                    <button
                                        key={f.id}
                                        type="button"
                                        className={format === f.id ? 'active' : ''}
                                        onClick={() => setFormat(f.id)}
                                    >
                                        {f.label}
                                    </button>
                                ))}
                        </div>
                        <span style={{ marginLeft: 14 }} className="mono">
                            {dataType === 'boundary'
                                ? boundaryPreviewReady
                                    ? `${boundaryPreview.length} 个区域 · ${boundaryPointCount.toLocaleString()} 个坐标点`
                                    : `${selectedRegions.length} 个区域 · 导出时获取完整边界`
                                : dataType === 'chartFeature'
                                    ? `${selectedChartFeatureLayers.length} 个图层 · ${chartFeatureTotal.toLocaleString()} 条要素${outlineOnly && chartFeatureLayers.has('HYDRO_A') ? ' · 水域面收敛为最外层边框（实际更少）' : ''}`
                                    : `≈ ${((totalCount * fieldsCur.size * 0.05) || 0).toFixed(1)} KB · ${fieldsCur.size} 列 × ${totalCount} 行`}
                        </span>
                        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                            <button
                                type="button"
                                className="btn primary"
                                onClick={doExport}
                                disabled={exporting || (dataType === 'boundary'
                                    ? selectedRegions.length === 0
                                    : dataType === 'chartFeature'
                                        ? selectedChartFeatureLayers.length === 0 || chartFeatureTotal === 0
                                        : totalCount === 0)}
                            >
                                <GcIcon name="download" size={13} />
                                {exporting ? '导出中...' : '导出到磁盘...'}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}
