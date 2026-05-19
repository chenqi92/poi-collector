import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

/* Server-side filtered & paginated POI search.  All work happens in SQLite
   (FTS5 trigram for text, indexed range for bounds) so the frontend never
   holds more than the visible page in memory. */

export interface POI {
    id: number
    name: string
    lon: number
    lat: number
    address: string
    phone: string
    category: string
    platform: string
    region_code: string
}

export interface FullBuoy {
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

export interface BoundsArg {
    south: number
    west: number
    north: number
    east: number
}

export interface PoiSearchFilters {
    query?: string | null
    platforms?: string[]
    bounds?: BoundsArg | null
    region_codes?: string[]
}

export interface Pagination {
    limit: number
    offset: number
}

export interface PoiPage {
    items: POI[]
    total: number
}

export interface DataExtent extends BoundsArg {}

interface UseSearchPoisResult {
    items: POI[]
    total: number
    loading: boolean
    error: string | null
}

/**
 * Invokes `search_pois` whenever filters or pagination change.  Cancels stale
 * requests via a sequence counter — the latest request always wins.
 */
export function useSearchPois(
    filters: PoiSearchFilters,
    pagination: Pagination,
): UseSearchPoisResult {
    const [items, setItems] = useState<POI[]>([])
    const [total, setTotal] = useState(0)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const seqRef = useRef(0)

    // Stringify for stable dep — filters / pagination are plain objects.
    const fKey = JSON.stringify(filters)
    const pKey = `${pagination.limit}|${pagination.offset}`

    useEffect(() => {
        const seq = ++seqRef.current
        setLoading(true)
        setError(null)
        invoke<PoiPage>('search_pois', { filters, pagination })
            .then((page) => {
                if (seq !== seqRef.current) return
                setItems(page.items)
                setTotal(page.total)
                setLoading(false)
            })
            .catch((e) => {
                if (seq !== seqRef.current) return
                setError(String(e))
                setLoading(false)
            })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fKey, pKey])

    return { items, total, loading, error }
}

/** Cache the data extent per-platform-set; the call is cheap but avoids a
 *  network round-trip on every dataType toggle. */
const extentCache = new Map<string, DataExtent | null>()

export async function fetchPoiExtent(platforms?: string[]): Promise<DataExtent | null> {
    const key = platforms ? platforms.slice().sort().join(',') : ''
    if (extentCache.has(key)) return extentCache.get(key) ?? null
    const r = await invoke<DataExtent | null>('get_poi_data_extent', {
        platforms: platforms ?? null,
    })
    extentCache.set(key, r)
    return r
}

export async function fetchBuoyExtent(): Promise<DataExtent | null> {
    const key = '__buoy__'
    if (extentCache.has(key)) return extentCache.get(key) ?? null
    const r = await invoke<DataExtent | null>('chart_get_buoy_extent')
    extentCache.set(key, r)
    return r
}

/* Buoy data is small (a few thousand rows max) — keep a simple module-level
   cache that all consumers share, avoiding the streaming context for it. */
let buoyCache: { items: FullBuoy[]; loadedAt: number } | null = null
let buoyPromise: Promise<FullBuoy[]> | null = null

export async function fetchAllBuoys(force = false): Promise<FullBuoy[]> {
    if (!force && buoyCache) return buoyCache.items
    if (buoyPromise) return buoyPromise
    buoyPromise = invoke<FullBuoy[]>('chart_get_all_buoys')
        .then((items) => {
            buoyCache = { items, loadedAt: Date.now() }
            buoyPromise = null
            return items
        })
        .catch((e) => {
            buoyPromise = null
            throw e
        })
    return buoyPromise
}

export function useAllBuoys(): { items: FullBuoy[]; loading: boolean; error: string | null } {
    const [items, setItems] = useState<FullBuoy[]>(() => buoyCache?.items ?? [])
    const [loading, setLoading] = useState(!buoyCache)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false
        if (buoyCache) {
            setItems(buoyCache.items)
            setLoading(false)
            return
        }
        fetchAllBuoys()
            .then((all) => { if (!cancelled) { setItems(all); setLoading(false) } })
            .catch((e) => { if (!cancelled) { setError(String(e)); setLoading(false) } })
        return () => { cancelled = true }
    }, [])

    return { items, loading, error }
}
