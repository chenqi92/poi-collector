import { useState, useEffect, useCallback } from 'react';
import { MapContainer, TileLayer, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import { DragDrawRectangle, Bounds } from './DragDrawRectangle';
import { MapSearchBox } from './MapSearchBox';
import { TilePreviewLayer } from './TilePreviewLayer';
import { RegionBoundary } from './RegionBoundary';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Map, Square, MapPin, Loader2, Trash2, Check, X, Pencil, Hand } from 'lucide-react';

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

interface FullscreenMapDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    platform: string;
    mapType: string;
    apiKey?: string;
    initialBounds: Bounds;
    onConfirm: (bounds: Bounds) => void;
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

        // 延迟初始化
        setTimeout(() => map.invalidateSize(), 300);

        return () => {
            window.removeEventListener('resize', handleResize);
            resizeObserver.disconnect();
        };
    }, [map]);

    return null;
}

// 地图视图同步组件
function BoundsFitter({ bounds, shouldFit }: { bounds: Bounds; shouldFit: boolean }) {
    const map = useMap();

    useEffect(() => {
        if (!shouldFit) return;
        if (bounds.north > bounds.south && bounds.east > bounds.west) {
            const latLngBounds = L.latLngBounds(
                [bounds.south, bounds.west],
                [bounds.north, bounds.east]
            );
            map.fitBounds(latLngBounds, { padding: [50, 50] });
        }
    }, [map, bounds, shouldFit]);

    return null;
}

// 地图内搜索框包装组件 - 放在右上角避免与缩放按钮重叠
function MapSearchWrapper() {
    return (
        <div className="absolute top-3 right-3 z-[1000] w-72">
            <MapSearchBox placeholder="搜索地点定位..." />
        </div>
    );
}

export function FullscreenMapDialog({
    open,
    onOpenChange,
    platform,
    mapType,
    apiKey,
    initialBounds,
    onConfirm,
    selectedRegionCode,
    selectionMode,
    onSelectionModeChange,
}: FullscreenMapDialogProps) {
    const [localBounds, setLocalBounds] = useState<Bounds>(initialBounds);
    const [usePreview, setUsePreview] = useState(false);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [shouldFitBounds, setShouldFitBounds] = useState(false);
    const [isDrawingMode, setIsDrawingMode] = useState(false);

    // 检查是否有有效边界
    const hasValidBounds = localBounds.north > localBounds.south && localBounds.east > localBounds.west;

    // 当对话框打开时，同步初始边界
    useEffect(() => {
        if (open) {
            setLocalBounds(initialBounds);
            setIsDrawingMode(false);
            // 延迟fit bounds，等待地图初始化
            setTimeout(() => setShouldFitBounds(true), 500);
        } else {
            setShouldFitBounds(false);
        }
    }, [open, initialBounds]);

    // 处理从行政区边界提取的边界
    const handleBoundsFromRegion = useCallback((newBounds: Bounds) => {
        setLocalBounds(newBounds);
    }, []);

    // 清除选区
    const clearBounds = () => {
        setLocalBounds({ north: 0, south: 0, east: 0, west: 0 });
        setIsDrawingMode(false);
    };

    // 切换绘制模式
    const toggleDrawingMode = () => {
        setIsDrawingMode(!isDrawingMode);
    };

    // 确认选区
    const handleConfirm = () => {
        onConfirm(localBounds);
        onOpenChange(false);
    };

    // 取消
    const handleCancel = () => {
        onOpenChange(false);
    };

    // 切换到预览模式
    const togglePreview = () => {
        if (!usePreview) {
            setPreviewLoading(true);
            setTimeout(() => setPreviewLoading(false), 1000);
        }
        setUsePreview(!usePreview);
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-[95vw] w-[1400px] max-h-[95vh] h-[900px] flex flex-col p-0 z-[100]">
                <DialogHeader className="px-6 py-4 border-b shrink-0">
                    <DialogTitle className="flex items-center gap-2">
                        <Map className="w-5 h-5" />
                        选择下载区域
                    </DialogTitle>
                </DialogHeader>

                {/* 工具栏 */}
                <div className="flex items-center justify-between gap-2 px-4 py-2 border-b bg-muted/30 shrink-0">
                    <div className="flex items-center gap-2">
                        <Tabs
                            value={selectionMode}
                            onValueChange={(v) => {
                                onSelectionModeChange(v as 'draw' | 'region');
                                setIsDrawingMode(false);
                            }}
                        >
                            <TabsList className="h-9">
                                <TabsTrigger value="draw" className="gap-1.5 text-sm px-3 h-8">
                                    <Square className="h-4 w-4" />
                                    绘制选区
                                </TabsTrigger>
                                <TabsTrigger value="region" className="gap-1.5 text-sm px-3 h-8">
                                    <MapPin className="h-4 w-4" />
                                    行政区域
                                </TabsTrigger>
                            </TabsList>
                        </Tabs>

                        {/* 绘制模式切换按钮 */}
                        {selectionMode === 'draw' && (
                            <Button
                                variant={isDrawingMode ? 'default' : 'outline'}
                                size="sm"
                                className="h-8"
                                onClick={toggleDrawingMode}
                            >
                                {isDrawingMode ? (
                                    <>
                                        <Hand className="h-4 w-4 mr-1" />
                                        完成绘制
                                    </>
                                ) : (
                                    <>
                                        <Pencil className="h-4 w-4 mr-1" />
                                        开始绘制
                                    </>
                                )}
                            </Button>
                        )}

                        {/* 清除按钮 */}
                        {selectionMode === 'draw' && hasValidBounds && (
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-8 text-destructive hover:text-destructive"
                                onClick={clearBounds}
                            >
                                <Trash2 className="h-4 w-4 mr-1" />
                                清除选区
                            </Button>
                        )}
                    </div>

                    <Button
                        variant={usePreview ? 'default' : 'outline'}
                        size="sm"
                        className="h-8"
                        onClick={togglePreview}
                        disabled={previewLoading}
                    >
                        {previewLoading ? (
                            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                        ) : (
                            <Map className="h-4 w-4 mr-1" />
                        )}
                        {usePreview ? '平台瓦片' : 'OSM 底图'}
                    </Button>
                </div>

                {/* 地图容器 */}
                <div className="flex-1 relative min-h-0">
                    <MapContainer
                        center={[33.78, 119.8]}
                        zoom={8}
                        className="w-full h-full"
                        style={{ height: '100%', width: '100%' }}
                        attributionControl={false}
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

                        {/* 自动定位到已有边界 */}
                        {hasValidBounds && (
                            <BoundsFitter bounds={localBounds} shouldFit={shouldFitBounds} />
                        )}

                        {/* 根据模式显示不同的交互组件 */}
                        {selectionMode === 'draw' && (
                            <DragDrawRectangle
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

                    {/* 绘制模式提示 */}
                    {selectionMode === 'draw' && isDrawingMode && (
                        <div className="absolute bottom-4 left-4 z-[1000] px-4 py-2 bg-primary text-primary-foreground text-sm rounded-lg shadow-lg">
                            拖拽绘制选区 · 点击「完成绘制」退出绘制模式
                        </div>
                    )}
                </div>

                {/* 边界坐标显示 + 确认按钮 */}
                <DialogFooter className="px-4 py-3 border-t bg-muted/30 shrink-0 flex-row justify-between items-center">
                    <div className="text-sm text-muted-foreground">
                        {hasValidBounds ? (
                            <div className="flex gap-4">
                                <span>北: <strong>{localBounds.north.toFixed(4)}°</strong></span>
                                <span>南: <strong>{localBounds.south.toFixed(4)}°</strong></span>
                                <span>东: <strong>{localBounds.east.toFixed(4)}°</strong></span>
                                <span>西: <strong>{localBounds.west.toFixed(4)}°</strong></span>
                            </div>
                        ) : (
                            <span>
                                {selectionMode === 'draw'
                                    ? '点击「开始绘制」按钮，然后在地图上拖拽绘制选区'
                                    : '请在上方选择行政区域'}
                            </span>
                        )}
                    </div>
                    <div className="flex gap-2">
                        <Button variant="outline" onClick={handleCancel}>
                            <X className="h-4 w-4 mr-1" />
                            取消
                        </Button>
                        <Button
                            onClick={handleConfirm}
                            disabled={!hasValidBounds}
                            className="gradient-primary text-white border-0"
                        >
                            <Check className="h-4 w-4 mr-1" />
                            确认选区
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export default FullscreenMapDialog;
