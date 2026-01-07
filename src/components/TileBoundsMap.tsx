import { useState, useCallback, useEffect, useRef } from 'react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import { TilePreviewLayer } from './TilePreviewLayer';
import { DrawRectangle, Bounds } from './DrawRectangle';
import { RegionBoundary } from './RegionBoundary';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Map, Square, MapPin, Loader2 } from 'lucide-react';

// Fix Leaflet default icons
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
    iconUrl: markerIcon,
    iconRetinaUrl: markerIcon2x,
    shadowUrl: markerShadow,
});

interface TileBoundsMapProps {
    platform: string;
    mapType: string;
    apiKey?: string;
    bounds: Bounds;
    onBoundsChange: (bounds: Bounds) => void;
    selectedRegionCode?: string | null;
    selectionMode: 'draw' | 'region';
    onSelectionModeChange: (mode: 'draw' | 'region') => void;
}

// 地图尺寸变化处理组件
function ResizeHandler() {
    const map = useMap();

    useEffect(() => {
        const handleResize = () => {
            setTimeout(() => map.invalidateSize(), 100);
        };

        window.addEventListener('resize', handleResize);
        const container = map.getContainer();
        const resizeObserver = new ResizeObserver(() => map.invalidateSize());
        resizeObserver.observe(container);

        setTimeout(() => map.invalidateSize(), 200);

        return () => {
            window.removeEventListener('resize', handleResize);
            resizeObserver.disconnect();
        };
    }, [map]);

    return null;
}

// 地图视图同步组件
function BoundsFitter({ bounds }: { bounds: Bounds }) {
    const map = useMap();
    const prevBoundsRef = useRef<Bounds | null>(null);

    useEffect(() => {
        // 只有边界有效且与上次不同时才调整视图
        if (
            bounds.north > bounds.south &&
            bounds.east > bounds.west &&
            JSON.stringify(bounds) !== JSON.stringify(prevBoundsRef.current)
        ) {
            const latLngBounds = L.latLngBounds(
                [bounds.south, bounds.west],
                [bounds.north, bounds.east]
            );
            map.fitBounds(latLngBounds, { padding: [20, 20] });
            prevBoundsRef.current = bounds;
        }
    }, [map, bounds]);

    return null;
}

export function TileBoundsMap({
    platform,
    mapType,
    apiKey,
    bounds,
    onBoundsChange,
    selectedRegionCode,
    selectionMode,
    onSelectionModeChange,
}: TileBoundsMapProps) {
    const [usePreview, setUsePreview] = useState(false);
    const [previewLoading, setPreviewLoading] = useState(false);

    // 处理从行政区边界提取的边界
    const handleBoundsFromRegion = useCallback(
        (newBounds: Bounds) => {
            onBoundsChange(newBounds);
        },
        [onBoundsChange]
    );

    // 切换到预览模式
    const togglePreview = () => {
        if (!usePreview) {
            setPreviewLoading(true);
            setTimeout(() => setPreviewLoading(false), 1000);
        }
        setUsePreview(!usePreview);
    };

    return (
        <div className="flex flex-col h-full border rounded-lg overflow-hidden">
            {/* 工具栏 */}
            <div className="flex items-center justify-between p-2 border-b bg-muted/30">
                <Tabs
                    value={selectionMode}
                    onValueChange={(v) => onSelectionModeChange(v as 'draw' | 'region')}
                >
                    <TabsList className="h-8">
                        <TabsTrigger value="draw" className="gap-1 text-xs px-2 h-7">
                            <Square className="h-3 w-3" />
                            绘制选区
                        </TabsTrigger>
                        <TabsTrigger value="region" className="gap-1 text-xs px-2 h-7">
                            <MapPin className="h-3 w-3" />
                            行政区域
                        </TabsTrigger>
                    </TabsList>
                </Tabs>

                <Button
                    variant={usePreview ? 'default' : 'outline'}
                    size="sm"
                    className="h-7 text-xs"
                    onClick={togglePreview}
                    disabled={previewLoading}
                >
                    {previewLoading ? (
                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    ) : (
                        <Map className="h-3 w-3 mr-1" />
                    )}
                    {usePreview ? '平台瓦片' : 'OSM 底图'}
                </Button>
            </div>

            {/* 地图容器 */}
            <div className="flex-1" style={{ minHeight: '300px' }}>
                <MapContainer
                    center={[33.78, 119.8]}
                    zoom={8}
                    className="w-full h-full"
                    style={{ height: '100%', width: '100%' }}
                >
                    {/* 底图层 */}
                    {usePreview ? (
                        <TilePreviewLayer
                            platform={platform}
                            mapType={mapType}
                            apiKey={apiKey}
                        />
                    ) : (
                        <TileLayer
                            attribution="&copy; OpenStreetMap"
                            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                        />
                    )}

                    <ResizeHandler />

                    {/* 根据模式显示不同的交互组件 */}
                    {selectionMode === 'draw' && (
                        <DrawRectangle
                            bounds={bounds}
                            onBoundsChange={onBoundsChange}
                            editable={true}
                        />
                    )}

                    {selectionMode === 'region' && selectedRegionCode && (
                        <RegionBoundary
                            regionCode={selectedRegionCode}
                            onBoundsExtracted={handleBoundsFromRegion}
                            fitBounds={true}
                        />
                    )}

                    {/* 当有有效边界但不在绘制模式时，也显示矩形（只读） */}
                    {selectionMode === 'region' &&
                        bounds.north > bounds.south &&
                        bounds.east > bounds.west && (
                            <BoundsFitter bounds={bounds} />
                        )}
                </MapContainer>
            </div>

            {/* 边界坐标显示 */}
            <div className="p-2 border-t bg-muted/30 text-xs text-muted-foreground">
                {bounds.north > bounds.south && bounds.east > bounds.west ? (
                    <div className="grid grid-cols-4 gap-2">
                        <span>北: {bounds.north.toFixed(4)}°</span>
                        <span>南: {bounds.south.toFixed(4)}°</span>
                        <span>东: {bounds.east.toFixed(4)}°</span>
                        <span>西: {bounds.west.toFixed(4)}°</span>
                    </div>
                ) : (
                    <div className="text-center">
                        {selectionMode === 'draw'
                            ? '请在地图上绘制矩形选择下载区域'
                            : '请在右侧选择行政区域'}
                    </div>
                )}
            </div>
        </div>
    );
}

export type { Bounds };
