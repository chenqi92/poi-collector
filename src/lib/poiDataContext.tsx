import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react'
import { Channel, invoke } from '@tauri-apps/api/core'

/* Shared "all data" cache.  Used by Browse / Export / Dashboard so the 23k
   POI list and the buoy list are pulled from the backend at most once.  Data
   arrives in batches via a Tauri Channel — consumers can render partial
   results while loading. */

export interface FullPOI {
    id: number
    name: string
    lon: number
    lat: number
    address: string
    phone: string
    category: string
    platform: string
    region_code: string
    /** Lowercased "name|address|category" concatenation for cheap substring search. */
    _search: string
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
    _search: string
}

function poiSearchKey(p: { name?: string; address?: string; category?: string }): string {
    return `${p.name ?? ''}|${p.address ?? ''}|${p.category ?? ''}`.toLowerCase()
}

function buoySearchKey(b: {
    id?: string; name?: string | null; waterway?: string | null;
    region?: string | null; shape?: string | null; buoy_type?: string | null
}): string {
    return `${b.id ?? ''}|${b.name ?? ''}|${b.waterway ?? ''}|${b.region ?? ''}|${b.shape ?? ''}|${b.buoy_type ?? ''}`.toLowerCase()
}

interface DataSlice<T> {
    items: T[]
    loaded: number
    total: number
    loading: boolean
    error: string | null
    /** Force a fresh stream-reload. */
    refresh: () => void
}

interface PoiDataContextValue {
    poi: DataSlice<FullPOI>
    buoy: DataSlice<FullBuoy>
}

const PoiDataContext = createContext<PoiDataContextValue | null>(null)

/** ~250ms between commits during streaming — coarser than the 80ms used before,
 *  which means 4-5 React renders for 23k rows instead of 15-20. */
const FLUSH_INTERVAL_MS = 250

function useStreamingSlice<TRaw, TItem extends { _search: string }>(
    command: string,
    enrich: (raw: TRaw) => TItem,
): DataSlice<TItem> {
    const [items, setItems] = useState<TItem[]>([])
    const [loaded, setLoaded] = useState(0)
    const [total, setTotal] = useState(0)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [tick, setTick] = useState(0)
    const seqRef = useRef(0)

    useEffect(() => {
        const seq = ++seqRef.current
        setLoading(true)
        setError(null)
        const buffer: TItem[] = []
        let lastFlush = performance.now()

        const flush = (finalize: boolean) => {
            const snapshot = buffer.slice()
            setItems(snapshot)
            setLoaded(snapshot.length)
            if (finalize) setLoading(false)
        }

        const channel = new Channel<{ items: TRaw[]; done: boolean; total: number }>()
        channel.onmessage = (batch) => {
            if (seq !== seqRef.current) return
            for (const raw of batch.items) buffer.push(enrich(raw))
            const now = performance.now()
            if (batch.done) {
                if (batch.total > 0) setTotal(batch.total)
                flush(true)
            } else if (now - lastFlush > FLUSH_INTERVAL_MS) {
                lastFlush = now
                if (batch.total > 0) setTotal(batch.total)
                flush(false)
            }
        }

        invoke(command, { onEvent: channel, batchSize: 5000 }).catch((e) => {
            if (seq !== seqRef.current) return
            setError(String(e))
            setLoading(false)
        })

        return () => { /* future calls bump seq; old batches ignored above */ }
    }, [command, tick, enrich])

    const refresh = useCallback(() => setTick(t => t + 1), [])

    return { items, loaded, total, loading, error, refresh }
}

const enrichPoi = (raw: Omit<FullPOI, '_search'>): FullPOI => ({
    ...raw,
    _search: poiSearchKey(raw),
})

const enrichBuoy = (raw: Omit<FullBuoy, '_search'>): FullBuoy => ({
    ...raw,
    _search: buoySearchKey(raw),
})

export function PoiDataProvider({ children }: { children: ReactNode }) {
    const poi = useStreamingSlice<Omit<FullPOI, '_search'>, FullPOI>('stream_all_poi', enrichPoi)
    const buoy = useStreamingSlice<Omit<FullBuoy, '_search'>, FullBuoy>('chart_stream_all_buoys', enrichBuoy)

    const value = useMemo<PoiDataContextValue>(() => ({ poi, buoy }), [poi, buoy])

    return <PoiDataContext.Provider value={value}>{children}</PoiDataContext.Provider>
}

export function usePoiData() {
    const ctx = useContext(PoiDataContext)
    if (!ctx) throw new Error('usePoiData must be used inside PoiDataProvider')
    return ctx
}
