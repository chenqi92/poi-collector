import { useEffect } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import { invoke } from '@tauri-apps/api/core'

/**
 * Leaflet TileLayer subclass that asks the Rust side for each tile.  The Rust
 * command (`cached_osm_tile`) serves from a local on-disk cache and falls back
 * to fetching from the public OSM endpoint, so subsequent visits to the same
 * area are instant and work offline.
 */
const CachedOsmLayer = L.TileLayer.extend({
    createTile: function (
        coords: L.Coords,
        done: (err: Error | null, tile: HTMLImageElement) => void,
    ): HTMLImageElement {
        const img = document.createElement('img')
        img.setAttribute('role', 'presentation')
        img.alt = ''

        const { x, y, z } = coords

        invoke<string>('cached_osm_tile', { z, x, y })
            .then((b64) => {
                if (b64) {
                    img.src = `data:image/png;base64,${b64}`
                    // 1×1 transparent fallback for empty cache returns.
                } else {
                    img.src =
                        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII='
                }
                done(null, img)
            })
            .catch((e) => {
                console.warn('tile fetch failed', e)
                img.src =
                    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII='
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
