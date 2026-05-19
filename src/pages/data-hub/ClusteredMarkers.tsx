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
    /** HTML 字符串；非空时点击 marker 会弹出详情气泡。 */
    popupHtml?: string
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
    const pendingRef = useRef<{
        points: ClusterPoint[]
        activeKey: string | number | null
    } | null>(null)
    const movingRef = useRef(false)

    // Create the cluster group once.  Also wire pan/zoom suspension so heavy
    // diff work is skipped while the user is actively dragging or zooming.
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
            animate: false,
            animateAddingMarkers: false,
            removeOutsideVisibleBounds: true,
        }) as L.MarkerClusterGroup
        groupRef.current = group
        map.addLayer(group)

        const onMoveStart = () => { movingRef.current = true }
        const onMoveEnd = () => {
            movingRef.current = false
            if (pendingRef.current) {
                const { points: p, activeKey: a } = pendingRef.current
                pendingRef.current = null
                applyDiff(p, a)
            }
        }
        map.on('movestart', onMoveStart)
        map.on('zoomstart', onMoveStart)
        map.on('moveend', onMoveEnd)
        map.on('zoomend', onMoveEnd)

        return () => {
            map.off('movestart', onMoveStart)
            map.off('zoomstart', onMoveStart)
            map.off('moveend', onMoveEnd)
            map.off('zoomend', onMoveEnd)
            map.removeLayer(group)
            groupRef.current = null
            markersRef.current.clear()
            pendingRef.current = null
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [map])

    // The diff routine — extracted so moveend can replay queued updates.
    const applyDiff = (pts: ClusterPoint[], active: string | number | null) => {
        const group = groupRef.current
        if (!group) return

        const incomingKeys = new Set<string | number>()
        const toAdd: L.Marker[] = []

        for (let i = 0; i < pts.length; i++) {
            const p = pts[i]
            incomingKeys.add(p.key)
            const existing = markersRef.current.get(p.key)
            const isActive = p.key === active
            if (existing) {
                const wasActive = (existing.options as { _active?: boolean })._active === true
                if (wasActive !== isActive) {
                    existing.setIcon(buildIcon(p.label ?? i + 1, p.platform, isActive))
                    ;(existing.options as { _active?: boolean })._active = isActive
                }
                // 弹窗 HTML 可能因为搜索/翻页变了，按需更新
                if (p.popupHtml && existing.getPopup()?.getContent() !== p.popupHtml) {
                    existing.bindPopup(p.popupHtml, { maxWidth: 320, autoPan: false })
                }
            } else {
                const marker = L.marker([p.lat, p.lon], {
                    icon: buildIcon(p.label ?? i + 1, p.platform, isActive),
                })
                ;(marker.options as { _active?: boolean })._active = isActive
                if (p.popupHtml) {
                    marker.bindPopup(p.popupHtml, { maxWidth: 320, autoPan: false })
                }
                marker.on('click', () => onSelectRef.current(p.key))
                markersRef.current.set(p.key, marker)
                toAdd.push(marker)
            }
        }

        const toRemove: L.Marker[] = []
        markersRef.current.forEach((m, k) => {
            if (!incomingKeys.has(k)) {
                toRemove.push(m)
                markersRef.current.delete(k)
            }
        })

        if (toRemove.length > 0) group.removeLayers(toRemove)
        if (toAdd.length > 0) group.addLayers(toAdd)
    }

    // Apply (or queue) diff when inputs change.
    useEffect(() => {
        if (movingRef.current) {
            pendingRef.current = { points, activeKey }
            return
        }
        applyDiff(points, activeKey)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [points, activeKey])

    return null
}
