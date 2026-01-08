import { useState, useCallback, useEffect, useRef } from 'react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import { invoke } from '@tauri-apps/api/core';
import 'leaflet/dist/leaflet.css';

import { TilePreviewLayer } from './TilePreviewLayer';
import { DragDrawRectangle, Bounds } from './DragDrawRectangle';
import { MapSearchBox } from './MapSearchBox';
import { RegionBoundary } from './RegionBoundary';
import { FullscreenMapDialog } from './FullscreenMapDialog';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Map, Square, MapPin, Loader2, Trash2, Maximize2, Pencil, Hand, Search, X } from 'lucide-react';

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

interface RegionResult {
    code: string;
    name: string;
    level: string;
}

interface TileBoundsMapProps {
    platform: string;
    mapType: string;
    apiKey?: string;
    bounds: Bounds;
    onBoundsChange: (bounds: Bounds) => void;
    selectedRegionCode?: string | null;
    onSelectedRegionCodeChange?: (code: string | null) => void;
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

// 地图内搜索框包装组件 - 放在右上角避免与缩放按钮重叠
function MapSearchWrapper() {
    return (
        <div className="absolute top-2 right-2 z-[1000] w-64">
            <MapSearchBox placeholder="搜索地点定位..." />
        </div>
    );
}

export function TileBoundsMap({
    platform,
    mapType,
    apiKey,
    bounds,
    onBoundsChange,
    selectedRegionCode,
    onSelectedRegionCodeChange,
    selectionMode,
    onSelectionModeChange,
}: TileBoundsMapProps) {
    const [usePreview, setUsePreview] = useState(false);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [showFullscreen, setShowFullscreen] = useState(false);
    const [isDrawingMode, setIsDrawingMode] = useState(false);

    // 行政区域搜索状态
    const [regionSearchQuery, setRegionSearchQuery] = useState('');
    const [regionSearchResults, setRegionSearchResults] = useState<RegionResult[]>([]);
    const [showRegionDropdown, setShowRegionDropdown] = useState(false);
    const [selectedRegionName, setSelectedRegionName] = useState<string | null>(null);
    const regionSearchRef = useRef<HTMLDivElement>(null);

    // 检查是否有有效边界
    const hasValidBounds = bounds.north > bounds.south && bounds.east > bounds.west;

    // 点击外部关闭下拉框
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (regionSearchRef.current && !regionSearchRef.current.contains(e.target as Node)) {
                setShowRegionDropdown(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // 搜索行政区域
    const handleRegionSearch = useCallback(async (query: string) => {
        setRegionSearchQuery(query);
        if (!query.trim() || query.length < 2) {
            setRegionSearchResults([]);
            setShowRegionDropdown(false);
            return;
        }
        try {
            const results = await invoke<RegionResult[]>('search_regions', { query: query.trim() });
            setRegionSearchResults(results);
            setShowRegionDropdown(results.length > 0);
        } catch (e) {
            console.error('搜索行政区失败:', e);
            setRegionSearchResults([]);
        }
    }, []);

    // 选择行政区域
    const handleSelectRegion = (region: RegionResult) => {
        setSelectedRegionName(region.name);
        setRegionSearchQuery('');
        setShowRegionDropdown(false);
        setRegionSearchResults([]);
        onSelectedRegionCodeChange?.(region.code);
    };

    // 清除选中的区域
    const clearSelectedRegion = () => {
        setSelectedRegionName(null);
        onSelectedRegionCodeChange?.(null);
        onBoundsChange({ north: 0, south: 0, east: 0, west: 0 });
    };

    // 处理从行政区边界提取的边界
    const handleBoundsFromRegion = useCallback(
        (newBounds: Bounds) => {
            onBoundsChange(newBounds);
        },
        [onBoundsChange]
    );

    // 清除选区
    const clearBounds = () => {
        onBoundsChange({ north: 0, south: 0, east: 0, west: 0 });
        setIsDrawingMode(false);
    };

    // 切换到预览模式
    const togglePreview = () => {
        if (!usePreview) {
            setPreviewLoading(true);
            setTimeout(() => setPreviewLoading(false), 1000);
        }
        setUsePreview(!usePreview);
    };

    // 切换绘制模式
    const toggleDrawingMode = () => {
        setIsDrawingMode(!isDrawingMode);
    };

    // 处理全屏对话框确认
    const handleFullscreenConfirm = (newBounds: Bounds) => {
        onBoundsChange(newBounds);
        setIsDrawingMode(false);
    };

    // 获取区域级别中文名
    const getLevelName = (level: string) => {
        switch (level) {
            case 'province': return '省';
            case 'city': return '市';
            case 'district': return '区/县';
            default: return level;
        }
    };

    return (
        <>
            <div className="flex flex-col h-full border rounded-lg overflow-hidden">
                {/* 工具栏 */}
                <div className="flex items-center justify-between gap-2 p-2 border-b bg-muted/30">
                    <div className="flex items-center gap-2">
                        <Tabs
                            value={selectionMode}
                            onValueChange={(v) => {
                                onSelectionModeChange(v as 'draw' | 'region');
                                setIsDrawingMode(false);
                            }}
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

                        {/* 绘制模式切换按钮 */}
                        {selectionMode === 'draw' && (
                            <Button
                                variant={isDrawingMode ? 'default' : 'outline'}
                                size="sm"
                                className="h-7 text-xs"
                                onClick={toggleDrawingMode}
                            >
                                {isDrawingMode ? (
                                    <>
                                        <Hand className="h-3 w-3 mr-1" />
                                        完成
                                    </>
                                ) : (
                                    <>
                                        <Pencil className="h-3 w-3 mr-1" />
                                        绘制
                                    </>
                                )}
                            </Button>
                        )}

                        {/* 行政区域搜索 */}
                        {selectionMode === 'region' && (
                            <div ref={regionSearchRef} className="relative">
                                {selectedRegionName ? (
                                    <div className="flex items-center gap-1 h-7 px-2 bg-primary/10 text-primary text-xs rounded-md border border-primary/20">
                                        <MapPin className="h-3 w-3" />
                                        <span className="max-w-32 truncate">{selectedRegionName}</span>
                                        <button
                                            onClick={clearSelectedRegion}
                                            className="ml-1 hover:text-destructive"
                                        >
                                            <X className="h-3 w-3" />
                                        </button>
                                    </div>
                                ) : (
                                    <>
                                        <div className="relative">
                                            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                                            <Input
                                                value={regionSearchQuery}
                                                onChange={(e) => handleRegionSearch(e.target.value)}
                                                onFocus={() => regionSearchResults.length > 0 && setShowRegionDropdown(true)}
                                                placeholder="搜索行政区域..."
                                                className="h-7 w-40 pl-7 text-xs"
                                            />
                                        </div>
                                        {showRegionDropdown && regionSearchResults.length > 0 && (
                                            <div className="absolute top-full left-0 mt-1 w-56 bg-popover border rounded-lg shadow-lg z-50 max-h-48 overflow-y-auto">
                                                {regionSearchResults.map((region) => (
                                                    <button
                                                        key={region.code}
                                                        className="w-full text-left px-3 py-2 text-sm hover:bg-accent flex items-center justify-between"
                                                        onClick={() => handleSelectRegion(region)}
                                                    >
                                                        <span className="truncate">{region.name}</span>
                                                        <span className="text-xs text-muted-foreground shrink-0 ml-2">
                                                            {getLevelName(region.level)}
                                                        </span>
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                        )}

                        {/* 清除按钮 */}
                        {selectionMode === 'draw' && hasValidBounds && (
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs text-destructive hover:text-destructive"
                                onClick={clearBounds}
                            >
                                <Trash2 className="h-3 w-3 mr-1" />
                                清除
                            </Button>
                        )}
                    </div>

                    <div className="flex items-center gap-2">
                        {/* 全屏编辑按钮 */}
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => setShowFullscreen(true)}
                        >
                            <Maximize2 className="h-3 w-3 mr-1" />
                            大图编辑
                        </Button>

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
                </div>

                {/* 地图容器 */}
                <div className="flex-1 relative" style={{ minHeight: '300px' }}>
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

                        {/* 地图内搜索框 */}
                        <MapSearchWrapper />

                        {/* 根据模式显示不同的交互组件 */}
                        {selectionMode === 'draw' && (
                            <DragDrawRectangle
                                bounds={bounds}
                                onBoundsChange={onBoundsChange}
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

                        {/* 当有有效边界但不在绘制模式时，也显示矩形（只读） */}
                        {selectionMode === 'region' && hasValidBounds && (
                            <BoundsFitter bounds={bounds} />
                        )}
                    </MapContainer>

                    {/* 绘制模式提示 */}
                    {selectionMode === 'draw' && isDrawingMode && (
                        <div className="absolute bottom-2 left-2 z-[1000] px-3 py-1.5 bg-primary text-primary-foreground text-xs rounded-lg shadow-lg">
                            拖拽绘制选区 · 点击「完成」退出绘制模式
                        </div>
                    )}
                </div>

                {/* 边界坐标显示 */}
                <div className="p-2 border-t bg-muted/30 text-xs text-muted-foreground">
                    {hasValidBounds ? (
                        <div className="grid grid-cols-4 gap-2">
                            <span>北: {bounds.north.toFixed(4)}°</span>
                            <span>南: {bounds.south.toFixed(4)}°</span>
                            <span>东: {bounds.east.toFixed(4)}°</span>
                            <span>西: {bounds.west.toFixed(4)}°</span>
                        </div>
                    ) : (
                        <div className="text-center">
                            {selectionMode === 'draw'
                                ? '点击「绘制」按钮进入绘制模式，或点击「大图编辑」在大窗口中操作'
                                : '搜索并选择行政区域'}
                        </div>
                    )}
                </div>
            </div>

            {/* 全屏地图对话框 */}
            <FullscreenMapDialog
                open={showFullscreen}
                onOpenChange={setShowFullscreen}
                platform={platform}
                mapType={mapType}
                apiKey={apiKey}
                initialBounds={bounds}
                onConfirm={handleFullscreenConfirm}
                selectedRegionCode={selectedRegionCode}
                selectionMode={selectionMode}
                onSelectionModeChange={onSelectionModeChange}
            />
        </>
    );
}

export type { Bounds };
