import { useEffect } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import { invoke } from '@tauri-apps/api/core'

const TRANSPARENT_1X1 =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII='

const prefetched = new Set<string>()
const prefetchQueue: Array<{ z: number; x: number; y: number }> = []
let prefetchPumping = false

function pumpPrefetch() {
    if (prefetchPumping) return
    prefetchPumping = true
    const step = () => {
        const job = prefetchQueue.shift()
        if (!job) { prefetchPumping = false; return }
        invoke('cached_osm_tile', job).catch(() => { /* swallow */ }).finally(() => {
            // Throttle so prefetch never starves the foreground load.
            if (typeof requestIdleCallback === 'function') {
                requestIdleCallback(step, { timeout: 200 })
            } else {
                setTimeout(step, 60)
            }
        })
    }
    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(step, { timeout: 300 })
    } else {
        setTimeout(step, 60)
    }
}

function schedulePrefetch(z: number, x: number, y: number) {
    if (z < 4 || z > 18) return
    const limit = 1 << z
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue
            const nx = x + dx, ny = y + dy
            if (nx < 0 || ny < 0 || nx >= limit || ny >= limit) continue
            const key = `${z}/${nx}/${ny}`
            if (prefetched.has(key)) continue
            prefetched.add(key)
            prefetchQueue.push({ z, x: nx, y: ny })
        }
    }
    pumpPrefetch()
}

const CachedOsmLayer = L.TileLayer.extend({
    createTile: function (
        coords: L.Coords,
        done: (err: Error | null, tile: HTMLImageElement) => void,
    ): HTMLImageElement {
        const img = document.createElement('img')
        img.setAttribute('role', 'presentation')
        img.alt = ''

        const { x, y, z } = coords
        const key = `${z}/${x}/${y}`
        prefetched.add(key) // 自身也算已知

        invoke<string>('cached_osm_tile', { z, x, y })
            .then((b64) => {
                img.src = b64 ? `data:image/png;base64,${b64}` : TRANSPARENT_1X1
                done(null, img)
                // 主瓦片到位后再排预取，避免抢带宽
                schedulePrefetch(z, x, y)
            })
            .catch((e) => {
                console.warn('tile fetch failed', e)
                img.src = TRANSPARENT_1X1
                done(null, img)
            })

        return img
    },
})

/** React-leaflet wrapper component. */
export function CachedOsmTileLayer() {
    const map = useMap()
    useEffect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const layer = new (CachedOsmLayer as any)(undefined, {
            maxZoom: 19,
            attribution: '© OpenStreetMap',
        }) as L.TileLayer
        layer.addTo(map)
        return () => {
            layer.remove()
        }
    }, [map])
    return null
}
