import { useEffect, useRef, useCallback, useState } from 'react';
import { useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';

export interface Bounds {
    north: number;
    south: number;
    east: number;
    west: number;
}

interface DragDrawRectangleProps {
    bounds: Bounds;
    onBoundsChange: (bounds: Bounds) => void;
    editable?: boolean;
    drawEnabled?: boolean;
}

type HandlePosition = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

interface HandleInfo {
    position: HandlePosition;
    cursor: string;
    getLatLng: (bounds: L.LatLngBounds) => L.LatLng;
}

// 8 个调整手柄的配置
const HANDLES: HandleInfo[] = [
    { position: 'nw', cursor: 'nwse-resize', getLatLng: (b) => L.latLng(b.getNorth(), b.getWest()) },
    { position: 'n', cursor: 'ns-resize', getLatLng: (b) => L.latLng(b.getNorth(), b.getCenter().lng) },
    { position: 'ne', cursor: 'nesw-resize', getLatLng: (b) => L.latLng(b.getNorth(), b.getEast()) },
    { position: 'e', cursor: 'ew-resize', getLatLng: (b) => L.latLng(b.getCenter().lat, b.getEast()) },
    { position: 'se', cursor: 'nwse-resize', getLatLng: (b) => L.latLng(b.getSouth(), b.getEast()) },
    { position: 's', cursor: 'ns-resize', getLatLng: (b) => L.latLng(b.getSouth(), b.getCenter().lng) },
    { position: 'sw', cursor: 'nesw-resize', getLatLng: (b) => L.latLng(b.getSouth(), b.getWest()) },
    { position: 'w', cursor: 'ew-resize', getLatLng: (b) => L.latLng(b.getCenter().lat, b.getWest()) },
];

export function DragDrawRectangle({
    bounds,
    onBoundsChange,
    editable = true,
    drawEnabled = true,
}: DragDrawRectangleProps) {
    const map = useMap();
    const rectangleRef = useRef<L.Rectangle | null>(null);
    const handlesRef = useRef<L.Marker[]>([]);
    const [isDrawing, setIsDrawing] = useState(false);
    const [isDragging, setIsDragging] = useState(false);
    const [isResizing, setIsResizing] = useState(false);
    const drawStartRef = useRef<L.LatLng | null>(null);
    const dragStartRef = useRef<{ latLng: L.LatLng; bounds: Bounds } | null>(null);
    const resizeHandleRef = useRef<HandlePosition | null>(null);
    const originalBoundsRef = useRef<Bounds | null>(null);

    // 检查边界是否有效
    const isValidBounds = bounds.north > bounds.south && bounds.east > bounds.west;

    // 创建自定义手柄图标
    const createHandleIcon = useCallback((cursor: string) => {
        return L.divIcon({
            className: 'map-drag-handle',
            html: `<div class="map-handle-dot" style="cursor: ${cursor}"></div>`,
            iconSize: [14, 14],
            iconAnchor: [7, 7],
        });
    }, []);

    // 更新矩形显示
    const updateRectangle = useCallback(() => {
        if (!isValidBounds) {
            if (rectangleRef.current) {
                map.removeLayer(rectangleRef.current);
                rectangleRef.current = null;
            }
            handlesRef.current.forEach(h => map.removeLayer(h));
            handlesRef.current = [];
            return;
        }

        const latLngBounds = L.latLngBounds(
            [bounds.south, bounds.west],
            [bounds.north, bounds.east]
        );

        if (rectangleRef.current) {
            rectangleRef.current.setBounds(latLngBounds);
        } else {
            rectangleRef.current = L.rectangle(latLngBounds, {
                color: '#3b82f6',
                weight: 2,
                fillOpacity: 0.15,
                dashArray: isDrawing ? '5, 5' : undefined,
            });
            rectangleRef.current.addTo(map);
        }

        // 更新或创建手柄
        if (editable && !isDrawing) {
            updateHandles(latLngBounds);
        }
    }, [bounds, isValidBounds, map, editable, isDrawing, createHandleIcon]);

    // 更新手柄位置
    const updateHandles = useCallback((latLngBounds: L.LatLngBounds) => {
        // 如果手柄数量不对，重新创建
        if (handlesRef.current.length !== HANDLES.length) {
            handlesRef.current.forEach(h => map.removeLayer(h));
            handlesRef.current = [];

            HANDLES.forEach(({ position, cursor, getLatLng }) => {
                const marker = L.marker(getLatLng(latLngBounds), {
                    icon: createHandleIcon(cursor),
                    draggable: true,
                    zIndexOffset: 1000,
                });

                marker.on('dragstart', () => {
                    setIsResizing(true);
                    resizeHandleRef.current = position;
                    originalBoundsRef.current = { ...bounds };
                    map.dragging.disable();
                });

                marker.on('drag', (e: L.LeafletEvent) => {
                    const target = e.target as L.Marker;
                    const newLatLng = target.getLatLng();
                    handleResize(position, newLatLng);
                });

                marker.on('dragend', () => {
                    setIsResizing(false);
                    resizeHandleRef.current = null;
                    originalBoundsRef.current = null;
                    map.dragging.enable();
                });

                marker.addTo(map);
                handlesRef.current.push(marker);
            });
        } else {
            // 更新现有手柄位置
            HANDLES.forEach(({ getLatLng }, index) => {
                handlesRef.current[index].setLatLng(getLatLng(latLngBounds));
            });
        }
    }, [map, bounds, createHandleIcon]);

    // 处理手柄拖动调整大小
    const handleResize = useCallback((position: HandlePosition, newLatLng: L.LatLng) => {
        if (!originalBoundsRef.current) return;

        const newBounds = { ...originalBoundsRef.current };
        const lat = newLatLng.lat;
        const lng = newLatLng.lng;

        switch (position) {
            case 'nw':
                newBounds.north = Math.max(lat, newBounds.south + 0.001);
                newBounds.west = Math.min(lng, newBounds.east - 0.001);
                break;
            case 'n':
                newBounds.north = Math.max(lat, newBounds.south + 0.001);
                break;
            case 'ne':
                newBounds.north = Math.max(lat, newBounds.south + 0.001);
                newBounds.east = Math.max(lng, newBounds.west + 0.001);
                break;
            case 'e':
                newBounds.east = Math.max(lng, newBounds.west + 0.001);
                break;
            case 'se':
                newBounds.south = Math.min(lat, newBounds.north - 0.001);
                newBounds.east = Math.max(lng, newBounds.west + 0.001);
                break;
            case 's':
                newBounds.south = Math.min(lat, newBounds.north - 0.001);
                break;
            case 'sw':
                newBounds.south = Math.min(lat, newBounds.north - 0.001);
                newBounds.west = Math.min(lng, newBounds.east - 0.001);
                break;
            case 'w':
                newBounds.west = Math.min(lng, newBounds.east - 0.001);
                break;
        }

        onBoundsChange(newBounds);
    }, [onBoundsChange]);

    // 地图事件监听
    useMapEvents({
        mousedown(e) {
            if (!drawEnabled || !editable) return;
            if (isResizing) return;

            // 检查是否点击在矩形内部（用于拖动）
            if (isValidBounds && rectangleRef.current) {
                const rectBounds = rectangleRef.current.getBounds();
                if (rectBounds.contains(e.latlng)) {
                    // 开始拖动整个矩形
                    setIsDragging(true);
                    dragStartRef.current = { latLng: e.latlng, bounds: { ...bounds } };
                    map.dragging.disable();
                    return;
                }
            }

            // 开始绘制新矩形
            setIsDrawing(true);
            drawStartRef.current = e.latlng;
            map.dragging.disable();

            // 清除旧手柄
            handlesRef.current.forEach(h => map.removeLayer(h));
            handlesRef.current = [];
        },

        mousemove(e) {
            if (isDrawing && drawStartRef.current) {
                // 绘制预览
                const start = drawStartRef.current;
                const end = e.latlng;
                onBoundsChange({
                    north: Math.max(start.lat, end.lat),
                    south: Math.min(start.lat, end.lat),
                    east: Math.max(start.lng, end.lng),
                    west: Math.min(start.lng, end.lng),
                });
            } else if (isDragging && dragStartRef.current) {
                // 拖动矩形
                const { latLng: startLatLng, bounds: startBounds } = dragStartRef.current;
                const deltaLat = e.latlng.lat - startLatLng.lat;
                const deltaLng = e.latlng.lng - startLatLng.lng;

                onBoundsChange({
                    north: startBounds.north + deltaLat,
                    south: startBounds.south + deltaLat,
                    east: startBounds.east + deltaLng,
                    west: startBounds.west + deltaLng,
                });
            }
        },

        mouseup() {
            if (isDrawing) {
                setIsDrawing(false);
                drawStartRef.current = null;
                map.dragging.enable();
            }
            if (isDragging) {
                setIsDragging(false);
                dragStartRef.current = null;
                map.dragging.enable();
            }
        },
    });

    // 更新矩形效果
    useEffect(() => {
        updateRectangle();
    }, [updateRectangle]);

    // 清理
    useEffect(() => {
        return () => {
            if (rectangleRef.current) {
                map.removeLayer(rectangleRef.current);
            }
            handlesRef.current.forEach(h => map.removeLayer(h));
        };
    }, [map]);

    // 设置地图光标样式
    useEffect(() => {
        const container = map.getContainer();
        if (drawEnabled && editable) {
            if (isDrawing) {
                container.style.cursor = 'crosshair';
            } else if (isDragging) {
                container.style.cursor = 'move';
            } else if (isValidBounds) {
                container.style.cursor = '';
            } else {
                container.style.cursor = 'crosshair';
            }
        } else {
            container.style.cursor = '';
        }

        return () => {
            container.style.cursor = '';
        };
    }, [map, drawEnabled, editable, isDrawing, isDragging, isValidBounds]);

    return null;
}

export default DragDrawRectangle;
