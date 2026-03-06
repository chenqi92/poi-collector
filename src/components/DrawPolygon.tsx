import { useEffect, useRef, useCallback, useState } from 'react';
import { useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';

export interface Bounds {
    north: number;
    south: number;
    east: number;
    west: number;
}

interface DrawPolygonProps {
    bounds: Bounds;
    onBoundsChange: (bounds: Bounds) => void;
    editable?: boolean;
    drawEnabled?: boolean;
}

/**
 * 多边形绘制组件
 * - drawEnabled 时单击添加顶点，双击闭合多边形
 * - 闭合后自动计算外接矩形 bounds
 * - 支持拖拽移动整个多边形
 * - 支持拖拽顶点调整形状
 */
export function DrawPolygon({
    bounds,
    onBoundsChange,
    editable = true,
    drawEnabled = false,
}: DrawPolygonProps) {
    const map = useMap();

    // 已确定的顶点
    const [vertices, setVertices] = useState<L.LatLng[]>([]);
    // 是否处于绘制中（正在添加顶点）
    const [isDrawing, setIsDrawing] = useState(false);
    // 鼠标跟随的临时点（用于预览线段）
    const [mouseLatLng, setMouseLatLng] = useState<L.LatLng | null>(null);
    // 拖拽状态
    const [isDragging, setIsDragging] = useState(false);
    const dragStartRef = useRef<{ latLng: L.LatLng; originalVertices: L.LatLng[] } | null>(null);

    // Leaflet 图层引用
    const polygonRef = useRef<L.Polygon | null>(null);
    const polylineRef = useRef<L.Polyline | null>(null);
    const markersRef = useRef<L.Marker[]>([]);
    const previewLineRef = useRef<L.Polyline | null>(null);

    // 从顶点数组计算 bounds
    const computeBounds = useCallback((pts: L.LatLng[]): Bounds => {
        if (pts.length === 0) return { north: 0, south: 0, east: 0, west: 0 };
        let n = -90, s = 90, e = -180, w = 180;
        for (const p of pts) {
            if (p.lat > n) n = p.lat;
            if (p.lat < s) s = p.lat;
            if (p.lng > e) e = p.lng;
            if (p.lng < w) w = p.lng;
        }
        return { north: n, south: s, east: e, west: w };
    }, []);

    // 判断是否有有效边界（由外部传入）
    const isValidBounds = bounds.north > bounds.south && bounds.east > bounds.west;

    // --- 绘制预览和最终多边形 ---

    const clearLayers = useCallback(() => {
        if (polygonRef.current) { map.removeLayer(polygonRef.current); polygonRef.current = null; }
        if (polylineRef.current) { map.removeLayer(polylineRef.current); polylineRef.current = null; }
        if (previewLineRef.current) { map.removeLayer(previewLineRef.current); previewLineRef.current = null; }
        markersRef.current.forEach(m => map.removeLayer(m));
        markersRef.current = [];
    }, [map]);

    // 创建顶点标记
    const createVertexMarker = useCallback((latlng: L.LatLng, index: number, totalVertices: L.LatLng[]) => {
        const icon = L.divIcon({
            className: 'polygon-vertex-marker',
            html: `<div style="
                width: 10px; height: 10px; 
                background: #3b82f6; border: 2px solid white; 
                border-radius: 50%; cursor: move;
                box-shadow: 0 1px 3px rgba(0,0,0,0.4);
            "></div>`,
            iconSize: [10, 10],
            iconAnchor: [5, 5],
        });

        const marker = L.marker(latlng, {
            icon,
            draggable: editable && !isDrawing,
            zIndexOffset: 1000,
        });

        if (editable && !isDrawing) {
            marker.on('drag', () => {
                const newVertices = [...totalVertices];
                newVertices[index] = marker.getLatLng();
                setVertices(newVertices);
                onBoundsChange(computeBounds(newVertices));
            });
        }

        return marker;
    }, [editable, isDrawing, onBoundsChange, computeBounds]);

    // 渲染图层
    const renderLayers = useCallback(() => {
        // 清除旧图层
        if (polygonRef.current) { map.removeLayer(polygonRef.current); polygonRef.current = null; }
        if (polylineRef.current) { map.removeLayer(polylineRef.current); polylineRef.current = null; }
        if (previewLineRef.current) { map.removeLayer(previewLineRef.current); previewLineRef.current = null; }
        markersRef.current.forEach(m => map.removeLayer(m));
        markersRef.current = [];

        if (vertices.length === 0) return;

        if (isDrawing) {
            // 绘制中：显示虚线折线 + 鼠标跟随的预览线
            if (vertices.length >= 1) {
                polylineRef.current = L.polyline(vertices, {
                    color: '#3b82f6',
                    weight: 2,
                    dashArray: '6, 4',
                    opacity: 0.8,
                }).addTo(map);
            }

            // 从最后一个点到鼠标位置的预览线
            if (mouseLatLng && vertices.length > 0) {
                const previewPoints = [vertices[vertices.length - 1], mouseLatLng];
                // 如果有3+个点，也画一条从鼠标到起点的虚线
                if (vertices.length >= 2) {
                    previewPoints.push(vertices[0]);
                }
                previewLineRef.current = L.polyline(previewPoints, {
                    color: '#3b82f6',
                    weight: 1.5,
                    dashArray: '4, 4',
                    opacity: 0.5,
                }).addTo(map);
            }

            // 顶点标记
            vertices.forEach((v, i) => {
                const icon = L.divIcon({
                    className: 'polygon-vertex-marker',
                    html: `<div style="
                        width: ${i === 0 ? 12 : 8}px; height: ${i === 0 ? 12 : 8}px; 
                        background: ${i === 0 ? '#ef4444' : '#3b82f6'}; 
                        border: 2px solid white; border-radius: 50%;
                        box-shadow: 0 1px 3px rgba(0,0,0,0.4);
                    "></div>`,
                    iconSize: [i === 0 ? 12 : 8, i === 0 ? 12 : 8],
                    iconAnchor: [i === 0 ? 6 : 4, i === 0 ? 6 : 4],
                });
                const m = L.marker(v, { icon, interactive: false }).addTo(map);
                markersRef.current.push(m);
            });
        } else if (vertices.length >= 3) {
            // 完成绘制：显示填充多边形
            polygonRef.current = L.polygon(vertices, {
                color: '#3b82f6',
                weight: 2,
                fillOpacity: 0.15,
                fillColor: '#3b82f6',
            }).addTo(map);

            // 可编辑的顶点标记
            if (editable) {
                vertices.forEach((v, i) => {
                    const m = createVertexMarker(v, i, vertices);
                    m.addTo(map);
                    markersRef.current.push(m);
                });
            }

            // 边界框虚线矩形
            if (isValidBounds) {
                const rectBounds = L.latLngBounds(
                    [bounds.south, bounds.west],
                    [bounds.north, bounds.east]
                );
                const rect = L.rectangle(rectBounds, {
                    color: '#94a3b8',
                    weight: 1,
                    dashArray: '4, 4',
                    fillOpacity: 0.02,
                    interactive: false,
                });
                rect.addTo(map);
                // 将矩形存在 polygon ref 中一起管理（简化清理）
                // 用 previewLineRef 临时存
                previewLineRef.current = rect as unknown as L.Polyline;
            }
        }
    }, [vertices, isDrawing, mouseLatLng, map, editable, isValidBounds, bounds, createVertexMarker]);

    // 渲染效果
    useEffect(() => {
        renderLayers();
    }, [renderLayers]);

    // --- 地图事件 ---

    useMapEvents({
        click(e) {
            if (!drawEnabled || !editable) return;
            const originalEvent = e.originalEvent as MouseEvent;
            if (originalEvent.button !== 0) return;

            if (isDrawing) {
                // 检查是否点击了起点附近 → 闭合多边形
                if (vertices.length >= 3) {
                    const startPoint = map.latLngToContainerPoint(vertices[0]);
                    const clickPoint = map.latLngToContainerPoint(e.latlng);
                    if (startPoint.distanceTo(clickPoint) < 15) {
                        // 闭合
                        setIsDrawing(false);
                        setMouseLatLng(null);
                        onBoundsChange(computeBounds(vertices));
                        map.dragging.enable();
                        return;
                    }
                }

                // 添加新顶点
                setVertices(prev => [...prev, e.latlng]);
            } else if (vertices.length >= 3) {
                // 已有多边形，检查是否点击内部 → 开始拖拽
                if (polygonRef.current) {
                    // 如果有多边形层，检查点击是否在内部
                    const polyBounds = polygonRef.current.getBounds();
                    if (polyBounds.contains(e.latlng)) {
                        // 这里不做拖拽，因为 click 不适合拖拽
                        // 拖拽在 mousedown 中处理
                    }
                }
            }
        },

        dblclick(e) {
            if (!drawEnabled || !editable) return;

            if (isDrawing && vertices.length >= 3) {
                e.originalEvent.preventDefault();
                e.originalEvent.stopPropagation();
                // 双击闭合多边形
                setIsDrawing(false);
                setMouseLatLng(null);
                onBoundsChange(computeBounds(vertices));
                map.dragging.enable();
            }
        },

        mousemove(e) {
            if (isDrawing) {
                setMouseLatLng(e.latlng);
            } else if (isDragging && dragStartRef.current) {
                const { latLng: startLatLng, originalVertices } = dragStartRef.current;
                const deltaLat = e.latlng.lat - startLatLng.lat;
                const deltaLng = e.latlng.lng - startLatLng.lng;

                const newVertices = originalVertices.map(
                    v => L.latLng(v.lat + deltaLat, v.lng + deltaLng)
                );
                setVertices(newVertices);
                onBoundsChange(computeBounds(newVertices));
            }
        },

        mousedown(e) {
            if (!editable) return;
            const originalEvent = e.originalEvent as MouseEvent;
            if (originalEvent.button !== 0) return;

            // 拖拽整个多边形
            if (!isDrawing && vertices.length >= 3 && polygonRef.current) {
                // 检查是否点击在顶点标记上
                const clickPoint = map.latLngToContainerPoint(e.latlng);
                for (const marker of markersRef.current) {
                    const markerPoint = map.latLngToContainerPoint(marker.getLatLng());
                    if (clickPoint.distanceTo(markerPoint) < 15) {
                        return; // 让 marker drag 处理
                    }
                }

                // 检查是否在多边形内部
                const polyBounds = polygonRef.current.getBounds();
                if (polyBounds.contains(e.latlng)) {
                    // 简易点-多边形检测（用 leaflet 的 contains 近似）
                    setIsDragging(true);
                    dragStartRef.current = {
                        latLng: e.latlng,
                        originalVertices: vertices.map(v => L.latLng(v.lat, v.lng)),
                    };
                    map.dragging.disable();
                    originalEvent.preventDefault();
                }
            }
        },

        mouseup() {
            if (isDragging) {
                setIsDragging(false);
                dragStartRef.current = null;
                map.dragging.enable();
            }
        },
    });

    // --- 外部 bounds 被清零时清空 vertices ---
    useEffect(() => {
        if (!isValidBounds && vertices.length > 0 && !isDrawing) {
            setVertices([]);
            clearLayers();
        }
    }, [isValidBounds]);

    // --- 开始绘制时的初始化 ---
    useEffect(() => {
        if (drawEnabled && !isDrawing) {
            // 进入绘制模式 - 清除旧多边形，重新开始
            clearLayers();
            setIsDrawing(true);
            setVertices([]);
            setMouseLatLng(null);
            map.dragging.disable();
            // 禁用双击缩放以免干扰闭合手势
            map.doubleClickZoom.disable();
        } else if (!drawEnabled && isDrawing) {
            // 离开绘制模式
            if (vertices.length >= 3) {
                setIsDrawing(false);
                setMouseLatLng(null);
                onBoundsChange(computeBounds(vertices));
            } else {
                setIsDrawing(false);
                setMouseLatLng(null);
                setVertices([]);
            }
            map.dragging.enable();
            map.doubleClickZoom.enable();
        }
    }, [drawEnabled]);

    // --- 光标样式 ---
    useEffect(() => {
        const container = map.getContainer();
        if (drawEnabled && editable) {
            container.style.cursor = isDrawing ? 'crosshair' : isDragging ? 'move' : 'crosshair';
        } else {
            container.style.cursor = '';
        }
        return () => { container.style.cursor = ''; };
    }, [map, drawEnabled, editable, isDrawing, isDragging]);

    // --- 清理 ---
    useEffect(() => {
        return () => {
            clearLayers();
            map.dragging.enable();
            map.doubleClickZoom.enable();
        };
    }, [map, clearLayers]);

    return null;
}

export default DrawPolygon;
