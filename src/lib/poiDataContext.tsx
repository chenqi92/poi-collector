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

interface PoiBatchPayload { items: FullPOI[]; done: boolean; total: number }
interface BuoyBatchPayload { items: FullBuoy[]; done: boolean; total: number }

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

function useStreamingSlice<TBatch extends { items: TItem[]; done: boolean; total: number }, TItem>(
    command: string,
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

        const channel = new Channel<TBatch>()
        channel.onmessage = (batch) => {
            if (seq !== seqRef.current) return
            if (batch.items.length > 0) buffer.push(...batch.items)
            // Coalesce React updates: flush at most every ~80ms, or at end.
            const now = performance.now()
            if (batch.done || now - lastFlush > 80) {
                lastFlush = now
                const snapshot = buffer.slice()
                setItems(snapshot)
                setLoaded(snapshot.length)
                if (batch.total > 0) setTotal(batch.total)
                if (batch.done) setLoading(false)
            }
        }

        invoke(command, { onEvent: channel }).catch((e) => {
            if (seq !== seqRef.current) return
            setError(String(e))
            setLoading(false)
        })

        return () => { /* future calls bump seq; old batches ignored above */ }
    }, [command, tick])

    const refresh = useCallback(() => setTick(t => t + 1), [])

    return { items, loaded, total, loading, error, refresh }
}

export function PoiDataProvider({ children }: { children: ReactNode }) {
    const poi = useStreamingSlice<PoiBatchPayload, FullPOI>('stream_all_poi')
    const buoy = useStreamingSlice<BuoyBatchPayload, FullBuoy>('chart_stream_all_buoys')

    const value = useMemo<PoiDataContextValue>(() => ({ poi, buoy }), [poi, buoy])

    return <PoiDataContext.Provider value={value}>{children}</PoiDataContext.Provider>
}

export function usePoiData() {
    const ctx = useContext(PoiDataContext)
    if (!ctx) throw new Error('usePoiData must be used inside PoiDataProvider')
    return ctx
}
