import { useEffect, useRef } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet.markercluster'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'

export interface ClusterPoint {
    key: string | number
    lat: number
    lon: number
    /** Platform tag drives marker color via CSS class .pf-<platform>. */
    platform: string
    label?: string | number
}

interface ClusteredMarkersProps {
    points: ClusterPoint[]
    activeKey: string | number | null
    onSelect: (key: string | number) => void
}

function buildIcon(label: string | number, platform: string, active: boolean): L.DivIcon {
    return L.divIcon({
        html: `<div class="gc-marker pf-${platform}${active ? ' active' : ''}">${label}</div>`,
        className: '',
        iconSize: [22, 22],
        iconAnchor: [11, 11],
    })
}

export function ClusteredMarkers({ points, activeKey, onSelect }: ClusteredMarkersProps) {
    const map = useMap()
    const groupRef = useRef<L.MarkerClusterGroup | null>(null)
    const markersRef = useRef<Map<string | number, L.Marker>>(new Map())
    const onSelectRef = useRef(onSelect)
    onSelectRef.current = onSelect

    // Create the cluster group once.
    useEffect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const group = (L as any).markerClusterGroup({
            chunkedLoading: true,
            chunkInterval: 80,
            chunkDelay: 30,
            showCoverageOnHover: false,
            spiderfyOnMaxZoom: true,
            disableClusteringAtZoom: 17,
            maxClusterRadius: 60,
        }) as L.MarkerClusterGroup
        groupRef.current = group
        map.addLayer(group)
        return () => {
            map.removeLayer(group)
            groupRef.current = null
            markersRef.current.clear()
        }
    }, [map])

    // Diff markers when points or activeKey changes.
    useEffect(() => {
        const group = groupRef.current
        if (!group) return

        const incomingKeys = new Set<string | number>()
        const toAdd: L.Marker[] = []

        for (let i = 0; i < points.length; i++) {
            const p = points[i]
            incomingKeys.add(p.key)
            const existing = markersRef.current.get(p.key)
            const isActive = p.key === activeKey
            if (existing) {
                // Only swap icon when active state flips — avoids DOM churn.
                const wasActive = (existing.options as { _active?: boolean })._active === true
                if (wasActive !== isActive) {
                    existing.setIcon(buildIcon(p.label ?? i + 1, p.platform, isActive))
                    ;(existing.options as { _active?: boolean })._active = isActive
                }
            } else {
                const marker = L.marker([p.lat, p.lon], {
                    icon: buildIcon(p.label ?? i + 1, p.platform, isActive),
                })
                ;(marker.options as { _active?: boolean })._active = isActive
                marker.on('click', () => onSelectRef.current(p.key))
                markersRef.current.set(p.key, marker)
                toAdd.push(marker)
            }
        }

        // Remove markers that are no longer in the set.
        const toRemove: L.Marker[] = []
        markersRef.current.forEach((m, k) => {
            if (!incomingKeys.has(k)) {
                toRemove.push(m)
                markersRef.current.delete(k)
            }
        })

        if (toRemove.length > 0) group.removeLayers(toRemove)
        if (toAdd.length > 0) group.addLayers(toAdd)
    }, [points, activeKey])

    return null
}
