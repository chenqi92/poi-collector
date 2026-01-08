import { useEffect, useRef, useState, useCallback } from 'react';
import { useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';

export interface PolygonCoords {
    points: [number, number][]; // [lat, lng][]
}

interface DragDrawPolygonProps {
    polygon: PolygonCoords;
    onPolygonChange: (polygon: PolygonCoords) => void;
    editable?: boolean;
    drawEnabled?: boolean;
}

export function DragDrawPolygon({
    polygon,
    onPolygonChange,
    editable = true,
    drawEnabled = true,
}: DragDrawPolygonProps) {
    const map = useMap();
    const polygonRef = useRef<L.Polygon | null>(null);
    const polylineRef = useRef<L.Polyline | null>(null);
    const markersRef = useRef<L.Marker[]>([]);
    const [isDrawing, setIsDrawing] = useState(false);
    const [tempPoints, setTempPoints] = useState<[number, number][]>([]);

    // 检查是否有有效多边形
    const hasValidPolygon = polygon.points.length >= 3;

    // 创建顶点标记图标
    const createVertexIcon = useCallback((isFirst: boolean = false) => {
        return L.divIcon({
            className: 'polygon-vertex-marker',
            html: `<div class="polygon-vertex-dot ${isFirst ? 'polygon-vertex-first' : ''}"></div>`,
            iconSize: [14, 14],
            iconAnchor: [7, 7],
        });
    }, []);

    // 更新多边形显示
    const updatePolygon = useCallback(() => {
        // 清除旧的多边形
        if (polygonRef.current) {
            map.removeLayer(polygonRef.current);
            polygonRef.current = null;
        }

        // 清除旧的顶点标记
        markersRef.current.forEach(m => map.removeLayer(m));
        markersRef.current = [];

        if (!hasValidPolygon) return;

        // 创建多边形
        polygonRef.current = L.polygon(polygon.points, {
            color: '#3b82f6',
            weight: 2,
            fillOpacity: 0.15,
        });
        polygonRef.current.addTo(map);

        // 如果可编辑，添加顶点标记
        if (editable) {
            polygon.points.forEach((point, index) => {
                const marker = L.marker(point, {
                    icon: createVertexIcon(index === 0),
                    draggable: true,
                    zIndexOffset: 1000,
                });

                marker.on('drag', () => {
                    const newLatLng = marker.getLatLng();
                    const newPoints = [...polygon.points];
                    newPoints[index] = [newLatLng.lat, newLatLng.lng];
                    onPolygonChange({ points: newPoints });
                });

                marker.on('click', (e) => {
                    L.DomEvent.stopPropagation(e.originalEvent);
                    // 右键或Shift+点击删除顶点
                    if (e.originalEvent.shiftKey && polygon.points.length > 3) {
                        const newPoints = polygon.points.filter((_, i) => i !== index);
                        onPolygonChange({ points: newPoints });
                    }
                });

                marker.addTo(map);
                markersRef.current.push(marker);
            });
        }
    }, [map, polygon, hasValidPolygon, editable, createVertexIcon, onPolygonChange]);

    // 更新临时绘制线
    const updateTempLine = useCallback(() => {
        if (polylineRef.current) {
            map.removeLayer(polylineRef.current);
            polylineRef.current = null;
        }

        if (tempPoints.length > 0) {
            polylineRef.current = L.polyline(tempPoints, {
                color: '#3b82f6',
                weight: 2,
                dashArray: '5, 5',
            });
            polylineRef.current.addTo(map);
        }
    }, [map, tempPoints]);

    // 地图事件监听
    useMapEvents({
        click(e) {
            if (!drawEnabled || !editable) return;

            if (isDrawing) {
                // 添加新顶点
                const newPoint: [number, number] = [e.latlng.lat, e.latlng.lng];

                // 检查是否点击了第一个点（闭合多边形）
                if (tempPoints.length >= 3) {
                    const firstPoint = tempPoints[0];
                    const distance = map.distance(e.latlng, L.latLng(firstPoint[0], firstPoint[1]));
                    if (distance < 20 * Math.pow(2, 18 - map.getZoom())) {
                        // 闭合多边形
                        onPolygonChange({ points: [...tempPoints] });
                        setTempPoints([]);
                        setIsDrawing(false);
                        return;
                    }
                }

                setTempPoints([...tempPoints, newPoint]);
            } else if (!hasValidPolygon) {
                // 开始新绘制
                setIsDrawing(true);
                setTempPoints([[e.latlng.lat, e.latlng.lng]]);
            }
        },

        dblclick(e) {
            if (!drawEnabled || !editable) return;

            if (isDrawing && tempPoints.length >= 3) {
                // 双击完成多边形
                L.DomEvent.preventDefault(e.originalEvent);
                onPolygonChange({ points: [...tempPoints] });
                setTempPoints([]);
                setIsDrawing(false);
            }
        },

        contextmenu(e) {
            if (isDrawing) {
                // 右键取消绘制
                L.DomEvent.preventDefault(e.originalEvent);
                setTempPoints([]);
                setIsDrawing(false);
            }
        },
    });

    // 更新多边形效果
    useEffect(() => {
        updatePolygon();
    }, [updatePolygon]);

    // 更新临时线效果
    useEffect(() => {
        updateTempLine();
    }, [updateTempLine]);

    // 清理
    useEffect(() => {
        return () => {
            if (polygonRef.current) {
                map.removeLayer(polygonRef.current);
            }
            if (polylineRef.current) {
                map.removeLayer(polylineRef.current);
            }
            markersRef.current.forEach(m => map.removeLayer(m));
        };
    }, [map]);

    // 设置地图光标样式
    useEffect(() => {
        const container = map.getContainer();
        if (drawEnabled && editable) {
            if (isDrawing) {
                container.style.cursor = 'crosshair';
            } else if (!hasValidPolygon) {
                container.style.cursor = 'crosshair';
            } else {
                container.style.cursor = '';
            }
        } else {
            container.style.cursor = '';
        }

        return () => {
            container.style.cursor = '';
        };
    }, [map, drawEnabled, editable, isDrawing, hasValidPolygon]);

    return null;
}

export default DragDrawPolygon;
