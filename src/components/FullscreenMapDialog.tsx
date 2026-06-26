import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { MapContainer, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

import { DrawPolygon, Bounds } from './DrawPolygon'
import { MapSearchBox } from './MapSearchBox'
import { TilePreviewLayer } from './TilePreviewLayer'
import { RegionBoundary } from './RegionBoundary'
import { BaseMapLayer, BaseMapSwitcher } from './BaseMap'
import { BaseMapType } from '@/lib/baseMaps'
import { Map as MapIcon, Square, MapPin, Trash2, Check, X, Pencil, Hand } from 'lucide-react'

import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({
    iconUrl: markerIcon,
    iconRetinaUrl: markerIcon2x,
    shadowUrl: markerShadow,
})

interface FullscreenMapDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    platform: string
    mapType: string
    apiKey?: string
    minZoom?: number
    maxZoom?: number
    initialBounds: Bounds
    onConfirm: (bounds: Bounds) => void
    selectedRegionCode?: string | null
    selectionMode: 'draw' | 'region'
    onSelectionModeChange: (mode: 'draw' | 'region') => void
    baseMapType?: BaseMapType
    onBaseMapTypeChange?: (type: BaseMapType) => void
}

function ResizeHandler() {
    const map = useMap()
    useEffect(() => {
        const handleResize = () => { setTimeout(() => map.invalidateSize(), 100) }
        window.addEventListener('resize', handleResize)
        const container = map.getContainer()
        const resizeObserver = new ResizeObserver(() => map.invalidateSize())
        resizeObserver.observe(container)
        setTimeout(() => map.invalidateSize(), 300)
        return () => {
            window.removeEventListener('resize', handleResize)
            resizeObserver.disconnect()
        }
    }, [map])
    return null
}

function BoundsFitter({ bounds, shouldFit }: { bounds: Bounds; shouldFit: boolean }) {
    const map = useMap()
    useEffect(() => {
        if (!shouldFit) return
        if (bounds.north > bounds.south && bounds.east > bounds.west) {
            const latLngBounds = L.latLngBounds(
                [bounds.south, bounds.west],
                [bounds.north, bounds.east]
            )
            map.fitBounds(latLngBounds, { padding: [50, 50] })
        }
    }, [map, bounds, shouldFit])
    return null
}

function MapSearchWrapper() {
    return (
        <div className="fm-search">
            <MapSearchBox placeholder="搜索地点定位..." />
        </div>
    )
}

function ZoomBoundsSync({ minZoom, maxZoom }: { minZoom: number; maxZoom: number }) {
    const map = useMap()
    useEffect(() => {
        map.setMinZoom(minZoom)
        map.setMaxZoom(maxZoom)
        const zoom = map.getZoom()
        if (zoom < minZoom) map.setZoom(minZoom)
        if (zoom > maxZoom) map.setZoom(maxZoom)
    }, [map, minZoom, maxZoom])
    return null
}

export function FullscreenMapDialog({
    open,
    onOpenChange,
    platform,
    mapType,
    apiKey,
    minZoom = 0,
    maxZoom = 21,
    initialBounds,
    onConfirm,
    selectedRegionCode,
    selectionMode,
    onSelectionModeChange,
    baseMapType,
    onBaseMapTypeChange,
}: FullscreenMapDialogProps) {
    const [localBounds, setLocalBounds] = useState<Bounds>(initialBounds)
    const [shouldFitBounds, setShouldFitBounds] = useState(false)
    const [isDrawingMode, setIsDrawingMode] = useState(false)
    const [internalBaseMapType, setInternalBaseMapType] = useState<BaseMapType>('street')
    const effectiveBaseMapType = baseMapType ?? internalBaseMapType
    const setEffectiveBaseMapType = onBaseMapTypeChange ?? setInternalBaseMapType

    const useBaseMapLayer = platform === 'osm' || platform === 'cjhy'
    const showBaseMapSwitcher = platform === 'cjhy'
    const previewBaseMapType: BaseMapType = platform === 'osm' ? 'street' : effectiveBaseMapType

    const hasValidBounds = localBounds.north > localBounds.south && localBounds.east > localBounds.west

    const dialogRef = useRef<HTMLDivElement | null>(null)

    useEffect(() => {
        if (open) {
            setLocalBounds(initialBounds)
            setIsDrawingMode(false)
            setTimeout(() => setShouldFitBounds(true), 500)
        } else {
            setShouldFitBounds(false)
        }
    }, [open, initialBounds])

    useEffect(() => {
        if (!open) return
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onOpenChange(false)
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
    }, [open, onOpenChange])

    const handleBoundsFromRegion = useCallback((newBounds: Bounds) => {
        setLocalBounds(newBounds)
    }, [])

    const clearBounds = () => {
        setLocalBounds({ north: 0, south: 0, east: 0, west: 0 })
        setIsDrawingMode(false)
    }

    const toggleDrawingMode = () => { setIsDrawingMode(!isDrawingMode) }

    const handleConfirm = () => {
        onConfirm(localBounds)
        onOpenChange(false)
    }

    const handleCancel = () => onOpenChange(false)

    if (!open) return null

    const onBackdrop = (e: React.MouseEvent) => {
        if (e.target === e.currentTarget) onOpenChange(false)
    }

    return createPortal(
        <div className="rp-overlay" onMouseDown={onBackdrop}>
            <div className="rp-dialog fm-dialog" ref={dialogRef} onMouseDown={e => e.stopPropagation()}>
                <div className="rp-head">
                    <MapIcon size={15} style={{ color: 'var(--text-3)' }} />
                    <h3>选择下载区域</h3>
                    <span className="meta">点击「开始绘制」拖拽矩形 · 或选择行政区</span>
                    <div style={{ flex: 1 }} />
                    <button type="button" className="close-btn" onClick={handleCancel} aria-label="关闭">
                        <X size={14} />
                    </button>
                </div>

                <div className="fm-toolbar">
                    <div className="seg">
                        <button
                            type="button"
                            className={selectionMode === 'draw' ? 'active' : ''}
                            onClick={() => {
                                onSelectionModeChange('draw')
                                setIsDrawingMode(false)
                            }}
                        >
                            <Square size={11} style={{ marginRight: 4, verticalAlign: '-1px' }} />
                            绘制选区
                        </button>
                        <button
                            type="button"
                            className={selectionMode === 'region' ? 'active' : ''}
                            onClick={() => {
                                onSelectionModeChange('region')
                                setIsDrawingMode(false)
                            }}
                        >
                            <MapPin size={11} style={{ marginRight: 4, verticalAlign: '-1px' }} />
                            行政区域
                        </button>
                    </div>

                    {selectionMode === 'draw' && (
                        <button
                            type="button"
                            className={isDrawingMode ? 'btn primary sm' : 'btn sm'}
                            onClick={toggleDrawingMode}
                        >
                            {isDrawingMode ? <Hand size={12} /> : <Pencil size={12} />}
                            {isDrawingMode ? '完成绘制' : '开始绘制'}
                        </button>
                    )}

                    {selectionMode === 'draw' && hasValidBounds && (
                        <button
                            type="button"
                            className="btn ghost sm"
                            style={{ color: 'var(--st-red)' }}
                            onClick={clearBounds}
                        >
                            <Trash2 size={12} />
                            清除选区
                        </button>
                    )}

                    <div style={{ flex: 1 }} />

                    {showBaseMapSwitcher && (
                        <BaseMapSwitcher
                            value={effectiveBaseMapType}
                            onChange={setEffectiveBaseMapType}
                            size="md"
                            showTiandituOptions={false}
                        />
                    )}
                </div>

                <div className="fm-map-wrap">
                    <MapContainer
                        center={[33.78, 119.8]}
                        zoom={8}
                        minZoom={minZoom}
                        maxZoom={maxZoom}
                        className="w-full h-full"
                        style={{ height: '100%', width: '100%' }}
                        attributionControl={false}
                    >
                        {useBaseMapLayer ? (
                            <>
                                <BaseMapLayer baseMapType={previewBaseMapType} />
                                {platform === 'cjhy' && (
                                    <TilePreviewLayer
                                        platform={platform}
                                        mapType={mapType}
                                        apiKey={apiKey}
                                        minZoom={minZoom}
                                        maxZoom={maxZoom}
                                        zIndex={10}
                                    />
                                )}
                            </>
                        ) : (
                            <>
                                <TilePreviewLayer
                                    platform={platform}
                                    mapType={mapType}
                                    apiKey={apiKey}
                                    minZoom={minZoom}
                                    maxZoom={maxZoom}
                                    zIndex={1}
                                />
                                {platform === 'tianditu' &&
                                    (mapType === 'street' ||
                                        mapType === 'satellite' ||
                                        mapType === 'terrain') && (
                                        <TilePreviewLayer
                                            platform="tianditu"
                                            mapType="annotation"
                                            apiKey={apiKey}
                                            minZoom={minZoom}
                                            maxZoom={maxZoom}
                                            zIndex={10}
                                        />
                                    )}
                            </>
                        )}

                        <ResizeHandler />
                        <ZoomBoundsSync minZoom={minZoom} maxZoom={maxZoom} />
                        <MapSearchWrapper />

                        {hasValidBounds && (
                            <BoundsFitter bounds={localBounds} shouldFit={shouldFitBounds} />
                        )}

                        {selectionMode === 'draw' && (
                            <DrawPolygon
                                bounds={localBounds}
                                onBoundsChange={setLocalBounds}
                                editable={true}
                                drawEnabled={isDrawingMode}
                            />
                        )}

                        {selectionMode === 'region' && selectedRegionCode && (
                            <RegionBoundary
                                regionCode={selectedRegionCode}
                                onBoundsExtracted={handleBoundsFromRegion}
                                fitBounds={true}
                            />
                        )}
                    </MapContainer>

                    {selectionMode === 'draw' && isDrawingMode && (
                        <div className="fm-hint">
                            拖拽绘制选区 · 点击「完成绘制」退出绘制模式
                        </div>
                    )}
                </div>

                <div className="rp-foot fm-foot">
                    <div className="fm-coords">
                        {hasValidBounds ? (
                            <>
                                <span><b className="mono">N</b> {localBounds.north.toFixed(4)}°</span>
                                <span><b className="mono">S</b> {localBounds.south.toFixed(4)}°</span>
                                <span><b className="mono">E</b> {localBounds.east.toFixed(4)}°</span>
                                <span><b className="mono">W</b> {localBounds.west.toFixed(4)}°</span>
                            </>
                        ) : (
                            <span className="summary">
                                {selectionMode === 'draw'
                                    ? '点击「开始绘制」按钮，然后在地图上拖拽绘制选区'
                                    : '请在上方选择行政区域'}
                            </span>
                        )}
                    </div>
                    <div style={{ flex: 1 }} />
                    <button type="button" className="btn ghost" onClick={handleCancel}>
                        <X size={12} />取消
                    </button>
                    <button
                        type="button"
                        className="btn primary"
                        onClick={handleConfirm}
                        disabled={!hasValidBounds}
                    >
                        <Check size={12} />确认选区
                    </button>
                </div>
            </div>
        </div>,
        document.body
    )
}

export default FullscreenMapDialog
